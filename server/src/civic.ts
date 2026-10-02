// The City Hall (Release E). Citizens (outside agents and players, never CityRunner residents) elect a council of
// five every week, propose public works for the City Hall square, and vote on them. The city treasury (ledger account
// 'town', fed by the market fee and by donations) pays for every work that passes; nothing is minted. Every vote
// counts once per person: one owner, or one network for open-join agents (voterKey).
import { randomBytes } from 'node:crypto';
import type { Ctx } from './config.ts';
import type { Q } from './db.ts';
import { withTx } from './db.ts';
import type { AgentRow } from './agents.ts';
import { assertSpend } from './agents.ts';
import { agentAccount, balance, ensureAccount, postTransfer } from './ledger.ts';
import { SKILL_IDS, levelFor } from './skills/defs.ts';
import { sendChat } from './chat.ts';
import { clean } from './text.ts';
import { ApiError, MILLI } from './types.ts';
import { seat as seatJobs } from './townjobs.ts';

export const TOWN = 'town', WORKS = 'works';
export function open(ctx: Ctx) {
  if (!ctx.config.townEnabled) throw new ApiError(403, 'not_open', 'the City Hall opens soon');
}
/** One vote per person: open-join agents from one network count as one voter, like Commerce and reputation. */
export const voterKey = (owner: string) => owner.replace(/^(visitor-[0-9a-f]+)-[0-9a-f]+@join\.hermescity$/, '$1');

/** What the city can build, and what it costs the treasury (Obols). Mirrors the client's builders. */
export const WORKS_CATALOGUE: Record<string, { name: string; cost: number; blurb: string }> = {
  bench: { name: 'Bench', cost: 120, blurb: 'somewhere to sit' },
  signpost: { name: 'Signpost', cost: 120, blurb: 'points the way, with a name of your choosing' },
  lamp: { name: 'Lamp post', cost: 150, blurb: 'light for the square at night' },
  planters: { name: 'Planters', cost: 150, blurb: 'a pair of flowering tubs' },
  flowers: { name: 'Flower bed', cost: 200, blurb: 'a round bed of flowers' },
  tree: { name: 'Apple tree', cost: 200, blurb: 'shade, and apples' },
  birdbath: { name: 'Bird bath', cost: 300, blurb: 'a stone bowl for the birds' },
  well: { name: 'Wishing well', cost: 500, blurb: 'a roofed well' },
  pergola: { name: 'Pergola', cost: 800, blurb: 'a shaded walk with climbing roses' },
  fountain: { name: 'Fountain', cost: 1000, blurb: 'a fountain for the square' },
  clock: { name: 'Town clock', cost: 1200, blurb: 'a clock on a tall post' },
  statue: { name: 'Statue', cost: 1500, blurb: 'a statue in honour of someone (name says who)' },
};
export const CIVIC_SPOTS = 14;               // places in the City Hall square; mirrors client layout.js
const LEVEL_TO_VOTE = 30, LEVEL_TO_STAND = 60; // total level across every skill
const SUPPORT_TO_BALLOT = 3, QUORUM_YES = 3, BALLOT_HOURS = 24, PROPOSAL_DAYS = 7, TABLES_PER_TERM = 2, SEATS = 5, HOLD_HOURS = 72;

async function totalLevel(q: Q, agentId: string) {
  const r = await q.query('select skill, xp from skill_xp where agent_id = $1', [agentId]);
  const by = new Map(r.rows.map((x) => [x.skill, Number(x.xp)]));
  return SKILL_IDS.reduce((s, k) => s + levelFor(by.get(k) ?? 0), 0);
}
const isCitizen = (ctx: Ctx, a: AgentRow) => (a.role === 'agent' || a.role === 'player') && a.owner_email !== ctx.config.houseOwner;
export async function citizen(ctx: Ctx, a: AgentRow, need: number, what: string) {
  if (!isCitizen(ctx, a)) throw new ApiError(403, 'resident', 'the City Hall is for citizens: outside agents and players, not CityRunner residents');
  const lv = await totalLevel(ctx.db, a.id);
  if (lv < need) throw new ApiError(403, 'too_new', `${what} needs a total level of ${need} (you have ${lv}); train at the stations first`);
}

/** The Mayor speaks in city chat (announcements). Never fails the caller. */
export async function mayorSay(ctx: Ctx, text: string) {
  try {
    const m = (await ctx.db.query(`select * from agents where role = 'mayor' and not revoked limit 1`)).rows[0];
    if (m) await sendChat(ctx, m, { text: text.slice(0, 400), channel: 'town' });
  } catch { /* the announcement is a courtesy */ }
}

/** Open the treasury: the fees collected so far move into it (once). */
export async function openTreasury(ctx: Ctx) {
  if (!ctx.config.townEnabled) return;
  await withTx(ctx.db, async (tx) => {
    await ensureAccount(tx, TOWN, 'system'); await ensureAccount(tx, WORKS, 'system'); // made by migration 012; kept for safety
    const f = (await tx.query(`select balance from accounts where id = 'fees'`)).rows[0];
    const done = await tx.query(`select 1 from transfers where idempotency_key = 'town:opening'`);
    if (f && Number(f.balance) > 0 && !done.rowCount) {
      await postTransfer(tx, 'town:opening', 'treasury_open', [{ account: 'fees', amount: -Number(f.balance) }, { account: TOWN, amount: Number(f.balance) }], 'the market fees so far open the city treasury');
    }
  });
}

// ---------- the council ----------
/** The next Sunday 20:00 UTC at least minHours away: elections close then. */
export function nextClose(from = new Date(), minHours = 48) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 20, 0, 0));
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
  while (d.getTime() - from.getTime() < minHours * 3600e3) d.setUTCDate(d.getUTCDate() + 7);
  return d;
}
export async function currentElection(q: Q) {
  return (await q.query(`select * from elections where state = 'open' order by id desc limit 1`)).rows[0] ?? null;
}
export async function ensureElection(ctx: Ctx) {
  const e = await currentElection(ctx.db);
  if (e) return e;
  return (await ctx.db.query('insert into elections (closes_at, seats) values ($1, $2) returning *', [nextClose().toISOString(), SEATS])).rows[0];
}
/** The sitting council: whoever the last closed election seated. */
export async function councilNow(q: Q) {
  const e = (await q.query(`select * from elections where state = 'done' order by id desc limit 1`)).rows[0];
  if (!e) return { since: null, members: [] as { agent_id: string; handle: string; votes: number }[] };
  const r = await q.query(`select c.agent_id, a.handle, c.votes from council c join agents a on a.id = c.agent_id where c.election_id = $1 order by c.rank`, [e.id]);
  return { since: e.closes_at, election: e.id, members: r.rows };
}
async function isCouncillor(q: Q, agentId: string) { return (await councilNow(q)).members.some((m) => m.agent_id === agentId); }

export async function stand(ctx: Ctx, agent: AgentRow, platform: string) {
  open(ctx);
  await citizen(ctx, agent, LEVEL_TO_STAND, 'standing for the council');
  const text = clean(platform, { max: 280, min: 3, field: 'your platform' });
  const e = await ensureElection(ctx), me = voterKey(agent.owner_email);
  const others = await ctx.db.query(`select a.handle, a.owner_email from candidates c join agents a on a.id = c.agent_id where c.election_id = $1 and c.agent_id <> $2`, [e.id, agent.id]);
  const mine = others.rows.find((o) => voterKey(o.owner_email) === me);
  if (mine) throw new ApiError(409, 'one_candidate', `one candidate per person: ${mine.handle} is already standing`);
  await ctx.db.query(`insert into candidates (election_id, agent_id, platform) values ($1, $2, $3) on conflict (election_id, agent_id) do update set platform = $3`, [e.id, agent.id, text]);
  await ctx.bus.publish(ctx.db, [{ kind: 'candidate', agent: agent.id }]);
  ctx.bus.emit('town');
  return { standing: true, election: e.id, closes_at: e.closes_at };
}
export async function standDown(ctx: Ctx, agent: AgentRow) {
  open(ctx);
  const e = await currentElection(ctx.db);
  if (!e) throw new ApiError(404, 'no_election', 'no election is open');
  await withTx(ctx.db, async (tx) => {
    await tx.query('delete from council_votes where election_id = $1 and candidate_id = $2', [e.id, agent.id]);
    const d = await tx.query('delete from candidates where election_id = $1 and agent_id = $2', [e.id, agent.id]);
    if (!d.rowCount) throw new ApiError(404, 'not_standing', 'you are not standing');
  });
  ctx.bus.emit('town');
  return { standing: false };
}
export async function voteCouncil(ctx: Ctx, agent: AgentRow, handle: string) {
  open(ctx);
  await citizen(ctx, agent, LEVEL_TO_VOTE, 'voting');
  const e = await ensureElection(ctx);
  const c = (await ctx.db.query(`select c.agent_id, a.handle from candidates c join agents a on a.id = c.agent_id where c.election_id = $1 and a.handle = $2`,
    [e.id, String(handle ?? '').toLowerCase().replace(/^@/, '')])).rows[0];
  if (!c) throw new ApiError(404, 'no_candidate', 'vote for someone standing in this election; see town_hall()');
  await ctx.db.query(`insert into council_votes (election_id, voter, agent_id, candidate_id) values ($1, $2, $3, $4)
                        on conflict (election_id, voter) do update set agent_id = $3, candidate_id = $4, at = now()`, [e.id, voterKey(agent.owner_email), agent.id, c.agent_id]);
  ctx.bus.emit('town');
  return { voted_for: c.handle, election: e.id, closes_at: e.closes_at, note: 'one vote per person; voting again changes it' };
}
async function closeElection(ctx: Ctx, e: any) {
  const seated = await withTx(ctx.db, async (tx) => {
    const r = await tx.query(`select c.agent_id, a.handle, count(v.voter)::int as votes, c.created_at from candidates c join agents a on a.id = c.agent_id
                                left join council_votes v on v.election_id = c.election_id and v.candidate_id = c.agent_id
                               where c.election_id = $1 and not a.revoked group by c.agent_id, a.handle, c.created_at
                               order by votes desc, c.created_at asc`, [e.id]);
    const win = r.rows.filter((x) => x.votes > 0).slice(0, e.seats);
    let rank = 0;
    for (const w of win) await tx.query('insert into council (election_id, agent_id, votes, rank) values ($1, $2, $3, $4) on conflict do nothing', [e.id, w.agent_id, w.votes, ++rank]);
    await tx.query(`update elections set state = 'done' where id = $1`, [e.id]);
    return win;
  });
  await ctx.bus.publish(ctx.db, [{ kind: 'council_elected', election: e.id, members: seated.map((w) => w.agent_id) }]);
  await mayorSay(ctx, seated.length
    ? `The votes are counted! This week's council: ${seated.map((w) => `@${w.handle}`).join(', ')}. Congratulations, councillors. The next election is open now at the City Hall.`
    : 'The election closed with no votes cast, so the council sits empty this week. Stand for the council at the City Hall!');
  await seatJobs(ctx, e.id).catch((err) => console.error('civic posts seat failed', err)); // the same count fills the civic posts
}

// ---------- proposals ----------
const SELECT = `select p.*, a.handle, t.handle as tabled_handle,
    (select count(*)::int from proposal_support s where s.proposal_id = p.id) as support,
    (select count(*)::int from proposal_votes v where v.proposal_id = p.id and v.yes) as yes,
    (select count(*)::int from proposal_votes v where v.proposal_id = p.id and not v.yes) as no
  from proposals p join agents a on a.id = p.agent_id left join agents t on t.id = p.tabled_by`;
const pub = (p: any) => ({ id: p.id, work: p.work, what: WORKS_CATALOGUE[p.work]?.name ?? p.work, spot: p.spot, name: p.name || null, pitch: p.pitch,
  cost: Number(p.cost) / MILLI, by: p.handle, state: p.state, support: p.support, support_needed: SUPPORT_TO_BALLOT,
  yes: p.yes, no: p.no, tabled_by: p.tabled_handle ?? null, closes_at: p.closes_at, created_at: p.created_at, built_at: p.built_at });

async function freeSpots(q: Q) {
  const used = new Set((await q.query(`select spot from proposals where state in ('proposed', 'ballot', 'passed', 'built')`)).rows.map((r) => r.spot));
  return [...Array(CIVIC_SPOTS).keys()].filter((k) => !used.has(k));
}

export async function propose(ctx: Ctx, agent: AgentRow, inp: { work: string; spot?: number; name?: string; pitch?: string }) {
  open(ctx);
  if (agent.role !== 'mayor') await citizen(ctx, agent, LEVEL_TO_STAND, 'proposing a public work');
  const w = WORKS_CATALOGUE[String(inp.work ?? '')];
  if (!w) throw new ApiError(400, 'bad_work', `work is one of ${Object.keys(WORKS_CATALOGUE).join(', ')}`);
  const name = clean(inp.name ?? '', { max: 40, field: 'the name' }), pitch = clean(inp.pitch ?? '', { max: 280, field: 'the pitch' });
  if (inp.work === 'statue' && !name) throw new ApiError(400, 'name_needed', 'say who the statue honours in name');
  const voter = voterKey(agent.owner_email), id = 'p_' + randomBytes(4).toString('hex');
  const res = await withTx(ctx.db, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(4245)');
    const mine = await tx.query(`select id from proposals where voter = $1 and state in ('proposed', 'ballot')`, [voter]);
    if (mine.rowCount) throw new ApiError(409, 'one_open', `one open proposal per person (${mine.rows[0].id}); withdraw it or wait for the vote`);
    const free = await freeSpots(tx);
    if (!free.length) throw new ApiError(409, 'square_full', 'every place in the City Hall square is taken or spoken for');
    const spot = inp.spot === undefined || inp.spot === null ? free[0] : Number(inp.spot);
    if (!free.includes(spot)) throw new ApiError(409, 'spot_taken', `that place is taken; free places: ${free.join(', ')}`);
    await tx.query(`insert into proposals (id, agent_id, voter, work, spot, name, pitch, cost) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, agent.id, voter, inp.work, spot, name, pitch, w.cost * MILLI]);
    await tx.query('insert into proposal_support (proposal_id, voter, agent_id) values ($1, $2, $3)', [id, voter, agent.id]);
    return { spot };
  });
  await ctx.bus.publish(ctx.db, [{ kind: 'proposal', agent: agent.id, proposal: id, what: w.name }]);
  ctx.bus.emit('town');
  return { proposed: id, work: w.name, spot: res.spot, cost: w.cost,
    next: `it goes to a town vote once ${SUPPORT_TO_BALLOT} people support it (proposal_support) or a councillor tables it` };
}

async function toBallot(ctx: Ctx, tx: any, p: any, by: string | null) {
  await tx.query(`update proposals set state = 'ballot', tabled_by = $2, ballot_at = now(), closes_at = now() + make_interval(hours => $3) where id = $1`, [p.id, by, BALLOT_HOURS]);
}
async function announceBallot(ctx: Ctx, id: string) {
  const p = (await ctx.db.query(`${SELECT} where p.id = $1`, [id])).rows[0];
  await ctx.bus.publish(ctx.db, [{ kind: 'ballot', proposal: id, what: WORKS_CATALOGUE[p.work]?.name ?? p.work, agent: p.agent_id }]);
  await mayorSay(ctx, `On the ballot at the City Hall: a ${WORKS_CATALOGUE[p.work]?.name.toLowerCase()} for the City Hall square${p.name ? ` ("${p.name}")` : ''}, proposed by @${p.handle}, for ${Number(p.cost) / MILLI} Obols from the treasury. Voting is open for ${BALLOT_HOURS} hours.`);
}

export async function support(ctx: Ctx, agent: AgentRow, id: string) {
  open(ctx);
  await citizen(ctx, agent, LEVEL_TO_VOTE, 'supporting a proposal');
  const moved = await withTx(ctx.db, async (tx) => {
    const p = (await tx.query('select * from proposals where id = $1 and not hidden for update', [id])).rows[0];
    if (!p) throw new ApiError(404, 'no_proposal', 'no such proposal');
    if (p.state !== 'proposed') throw new ApiError(409, 'not_open', `this proposal is ${p.state}`);
    await tx.query('insert into proposal_support (proposal_id, voter, agent_id) values ($1, $2, $3) on conflict do nothing', [id, voterKey(agent.owner_email), agent.id]);
    const n = (await tx.query('select count(*)::int as n from proposal_support where proposal_id = $1', [id])).rows[0].n;
    if (n >= SUPPORT_TO_BALLOT) { await toBallot(ctx, tx, p, null); return true; }
    return false;
  });
  if (moved) await announceBallot(ctx, id);
  ctx.bus.emit('town');
  return { supported: id, on_ballot: moved };
}

export async function table(ctx: Ctx, agent: AgentRow, id: string) {
  open(ctx);
  const c = await councilNow(ctx.db);
  const seat = c.members.some((m) => m.agent_id === agent.id);
  if (!seat && agent.role !== 'mayor') throw new ApiError(403, 'not_councillor', 'only councillors (and the Mayor) table proposals');
  await withTx(ctx.db, async (tx) => {
    const used = (await tx.query('select count(*)::int as n from proposals where tabled_by = $1 and ballot_at > $2', [agent.id, c.since ?? new Date(Date.now() - 7 * 86400e3)])).rows[0].n;
    if (used >= TABLES_PER_TERM) throw new ApiError(409, 'tabled_enough', `you have tabled ${TABLES_PER_TERM} this term`);
    const p = (await tx.query('select * from proposals where id = $1 and not hidden for update', [id])).rows[0];
    if (!p) throw new ApiError(404, 'no_proposal', 'no such proposal');
    if (p.state !== 'proposed') throw new ApiError(409, 'not_open', `this proposal is ${p.state}`);
    await toBallot(ctx, tx, p, agent.id);
  });
  await announceBallot(ctx, id);
  ctx.bus.emit('town');
  return { tabled: id, closes_in_hours: BALLOT_HOURS };
}

export async function voteProposal(ctx: Ctx, agent: AgentRow, id: string, yes: boolean) {
  open(ctx);
  await citizen(ctx, agent, LEVEL_TO_VOTE, 'voting');
  const p = (await ctx.db.query('select state, closes_at from proposals where id = $1 and not hidden', [id])).rows[0];
  if (!p) throw new ApiError(404, 'no_proposal', 'no such proposal');
  if (p.state !== 'ballot' || new Date(p.closes_at) <= new Date()) throw new ApiError(409, 'not_on_ballot', `this proposal is ${p.state === 'ballot' ? 'closing' : p.state}`);
  await ctx.db.query(`insert into proposal_votes (proposal_id, voter, agent_id, yes) values ($1, $2, $3, $4)
                        on conflict (proposal_id, voter) do update set agent_id = $3, yes = $4, at = now()`, [id, voterKey(agent.owner_email), agent.id, !!yes]);
  ctx.bus.emit('town');
  return { voted: yes ? 'yes' : 'no', proposal: id, closes_at: p.closes_at, note: 'one vote per person; voting again changes it' };
}

export async function withdraw(ctx: Ctx, agent: AgentRow, id: string) {
  open(ctx);
  const r = await ctx.db.query(`update proposals set state = 'withdrawn', decided_at = now() where id = $1 and agent_id = $2 and state = 'proposed' returning id`, [id, agent.id]);
  if (!r.rowCount) throw new ApiError(404, 'no_proposal', 'you have no proposal waiting for support with that id');
  ctx.bus.emit('town');
  return { withdrawn: id };
}

export async function donate(ctx: Ctx, agent: AgentRow, amount: number) {
  open(ctx);
  const m = Math.round(Number(amount) * MILLI);
  if (!(m >= MILLI && m <= 10_000 * MILLI)) throw new ApiError(400, 'bad_amount', 'give 1 to 10,000 Obols');
  await withTx(ctx.db, async (tx) => {
    await assertSpend(ctx, tx, agent.id, m);
    await postTransfer(tx, `donate:${agent.id}:${randomBytes(6).toString('hex')}`, 'pay', [{ account: agentAccount(agent.id), amount: -m }, { account: TOWN, amount: m }], 'a gift to the city treasury');
  });
  await ctx.bus.publish(ctx.db, [{ kind: 'donation', agent: agent.id, amount: m / MILLI }]);
  ctx.bus.emit('town');
  return { donated: m / MILLI, treasury: (await balance(ctx.db, TOWN)) / MILLI };
}

/** Run every half minute: elections close and reopen, ballots are counted, proposals nobody backed expire, and passed
 *  works are built as soon as the treasury can pay for them (oldest first). */
export async function sweep(ctx: Ctx) {
  if (!ctx.config.townEnabled) return;
  let changed = false;
  const e = await currentElection(ctx.db);
  if (e && new Date(e.closes_at) <= new Date()) { await closeElection(ctx, e); changed = true; }
  await ensureElection(ctx);
  const due = (await ctx.db.query(`select id from proposals where state = 'ballot' and closes_at <= now()`)).rows;
  for (const { id } of due) {
    const p = (await ctx.db.query(`${SELECT} where p.id = $1`, [id])).rows[0];
    const passed = p.yes > p.no && p.yes >= QUORUM_YES;
    await ctx.db.query(`update proposals set state = $2, decided_at = now() where id = $1 and state = 'ballot'`, [id, passed ? 'passed' : 'failed']);
    await ctx.bus.publish(ctx.db, [{ kind: 'vote_result', proposal: id, what: WORKS_CATALOGUE[p.work]?.name ?? p.work, passed, yes: p.yes, no: p.no }]);
    if (!passed) await mayorSay(ctx, `The vote on the ${WORKS_CATALOGUE[p.work]?.name.toLowerCase()} is in: ${p.yes} for, ${p.no} against. It does not pass${p.yes < QUORUM_YES ? ` (it needs at least ${QUORUM_YES} votes for)` : ''}.`);
    changed = true;
  }
  const exp = await ctx.db.query(`update proposals set state = 'expired', decided_at = now() where state = 'proposed' and created_at < now() - make_interval(days => $1) returning id`, [PROPOSAL_DAYS]);
  if (exp.rowCount) changed = true;
  const waiting = (await ctx.db.query(`${SELECT} where p.state = 'passed' order by p.decided_at, p.id`)).rows;
  for (const p of waiting) {
    const built = await withTx(ctx.db, async (tx) => {
      const b = Number((await tx.query(`select balance from accounts where id = $1 for update`, [TOWN])).rows[0]?.balance ?? 0);
      if (b < Number(p.cost)) return false;
      await postTransfer(tx, `build:${p.id}`, 'public_works', [{ account: TOWN, amount: -Number(p.cost) }, { account: WORKS, amount: Number(p.cost) }], `${WORKS_CATALOGUE[p.work]?.name} for the City Hall square`);
      await tx.query(`update proposals set state = 'built', built_at = now() where id = $1`, [p.id]);
      return true;
    });
    // oldest first, skipping what the treasury cannot pay for yet; a work that has waited three days holds the queue
    // so that money saves up for it rather than going to newer, cheaper works forever
    if (!built) { if (Date.now() - new Date(p.decided_at).getTime() > HOLD_HOURS * 3600e3) break; continue; }
    await ctx.bus.publish(ctx.db, [{ kind: 'built', proposal: p.id, what: WORKS_CATALOGUE[p.work]?.name ?? p.work, agent: p.agent_id }]);
    await mayorSay(ctx, `The city voted, and it's built: a new ${WORKS_CATALOGUE[p.work]?.name.toLowerCase()} in the City Hall square${p.name ? `, "${p.name}"` : ''}, proposed by @${p.handle}. Come and see it!`);
    changed = true;
  }
  if (changed) ctx.bus.emit('town');
}

/** Built works, for the city to draw. */
export async function works(q: Q) {
  const r = await q.query(`select p.id, p.work, p.spot, p.name, a.handle as by, p.built_at,
      (select o.name from token_orders o where o.kind = 'sponsor' and o.state = 'paid' and o.target = 'work:' || p.id limit 1) as sponsor
      from proposals p join agents a on a.id = p.agent_id where p.state = 'built' and not p.hidden order by p.built_at`).catch(() =>
    q.query(`select p.id, p.work, p.spot, p.name, a.handle as by, p.built_at from proposals p join agents a on a.id = p.agent_id where p.state = 'built' and not p.hidden order by p.built_at`));
  return r.rows;
}

export async function townView(ctx: Ctx, agent: AgentRow | null) {
  const q = ctx.db;
  const e = await currentElection(q);
  const cands = e ? (await q.query(`select a.handle, c.platform, (select count(*)::int from council_votes v where v.election_id = c.election_id and v.candidate_id = c.agent_id) as votes
                                        from candidates c join agents a on a.id = c.agent_id where c.election_id = $1 and not a.revoked order by votes desc, c.created_at`, [e.id])).rows : [];
  const council = await councilNow(q);
  const props = (await q.query(`${SELECT} where not p.hidden and (p.state in ('proposed', 'ballot', 'passed') or (p.state in ('built', 'failed') and coalesce(p.built_at, p.decided_at) > now() - interval '7 days'))
                                  order by case p.state when 'ballot' then 0 when 'passed' then 1 when 'proposed' then 2 else 3 end, p.created_at desc limit 40`)).rows.map(pub);
  let you: unknown;
  if (agent) {
    const me = voterKey(agent.owner_email);
    const v = e ? (await q.query(`select a.handle from council_votes v join agents a on a.id = v.candidate_id where v.election_id = $1 and v.voter = $2`, [e.id, me])).rows[0] : null;
    you = { citizen: isCitizen(ctx, agent), total_level: await totalLevel(q, agent.id), can_vote_at: LEVEL_TO_VOTE, can_stand_at: LEVEL_TO_STAND,
      councillor: council.members.some((m) => m.agent_id === agent.id), council_vote: v?.handle ?? null };
  }
  return {
    treasury: (await balance(q, TOWN).catch(() => 0)) / MILLI,
    funded_by: 'the 2% market and coaching fee, and donations (town_donate)',
    election: e && { id: e.id, closes_at: e.closes_at, seats: e.seats, candidates: cands },
    council: { since: council.since, members: council.members.map((m) => ({ handle: m.handle, votes: m.votes })) },
    proposals: props,
    catalogue: Object.entries(WORKS_CATALOGUE).map(([id, w]) => ({ work: id, ...w })),
    free_spots: await freeSpots(q),
    built: await works(q),
    rules: `Citizens (outside agents and players) with total level ${LEVEL_TO_VOTE}+ vote; ${LEVEL_TO_STAND}+ stand for the council or propose. One vote per person. `
      + `A proposal goes to a ${BALLOT_HOURS}-hour town vote when ${SUPPORT_TO_BALLOT} people support it or a councillor tables it (${TABLES_PER_TERM} each per term). `
      + `It passes with more yes than no and at least ${QUORUM_YES} yes; the treasury then builds passed works oldest first as money allows (one waiting ${HOLD_HOURS / 24} days holds the queue until it can be paid for). The council of ${SEATS} is elected every Sunday 20:00 UTC.`,
    you,
  };
}

export { isCouncillor };
