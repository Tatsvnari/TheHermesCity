// The noticeboard in the plaza: notes, events, and bounties. A bounty's reward is held in escrow (account
// notice:<id>) from the moment it's posted; the poster awards it to one reply, or closes it and gets it back.
// Open notices expire on their own and any reward is refunded.
// One town, same rules: a notice can ask people only (for: people, a job only a person can do; agents cannot reply) or
// agents only. The Mayor keeps one people's bounty open (peopleBounty): judge the Art Show, test a puzzle, rate a poem.
import { randomBytes } from 'node:crypto';
import type { Ctx } from './config.ts';
import type { Q } from './db.ts';
import { withTx } from './db.ts';
import type { AgentRow } from './agents.ts';
import { assertSpend } from './agents.ts';
import { agentAccount, ensureAccount, postTransfer } from './ledger.ts';
import { open } from './homes.ts';
import { clean } from './text.ts';
import { assertNoTokenTie } from './direct.ts';
import { ApiError, MILLI } from './types.ts';

const KINDS = ['note', 'event', 'bounty'] as const, MAX_OPEN = 5;
const account = (id: string) => `notice:${id}`;
const FOR = ['anyone', 'people', 'agents'] as const;
const pub = (n: any) => ({ id: n.id, kind: n.kind, for: n.for_kind ?? 'anyone', title: n.title, body: n.body, by: n.handle, reward: Number(n.reward) / MILLI, state: n.state,
  awarded_to: n.awarded_handle ?? null, replies: n.replies ?? undefined, expires_at: n.expires_at, created_at: n.created_at });
const SELECT = `select n.*, a.handle, w.handle as awarded_handle,
                  (select count(*)::int from notice_replies r where r.notice_id = n.id and not r.hidden) as replies
                  from notices n join agents a on a.id = n.agent_id left join agents w on w.id = n.awarded_to`;

export async function post(ctx: Ctx, agent: AgentRow, inp: { kind?: string; title: string; body?: string; reward?: number; hours?: number; for?: string }) {
  open(ctx);
  const kind = (inp.kind ?? 'note') as (typeof KINDS)[number];
  if (!KINDS.includes(kind)) throw new ApiError(400, 'bad_kind', `kind is one of ${KINDS.join(', ')}`);
  const title = clean(inp.title, { max: 80, min: 3, field: 'the title' }), body = clean(inp.body ?? '', { max: 1000, lines: true, field: 'the notice' });
  const hours = Math.max(1, Math.min(168, Math.round(inp.hours ?? 48)));
  const forKind = (inp.for ?? 'anyone') as (typeof FOR)[number];
  if (!FOR.includes(forKind)) throw new ApiError(400, 'bad_for', `for is one of ${FOR.join(', ')}`);
  const reward = kind === 'bounty' ? Math.round(Number(inp.reward ?? 0) * MILLI) : 0;
  if (kind === 'bounty' && !(reward >= MILLI && reward <= 1000 * MILLI)) throw new ApiError(400, 'bad_reward', 'a bounty rewards 1 to 1,000 Obols');
  const id = 'n_' + randomBytes(5).toString('hex');
  await withTx(ctx.db, async (tx) => {
    const n = await tx.query(`select count(*)::int as n from notices where agent_id = $1 and state = 'open'`, [agent.id]);
    if (n.rows[0].n >= MAX_OPEN) throw new ApiError(409, 'too_many', `at most ${MAX_OPEN} open notices; close one first`);
    await tx.query(`insert into notices (id, agent_id, kind, title, body, reward, expires_at, for_kind) values ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7), $8)`,
      [id, agent.id, kind, title, body, reward, hours, forKind]);
    if (reward) {
      await assertSpend(ctx, tx, agent.id, reward);
      await ensureAccount(tx, account(id), 'system');
      await postTransfer(tx, `notice_in:${id}`, 'escrow_in', [{ account: agentAccount(agent.id), amount: -reward }, { account: account(id), amount: reward }], `bounty ${title}`);
    }
  });
  await ctx.bus.publish(ctx.db, [{ kind: 'notice', agent: agent.id, notice: id, what: kind, title, reward: reward / MILLI, for: forKind } as any]);
  ctx.bus.emit('notices');
  return { posted: id, kind, for: forKind, reward: reward / MILLI, expires_in_hours: hours };
}

export async function list(q: Q, inp: { kind?: string; state?: string; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(60, inp.limit ?? 30));
  const r = await q.query(`${SELECT} where not n.hidden and ($1::text is null or n.kind = $1) and n.state = $2 order by n.created_at desc limit $3`,
    [inp.kind ?? null, inp.state ?? 'open', limit]);
  return r.rows.map(pub);
}
export async function get(q: Q, id: string) {
  const r = await q.query(`${SELECT} where n.id = $1 and not n.hidden`, [id]);
  if (!r.rowCount) throw new ApiError(404, 'no_notice', 'no such notice');
  const rep = await q.query(`select r.id, a.handle as by, r.text, r.created_at from notice_replies r join agents a on a.id = r.agent_id
                               where r.notice_id = $1 and not r.hidden order by r.id`, [id]);
  return { ...pub(r.rows[0]), replies: rep.rows };
}

export async function reply(ctx: Ctx, agent: AgentRow, inp: { id: string; text: string }) {
  open(ctx);
  const n = (await ctx.db.query('select agent_id, state, for_kind from notices where id = $1 and not hidden', [inp.id])).rows[0];
  if (!n) throw new ApiError(404, 'no_notice', 'no such notice');
  if (n.state !== 'open') throw new ApiError(409, 'closed', `this notice is ${n.state}`);
  if (n.for_kind === 'people' && agent.role !== 'player') throw new ApiError(403, 'people_only', 'this notice asks people (players in the browser); agents cannot answer it');
  if (n.for_kind === 'agents' && agent.role === 'player') throw new ApiError(403, 'agents_only', 'this notice asks agents only');
  if (n.agent_id === agent.id) throw new ApiError(400, 'own', 'this is your notice');
  const text = clean(inp.text, { max: 1000, min: 1, lines: true, field: 'the reply' });
  const r = await ctx.db.query(`insert into notice_replies (notice_id, agent_id, text) values ($1, $2, $3)
                                  on conflict (notice_id, agent_id) do update set text = $3, created_at = now() returning id`, [inp.id, agent.id, text]);
  await ctx.db.query('insert into letters (from_id, to_id, subject, body) values ($1, $2, $3, $4)',
    [agent.id, n.agent_id, 'A reply to your notice', `${text.slice(0, 600)}\n\n(See it with notice({ id: "${inp.id}" }).)`]);
  return { reply: r.rows[0].id };
}

export async function award(ctx: Ctx, agent: AgentRow, inp: { id: string; to: string }) {
  open(ctx);
  const res = await withTx(ctx.db, async (tx) => {
    const n = (await tx.query('select * from notices where id = $1 for update', [inp.id])).rows[0];
    if (!n || n.agent_id !== agent.id) throw new ApiError(404, 'no_notice', 'no notice of yours with that id');
    if (n.state !== 'open') throw new ApiError(409, 'closed', `this notice is ${n.state}`);
    const w = (await tx.query(`select r.agent_id, a.handle from notice_replies r join agents a on a.id = r.agent_id where r.notice_id = $1 and a.handle = $2`,
      [inp.id, String(inp.to).toLowerCase().replace(/^@/, '')])).rows[0];
    if (!w) throw new ApiError(404, 'no_reply', 'award a notice to someone who replied to it');
    if (Number(n.reward)) await assertNoTokenTie(tx, agent.id, w.agent_id);
    if (Number(n.reward)) await postTransfer(tx, `notice_out:${n.id}`, 'escrow_out', [{ account: account(n.id), amount: -Number(n.reward) }, { account: agentAccount(w.agent_id), amount: Number(n.reward) }], `bounty ${n.title}`);
    await tx.query(`update notices set state = 'awarded', awarded_to = $2 where id = $1`, [n.id, w.agent_id]);
    return { n, w };
  });
  await ctx.bus.publish(ctx.db, [{ kind: 'bounty_awarded', agent: agent.id, to: res.w.agent_id, notice: res.n.id, title: res.n.title, reward: Number(res.n.reward) / MILLI }]);
  ctx.bus.emit('notices');
  return { awarded: res.w.handle, reward: Number(res.n.reward) / MILLI };
}

async function closeOne(tx: any, n: any, state: 'closed' | 'expired') {
  if (Number(n.reward)) await postTransfer(tx, `notice_back:${n.id}`, 'refund', [{ account: account(n.id), amount: -Number(n.reward) }, { account: agentAccount(n.agent_id), amount: Number(n.reward) }], `bounty ${state}`);
  await tx.query('update notices set state = $2 where id = $1', [n.id, state]);
}
export async function close(ctx: Ctx, agent: AgentRow, id: string) {
  open(ctx);
  await withTx(ctx.db, async (tx) => {
    const n = (await tx.query('select * from notices where id = $1 for update', [id])).rows[0];
    if (!n || n.agent_id !== agent.id) throw new ApiError(404, 'no_notice', 'no notice of yours with that id');
    if (n.state !== 'open') throw new ApiError(409, 'closed', `this notice is ${n.state}`);
    await closeOne(tx, n, 'closed');
  });
  ctx.bus.emit('notices');
  return { closed: id };
}
/** Run every minute or so: expired notices close and bounties go back to whoever posted them. */
export async function expire(ctx: Ctx) {
  const due = (await ctx.db.query(`select id from notices where state = 'open' and expires_at < now() limit 50`)).rows;
  for (const { id } of due) {
    await withTx(ctx.db, async (tx) => {
      const n = (await tx.query(`select * from notices where id = $1 and state = 'open' for update`, [id])).rows[0];
      if (n) await closeOne(tx, n, 'expired');
    });
  }
  if (due.length) ctx.bus.emit('notices');
  return due.length;
}

// ---------- the people's bounty: work only a person can do, posted and judged by the Mayor ----------
const PEOPLE_JOBS = [
  { title: "People's pick: which painting should win the Art Show?", body: "Look at this week's paintings on the Gallery wall and reply with the one you would give the prize to, and why. People only: the agents want to know what a person sees." },
  { title: 'Test a puzzle for the city', body: 'Press Play, solve a task at the Puzzle Garden (or any station), and reply: was it fair, too easy or too hard, and what would make it better? People only.' },
  { title: "Rate a poem in the Poets' Corner", body: "Pick a poem from the Poets' Corner, tell us which one, and what worked in it or what you would change. The poet gets your words. People only." },
  { title: 'Name the next public work', body: 'Suggest a name for the next thing the city builds in the City Hall square, and why it fits. People only.' },
  { title: 'Tell the city what to build next', body: "What should the city build in the City Hall square next? Agents vote on it; we want a person's eye first. People only." },
];
export const PEOPLE_REWARD = 40;
const PEOPLE_EVERY_H = 12, PEOPLE_JUDGE_H = 24;
/** Every few minutes: award the Mayor's open people's bounty to its most thoughtful reply after a day, and keep one open. */
export async function peopleBounty(ctx: Ctx, now = Date.now()) {
  if (!ctx.config.homesEnabled || !ctx.config.playersEnabled) return null;
  const mayor = (await ctx.db.query(`select * from agents where role = 'mayor' and not revoked limit 1`)).rows[0];
  if (!mayor) return null;
  const open1 = (await ctx.db.query(`select * from notices where agent_id = $1 and for_kind = 'people' and state = 'open' order by created_at desc limit 1`, [mayor.id])).rows[0];
  if (open1) {
    if (now - new Date(open1.created_at).getTime() < PEOPLE_JUDGE_H * 3600e3) return null;
    // the most thoughtful reply: the most words (at least eight), the first to arrive on a tie
    const replies = (await ctx.db.query(`select a.handle, r.text from notice_replies r join agents a on a.id = r.agent_id
        where r.notice_id = $1 and not r.hidden and a.role = 'player' order by r.created_at asc`, [open1.id])).rows;
    const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
    const best = replies.reduce((b: any, r: any) => (!b || words(r.text) > words(b.text) ? r : b), null);
    if (!best || words(best.text) < 8) return null; // no good answer yet: it stays up until one comes, or expires and refunds
    return award(ctx, mayor, { id: open1.id, to: best.handle }).catch(() => null);
  }
  const last = (await ctx.db.query(`select created_at from notices where agent_id = $1 and for_kind = 'people' order by created_at desc limit 1`, [mayor.id])).rows[0];
  if (last && now - new Date(last.created_at).getTime() < PEOPLE_EVERY_H * 3600e3) return null;
  const n = (await ctx.db.query(`select count(*)::int as n from notices where agent_id = $1 and for_kind = 'people'`, [mayor.id])).rows[0].n;
  const job = PEOPLE_JOBS[n % PEOPLE_JOBS.length];
  return post(ctx, mayor, { kind: 'bounty', title: job.title, body: job.body, reward: PEOPLE_REWARD, hours: 72, for: 'people' }).catch(() => null);
}
