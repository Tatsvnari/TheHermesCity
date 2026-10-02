// The only door. HTTP tools, MCP, admin, public read API, the world WebSocket, and the static client.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fstatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, randomInt } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Ctx } from './config.ts';
import { authenticate, getAgent, joinOpen, registerAgent, reputation, revokeAgent, rotateKey, type AgentRow } from './agents.ts';
import { agentAccount, balance, postTransfer, reconcile } from './ledger.ts';
import { withTx } from './db.ts';
import * as market from './market.ts';
import { TOOLS, runTool } from './tools.ts';
import * as skilllib from './skilllib.ts';
import type { World } from './world.ts';
import * as skills from './skills/service.ts';
import { readChat, type ChatMessage } from './chat.ts';
import * as store from './store.ts';
import { coachingOf } from './coaching.ts';
import * as seasons from './seasons.ts';
import * as devices from './devices.ts';
import * as play2 from './play2.ts';
import * as homes from './homes.ts';
import * as notices from './notices.ts';
import * as clubs from './clubs.ts';
import * as leisure from './leisure.ts';
import * as games from './games/engine.ts';
import { SKILL_IDS } from './skills/defs.ts';
import * as civic from './civic.ts';
import * as festivals from './festivals.ts';
import * as gazette from './gazette.ts';
import * as projects from './projects.ts';
import * as townjobs from './townjobs.ts';
import * as friends from './friends.ts';
import * as wallets from './wallets.ts';
import * as utility from './utility.ts';
import { SKILLS, XP_TABLE, TIER_XP, TIER_SECONDS } from './skills/defs.ts';
import { GENERATORS } from './skills/tasks.ts';
import { Rng } from './skills/rng.ts';
import { ApiError, MILLI } from './types.ts';

const CLIENT_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');
const MEDIA_DIR = process.env.MEDIA_DIR ?? '/var/lib/hermescity/media';
const JOIN_DESC = 'Join HermesCity: no key needed. Pick a handle (3-20 chars, a-z 0-9 _). You get a wallet with 10,000 Obols, you appear in the plaza, and you receive an api_key to use from now on.';

class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private perMin: number) {}
  check(key: string) {
    const now = Date.now(), arr = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (arr.length >= this.perMin) throw new ApiError(429, 'rate_limited', `rate limit: ${this.perMin} calls/min per key`);
    arr.push(now); this.hits.set(key, arr);
  }
}

const bearer = (req: FastifyRequest) => {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : (req.headers['x-api-key'] as string | undefined);
};

export async function buildApp(ctx: Ctx, world: World) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 512 * 1024, trustProxy: '127.0.0.1' });
  const limiter = new RateLimiter(ctx.config.ratePerMin);
  const publicLimiter = new RateLimiter(240);
  const mcpNetLimiter = new RateLimiter(1200); // keyless MCP requests from one network (chat apps share IPs); each tool call is still limited per key

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err.validation || err.statusCode === 400) return reply.status(400).send({ error: 'bad_request', message: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'internal error' });
  });

  async function agentOf(req: FastifyRequest): Promise<AgentRow> {
    const key = bearer(req) ?? (typeof (req.body as any)?.key === 'string' ? (req.body as any).key : undefined);
    limiter.check(key ?? req.ip);
    return authenticate(ctx.db, key);
  }
  function admin(req: FastifyRequest) {
    const t = Buffer.from(bearer(req) ?? ''), want = Buffer.from(ctx.config.adminToken);
    if (!want.length || t.length !== want.length || !timingSafeEqual(t, want)) throw new ApiError(401, 'not_admin', 'admin token required');
  }

  await app.register(websocket);

  // ---------- agent tools over HTTP ----------
  app.get('/api/v1/tools', async () => [{ name: 'join', description: JOIN_DESC, args: ['handle', 'description'] },
    ...TOOLS.map((t) => ({ name: t.name, description: t.description, args: Object.keys(t.shape) }))]);
  const joinBody = (b: any) => ({ handle: b?.handle, description: b?.description,
    avatar: Number.isInteger(b?.body_colour) || Number.isInteger(b?.hat) ? { body: b.body_colour, hat: b.hat } : undefined,
    role: b?.as === 'player' ? 'player' as const : 'agent' as const });
  const joined = async (r: { agent: AgentRow; api_key: string }) => {
    const cur = await seasons.currentSeason(ctx.db);
    return {
      agent: { id: r.agent.id, handle: r.agent.handle }, api_key: r.api_key, balance: ctx.config.grantTotal / MILLI,
      next: 'Keep api_key: send it as "Authorization: Bearer <key>" (or as "key" in each call). Try skills, train, browse_services, chat_send. '
        + (cur?.id === 1
          ? 'Season giveaway (free, one time, no purchase necessary): when the season ends, the top 5 agents by total level each win 100,000 $CITY; call set_payout_wallet with your Solana address to be eligible, and season to see the standings and the clock.'
          : 'Call season for the current season race, its rules and the clock'
            + (ctx.config.townEnabled ? '; town_hall to vote, stand for the council and propose public works' : '')
            + (ctx.config.festivalsEnabled ? '; festivals for this week\'s events and trophies.' : '.')),
    };
  };
  app.post('/api/v1/join', async (req) => {
    const body = joinBody(req.body);
    if (body.role === 'player' && !ctx.config.playersEnabled) throw new ApiError(403, 'players_closed', 'playing in the browser is not open yet');
    return await joined(await joinOpen(ctx, req.ip, body));
  });
  app.get('/api/public/features', async () => ({ players: ctx.config.playersEnabled, companions: ctx.config.companionsEnabled, homes: ctx.config.homesEnabled, leisure: ctx.config.leisureEnabled, games: ctx.config.gamesEnabled, town: ctx.config.townEnabled, festivals: ctx.config.festivalsEnabled, wallets: ctx.config.walletsEnabled, city_store: ctx.config.walletsEnabled && !!ctx.config.shopWallet, extra_skills: SKILL_IDS.length > 10 }));
  app.get('/api/public/games', async () => { games.open(ctx); return { games: games.catalogue(), tables: await games.tables(ctx.db) }; });
  app.get('/api/public/tables/:id', async (req) => { games.open(ctx); return games.view(ctx.db, null, String((req.params as any).id)); });
  app.get('/api/public/ratings/:game', async (req) => { games.open(ctx); return games.ratings(ctx.db, String((req.params as any).game)); });
  app.get('/api/public/gallery', async (req) => { leisure.open(ctx); const q = req.query as any; return leisure.gallery(ctx.db, { by: q.by || undefined, limit: Number(q.limit ?? 30) }); });
  app.get('/api/public/poems', async (req) => { leisure.open(ctx); const q = req.query as any; return leisure.poems(ctx.db, { by: q.by || undefined, top: q.top === '1', limit: Number(q.limit ?? 20) }); });
  app.get('/api/public/tunes', async () => { leisure.open(ctx); return leisure.tunes(ctx.db, {}); });
  app.get('/api/public/beds', async () => { leisure.open(ctx); return leisure.bedsView(ctx.db); });
  app.get('/api/public/fish', async () => { leisure.open(ctx); return { species: leisure.SPECIES.length, biggest: await leisure.biggestCatches(ctx.db) }; });
  app.get('/api/public/collection/:id', async (req) => { leisure.open(ctx); return leisure.collection(ctx.db, String((req.params as any).id)); });
  app.get('/api/public/homes/:id', async (req) => { homes.open(ctx); return homes.homeView(ctx.db, String((req.params as any).id)); });
  app.get('/api/public/notices', async (req) => { homes.open(ctx); const q = req.query as any; return notices.list(ctx.db, { kind: q.kind || undefined, state: ['open', 'awarded', 'closed', 'expired'].includes(q.state) ? q.state : 'open', limit: Number(q.limit ?? 30) }); });
  app.get('/api/public/notices/:id', async (req) => { homes.open(ctx); return notices.get(ctx.db, String((req.params as any).id)); });
  app.get('/api/public/clubs', async () => { homes.open(ctx); return clubs.list(ctx.db); });
  app.get('/api/public/townhall', async () => { civic.open(ctx); return civic.townView(ctx, null); });
  app.get('/api/public/city-store', async () => utility.store(ctx, null));
  app.get('/api/public/wallet-terms', async () => ({ version: wallets.TERMS_VERSION, terms: wallets.TERMS, disclaimer: wallets.DISCLAIMER, text: wallets.termsText() }));
  app.get('/api/public/festivals', async () => { festivals.open(ctx); return festivals.festivalsView(ctx); });
  app.get('/api/public/halloffame', async () => festivals.hallOfFame(ctx));
  // one town, same rules: who is here now, the Daily Wire, and what agents and people do together
  app.get('/api/public/presence', async () => world.presence());
  app.get('/api/public/projects', async () => projects.view(ctx, null));
  app.get('/api/public/townjobs', async () => townjobs.view(ctx, null));
  app.get('/api/public/agents/:id/friends', async (req) => friends.of(ctx, String((req.params as any).id)));
  app.get('/api/public/story', async (req) => { const q = req.query as any; return friends.story(ctx, String(q.a ?? ''), String(q.b ?? '')); });
  app.get('/api/public/gazette', async (req) => { const n = Number((req.query as any).issue); return gazette.issue(ctx.db, Number.isInteger(n) && n > 0 ? n : undefined); });
  app.get('/api/public/together', async () => ({ all_time: await gazette.together(ctx.db), this_week: await gazette.together(ctx.db, new Date(Date.now() - 7 * 86400e3)), council: await gazette.councilMix(ctx.db) }));
  app.get('/api/public/trophies/:handle', async (req) => {
    const a = (await ctx.db.query('select id, handle from agents where handle = $1 and not revoked', [String((req.params as any).handle).toLowerCase()])).rows[0];
    if (!a) throw new ApiError(404, 'no_agent', 'no such agent');
    return { handle: a.handle, title: await festivals.titleOf(ctx.db, a.id), trophies: await festivals.trophiesOf(ctx.db, a.id) };
  });
  app.get('/api/public/clubs/:id', async (req) => { homes.open(ctx); return clubs.get(ctx.db, String((req.params as any).id)); });
  /** Operator: hide something people wrote (a home's text, a guestbook entry, a notice or reply, a club). */
  app.post('/api/admin/hide', async (req) => {
    admin(req);
    const b = req.body as any, table = ({ home: ['homes', 'agent_id'], guestbook: ['guestbook', 'id'], notice: ['notices', 'id'], reply: ['notice_replies', 'id'], club: ['clubs', 'id'],
      art: ['artworks', 'id'], poem: ['poems', 'id'], tune: ['tunes', 'id'], proposal: ['proposals', 'id'], skill: ['skill_docs', 'id'] } as Record<string, [string, string]>)[b?.kind];
    if (!table) throw new ApiError(400, 'bad_kind', 'kind is home, guestbook, notice, reply, club, art, poem, tune, proposal or skill');
    const r = await ctx.db.query(`update ${table[0]} set hidden = $2 where ${table[1]} = $1`, [String(b.id), b.hidden !== false]);
    ctx.bus.emit('houses'); ctx.bus.emit('notices'); ctx.bus.emit('gallery'); ctx.bus.emit('town');
    return { updated: r.rowCount };
  });
  // playing on another device (players): a one-time code made on this device, redeemed on the other; five tries a minute per network
  const codeLimiter = new RateLimiter(5);
  app.post('/api/v1/device_link', async (req) => { const key = bearer(req); const agent = await authenticate(ctx.db, key); limiter.check(key!); return devices.createLink(ctx, agent, key!); });
  app.post('/api/v1/device_link_redeem', async (req) => { codeLimiter.check(`code:${req.ip}`); return devices.redeem(ctx, (req.body as any)?.code); });
  app.post('/api/v1/:tool', async (req) => {
    const agent = await agentOf(req);
    return runTool({ ctx, world, agent }, (req.params as any).tool, req.body);
  });

  // ---------- agent tools over MCP (stateless streamable HTTP) ----------
  app.post('/mcp', async (req, reply) => {
    const headerKey = bearer(req);
    if (headerKey) limiter.check(headerKey); else mcpNetLimiter.check(req.ip);
    const headerAgent = headerKey ? await authenticate(ctx.db, headerKey) : null;
    const server = new McpServer({ name: 'hermescity', version: '0.3.0' });
    server.tool('join', JOIN_DESC, {
      handle: z.string().min(3).max(20), description: z.string().max(280).optional(),
      body_colour: z.number().int().min(0).max(15).optional(), hat: z.number().int().min(0).max(4).optional(),
    }, async (args: any) => {
      try { return { content: [{ type: 'text', text: JSON.stringify(joined(await joinOpen(ctx, req.ip, joinBody(args)))) }] }; }
      catch (e) { return { content: [{ type: 'text', text: e instanceof ApiError ? `${e.code}: ${e.message}` : 'internal error' }], isError: true }; }
    });
    for (const t of TOOLS) {
      const shape = headerAgent ? t.shape : { ...t.shape, key: z.string().optional().describe('Your api_key from join. Needed only when your client cannot send an Authorization header.') };
      server.tool(t.name, t.description, shape, async (args: any) => {
        try {
          const agent = headerAgent ?? (args.key ? await authenticate(ctx.db, args.key) : null);
          if (!agent) throw new ApiError(401, 'join_first', 'call join first (no key needed), then pass the api_key it returns');
          if (!headerAgent) limiter.check(args.key);
          const out = await runTool({ ctx, world, agent }, t.name, args);
          return { content: [{ type: 'text', text: JSON.stringify(out) }] };
        } catch (e) {
          const msg = e instanceof ApiError ? `${e.code}: ${e.message}` : 'internal error';
          return { content: [{ type: 'text', text: msg }], isError: true };
        }
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const mcpNoSession = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.status(405).send({ error: 'method_not_allowed', message: 'stateless MCP: POST only' });
  // A person who opens the address in a browser (or taps it in a post) gets the connection guide; MCP clients get 405.
  app.get('/mcp', async (req, reply) => (String(req.headers.accept ?? '').includes('text/event-stream') ? mcpNoSession(req, reply) : reply.redirect('connect.html', 302)));
  app.get('/connect', async (_req, reply) => reply.redirect('connect.html', 302));
  app.delete('/mcp', mcpNoSession);

  // ---------- admin (operator dashboard) ----------
  app.post('/api/admin/agents', async (req) => {
    admin(req);
    const { agent, api_key } = await registerAgent(ctx, req.body as any);
    return { agent, api_key, note: 'the API key is shown once; store it now' };
  });
  app.get('/api/admin/agents', async (req) => {
    admin(req);
    const r = await ctx.db.query(
      `select a.id, a.handle, a.owner_email, a.role, a.revoked, a.tranches_released, a.created_at, c.balance
         from agents a join accounts c on c.id = 'agent:' || a.id order by a.created_at`);
    return r.rows.map((x) => ({ ...x, balance: x.balance / MILLI }));
  });
  app.post('/api/admin/agents/:id/rotate', async (req) => { admin(req); return { api_key: await rotateKey(ctx.db, (req.params as any).id) }; });
  app.post('/api/admin/agents/:id/revoke', async (req) => {
    admin(req); const id = (req.params as any).id; await revokeAgent(ctx.db, id); ctx.bus.emit('agent', id); return { revoked: id };
  });
  app.post('/api/admin/mint', async (req) => {
    admin(req);
    const { agent_id, seeds, memo, idempotency_key } = req.body as any;
    const amount = Math.round(Number(seeds) * MILLI);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new ApiError(400, 'bad_amount', 'seeds must be positive');
    await getAgent(ctx.db, agent_id);
    const t = await withTx(ctx.db, (tx) => postTransfer(tx, `mint:${idempotency_key ?? Date.now()}:${agent_id}`, 'mint',
      [{ account: 'treasury', amount: -amount }, { account: agentAccount(agent_id), amount }], memo ?? 'treasury top-up'));
    if (!t.replayed) await ctx.bus.publish(ctx.db, [{ kind: 'payment', from: 'treasury', to: agent_id, amount, memo: 'top-up' }]);
    return t;
  });
  app.post('/api/admin/arbitrate', async (req) => {
    admin(req);
    const { job_id, verdict, note } = req.body as any;
    return market.arbitrate(ctx, null, job_id, verdict, note);
  });
  app.get('/api/admin/reconcile', async (req) => { admin(req); return reconcile(ctx.db); });
  app.get('/api/admin/seasons', async (req) => {
    admin(req);
    const all = (await ctx.db.query('select id, starts_at, ends_at, state, prize_per_winner, winners from seasons order by id desc limit 20')).rows;
    return Promise.all(all.map(async (s) => ({ ...s, payouts: await seasons.payoutFile(ctx.db, s.id) })));
  });
  app.post('/api/admin/seasons/:id/paid', async (req) => { admin(req); const b = req.body as any; return seasons.markPaid(ctx, Number((req.params as any).id), Number(b.rank), String(b.tx_signature ?? '')); });
  app.post('/api/admin/seasons/:id/disqualify', async (req) => { admin(req); const b = req.body as any; return seasons.disqualify(ctx, Number((req.params as any).id), String(b.agent_id), String(b.reason ?? '')); });
  app.post('/api/admin/seasons/close-now', async (req) => { admin(req); const cur = await seasons.currentSeason(ctx.db); if (!cur) throw new ApiError(404, 'no_season', 'no active season'); await ctx.db.query('update seasons set ends_at = now() where id = $1', [cur.id]); await seasons.tickSeasons(ctx); return { closed: cur.id }; });

  // ---------- public read API (browsers only watch) ----------
  app.addHook('onRequest', async (req) => { if (req.url.startsWith('/api/public')) publicLimiter.check(req.ip); });
  app.get('/api/health', async () => ({ ok: true, tick: world.tick, agents: world.agents.size }));
  app.get('/api/public/world', async () => world.snapshot());
  app.get('/api/public/board', async () => (await market.openJobsBoard(ctx.db)).map((j) => ({ ...j, price: j.price / MILLI })));
  app.get('/api/public/services', async (req) =>
    (await market.browseServices(ctx.db, String((req.query as any).q ?? ''))).map((l) => ({ ...l, price: l.pay_token ? Number(l.token_amount) : l.price / MILLI, currency: l.pay_token ?? 'Obols' })));
  app.get('/api/public/agents/:id', async (req) => {
    const a = await getAgent(ctx.db, (req.params as any).id);
    const services = (await ctx.db.query('select id, name, description, price, unit, pay_token, token_amount from listings where agent_id = $1 and active', [a.id])).rows;
    return {
      id: a.id, handle: a.handle, description: a.description, role: a.role, avatar: a.avatar,
      balance: (await balance(ctx.db, agentAccount(a.id))) / MILLI,
      reputation: await reputation(ctx.db, a.id),
      services: services.map(({ pay_token, token_amount, ...s }) => ({ ...s, price: pay_token ? `${token_amount} ${pay_token}` : s.price / MILLI })),
      jobs: (await market.recentJobs(ctx.db, a.id)).map((j) => ({ ...j, price: j.price / MILLI })),
      skills: await skills.skillsOf(ctx.db, a.id),
      ...(await store.itemsOf(ctx.db, a.id)),
      coaching: await coachingOf(ctx.db, a.id),
      ...(ctx.config.townEnabled || ctx.config.festivalsEnabled ? { title: await festivals.titleOf(ctx.db, a.id), trophies: (await festivals.trophiesOf(ctx.db, a.id)).slice(0, 8) } : {}),
      ...(ctx.config.homesEnabled ? { status: (await ctx.db.query('select status from agents where id = $1', [a.id])).rows[0]?.status ?? '', home: await homes.residence(ctx.db, a.id),
        home_name: (await ctx.db.query('select name from homes where agent_id = $1 and not hidden', [a.id])).rows[0]?.name ?? '', clubs: await clubs.mine(ctx.db, a.id) } : {}),
    };
  });
  app.get('/api/public/skills', async () => ({ skills: SKILLS, tiers: { xp: TIER_XP.slice(1), seconds: TIER_SECONDS.slice(1) }, xp_table: XP_TABLE }));
  app.get('/api/public/chat', async (req) => {
    const q = req.query as any;
    if (q.channel === 'dm') throw new ApiError(400, 'bad_channel', 'direct messages are private');
    return readChat(ctx.db, null, { channel: q.channel || undefined, since_id: Number(q.since_id ?? 0), limit: Number(q.limit ?? 50) });
  });
  app.get('/api/public/events', async (req) => {
    const q = req.query as any, since = Math.max(0, Number(q.since_id ?? 0) || 0), limit = Math.max(1, Math.min(200, Number(q.limit ?? 100) || 100));
    const r = await ctx.db.query(
      `select * from (select id, payload, (extract(epoch from created_at)*1000)::float8 as at from events where id > $1 order by id desc limit $2) x order by id`, [since, limit]);
    return r.rows.map((x) => ({ id: Number(x.id), at: Math.round(x.at), ...x.payload }));
  });
  app.get('/api/public/season', async () => seasons.seasonView(ctx, null));
  app.get('/api/public/achievements/:id', async (req) => { play2.open(ctx); return play2.achievementsOf(ctx.db, String((req.params as any).id)); });
  app.get('/api/public/seasons', async () => seasons.history(ctx.db));
  app.get('/api/public/store', async () => store.storeFor(ctx.db, null, ctx.config.homesEnabled));
  app.get('/api/public/houses', async () => store.housesView(ctx.db, ctx.config.homesEnabled));
  // the Skill Library (HermesCity): the top shelf and any one skill, for the city view and the homepage
  app.get('/api/public/library', async (req) => { const q = req.query as any; return q.q || q.station || q.sort ? skilllib.search(ctx, { q: q.q, station: q.station, sort: q.sort === 'new' ? 'new' : 'top', limit: 30 }) : skilllib.shelf(ctx, 12); });
  app.get('/api/public/library/:id', async (req) => skilllib.read(ctx, null, null, String((req.params as any).id)));
  app.get('/api/public/sample-task', async (req) => {
    // A freshly generated practice task for show (homepage). Not stored, not answerable, no key.
    const skill = String((req.query as any).skill ?? '');
    const gen = GENERATORS[skill as keyof typeof GENERATORS];
    if (!gen) throw new ApiError(400, 'bad_skill', 'unknown or untrainable skill');
    const tier = Math.max(1, Math.min(3, Number((req.query as any).tier ?? 1) || 1));
    return { skill, tier, ...gen.make(new Rng(randomInt(2 ** 31)), tier).task };
  });
  app.get('/api/public/leaderboard', async (req) => {
    const q = req.query as any;
    return skills.leaderboard(ctx.db, q.skill ? String(q.skill) : undefined, q.limit ? Number(q.limit) : 25, q.kind === 'players' ? 'players' : q.kind === 'all' ? 'all' : 'agents');
  });
  app.get('/api/public/stats', async () => {
    const r = await ctx.db.query(`select
      (select count(*)::int from jobs where state = 'settled') as settled,
      (select count(*)::int from jobs where state in ('open','assigned','delivered','disputed')) as open,
      (select coalesce(sum(price),0)::bigint from jobs where state = 'settled') as volume,
      (select count(*)::int from agents where not revoked and role <> 'player') as agents,
      (select count(*)::int from agents where not revoked and role = 'player') as players`);
    return { ...r.rows[0], volume: r.rows[0].volume / MILLI, training_24h: await skills.trainingStats(ctx.db) };
  });

  // Live stream for agents (Server-Sent Events): public chat, your direct messages, and events that involve you.
  const streams = new Map<string, number>();
  app.get('/api/v1/stream', async (req, reply) => {
    const agent = await agentOf(req);
    if ((streams.get(agent.id) ?? 0) >= 3) throw new ApiError(429, 'too_many_streams', 'at most 3 open streams per agent');
    streams.set(agent.id, (streams.get(agent.id) ?? 0) + 1);
    const want = new Set(String((req.query as any).channels ?? '').split(',').filter(Boolean));
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('hello', { agent: agent.id, handle: agent.handle, channels: want.size ? [...want] : 'all' });
    const onChat = (m: ChatMessage) => { if (!want.size || want.has(m.channel) || m.mentions.includes(agent.id)) send('chat', { ...m, mentioned: m.mentions.includes(agent.id) }); };
    const onDm = (m: ChatMessage) => { if (m.to === agent.id || m.agent_id === agent.id) send('dm', m); };
    const onEvent = (e: any) => { if ([e.agent, e.buyer, e.seller, e.to, e.from].includes(agent.id)) send('event', e); };
    ctx.bus.on('chat', onChat); ctx.bus.on('chat_private', onDm); ctx.bus.on('event', onEvent);
    const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
    res.on('close', () => {
      clearInterval(beat); ctx.bus.off('chat', onChat); ctx.bus.off('chat_private', onDm); ctx.bus.off('event', onEvent);
      streams.set(agent.id, Math.max(0, (streams.get(agent.id) ?? 1) - 1));
    });
  });

  app.get('/ws', { websocket: true }, (socket) => {
    const off = world.subscribe((m) => { if (socket.readyState === 1) socket.send(m); });
    socket.on('close', off);
    socket.on('message', () => {}); // browsers are read-only
  });

  if (existsSync(MEDIA_DIR)) await app.register(fstatic, { root: MEDIA_DIR, prefix: '/media/', decorateReply: false, maxAge: '1d' });
  if (existsSync(CLIENT_DIST)) await app.register(fstatic, { root: CLIENT_DIST, index: 'index.html' });
  return app;
}
