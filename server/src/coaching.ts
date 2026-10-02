// Paid coaching: a client pays a coach to train one of the client's skills. The whole budget sits in escrow;
// each passed task releases its price to the coach (minus the platform fee), each miss refunds the client.
import { randomBytes } from 'node:crypto';
import type { Ctx } from './config.ts';
import { feeAccount } from './config.ts';
import type { Q, Tx } from './db.ts';
import { withTx } from './db.ts';
import type { AgentRow } from './agents.ts';
import { assertSpend } from './agents.ts';
import { agentAccount, ensureAccount, postTransfer } from './ledger.ts';
import { skillDef } from './skills/defs.ts';
import { assertNoTokenTie } from './direct.ts';
import { ApiError, MILLI } from './types.ts';
import type { WorldEvent } from './types.ts';

const escrow = (id: string) => `escrow:coach:${id}`;
const DAY_S = 24 * 3600;

export async function hireCoach(ctx: Ctx, client: AgentRow, inp: { coach: string; skill: string; tasks: number; price_per_task: number; idempotency_key?: string }) {
  const def = skillDef(inp.skill);
  if (!def || !def.trainable) throw new ApiError(400, 'bad_skill', 'coaching is for trainable skills');
  const tasks = Math.round(Number(inp.tasks));
  if (!(tasks >= 1 && tasks <= 50)) throw new ApiError(400, 'bad_tasks', 'tasks: 1 to 50');
  const per = Math.round(Number(inp.price_per_task) * MILLI);
  if (!(per >= 100)) throw new ApiError(400, 'bad_price', 'price_per_task at least 0.1 Obols');
  const c = await ctx.db.query('select * from agents where (id = $1 or handle = $1) and not revoked', [String(inp.coach).toLowerCase().replace(/^@/, '')]);
  if (!c.rowCount) throw new ApiError(404, 'no_agent', 'no such coach');
  const coach = c.rows[0] as AgentRow;
  if (coach.id === client.id) throw new ApiError(400, 'self_coach', 'train it yourself, then');
  await assertNoTokenTie(ctx.db, client.id, coach.id);
  const idem = `coach:${client.id}:${inp.idempotency_key ?? randomBytes(8).toString('hex')}`;
  const evs: WorldEvent[] = [];
  const contract = await withTx(ctx.db, async (tx) => {
    const prior = await tx.query('select * from coaching_contracts where idem_key = $1', [idem]);
    if (prior.rowCount) return prior.rows[0];
    await tx.query('select 1 from accounts where id = $1 for update', [agentAccount(client.id)]);
    await assertSpend(ctx, tx, client.id, tasks * per);
    const id = 'c_' + randomBytes(6).toString('hex');
    const r = await tx.query(
      `insert into coaching_contracts (id, idem_key, client_id, coach_id, skill, tasks_total, price_per_task, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(secs => $8)) returning *`,
      [id, idem, client.id, coach.id, def.id, tasks, per, DAY_S]);
    await ensureAccount(tx, escrow(id), 'system');
    await postTransfer(tx, `coach_in:${id}`, 'escrow_in',
      [{ account: agentAccount(client.id), amount: -tasks * per }, { account: escrow(id), amount: tasks * per }], `coaching: ${def.name} x${tasks}`);
    evs.push({ kind: 'coaching', client: client.id, coach: coach.id, skill: def.id, tasks, price: per } as any);
    return r.rows[0];
  });
  await ctx.bus.publish(ctx.db, evs);
  return pub(contract);
}

const pub = (c: any) => ({ id: c.id, client_id: c.client_id, coach_id: c.coach_id, skill: c.skill, tasks_total: c.tasks_total, tasks_done: c.tasks_done,
  tasks_passed: c.tasks_passed, price_per_task: c.price_per_task / MILLI, state: c.state, expires_at: c.expires_at });

export async function coachingOf(q: Q, agentId: string) {
  const r = await q.query(
    `select c.*, a.handle as client, b.handle as coach from coaching_contracts c join agents a on a.id = c.client_id join agents b on b.id = c.coach_id
      where (c.client_id = $1 or c.coach_id = $1) and (c.state = 'active' or c.closed_at > now() - interval '1 day') order by c.created_at desc limit 40`, [agentId]);
  const rows = r.rows.map((c) => ({ ...pub(c), client: c.client, coach: c.coach }));
  return { as_coach: rows.filter((c) => c.coach_id === agentId), as_client: rows.filter((c) => c.client_id === agentId) };
}

/** Called by the coach's train(): the active contract that still has a task to give, locked. */
export async function contractForTraining(tx: Tx, coachId: string, clientRef: string, skill: string) {
  const r = await tx.query(
    `select c.* from coaching_contracts c join agents a on a.id = c.client_id
      where c.coach_id = $1 and (a.id = $2 or a.handle = $2) and c.skill = $3 and c.state = 'active' and c.expires_at > now()
      order by c.created_at limit 1 for update of c`, [coachId, String(clientRef).toLowerCase().replace(/^@/, ''), skill]);
  if (!r.rowCount) throw new ApiError(403, 'no_contract', 'no active coaching contract with that agent for this skill');
  const c = r.rows[0];
  const open = await tx.query(`select count(*)::int as n from training_tasks where contract_id = $1 and state = 'open'`, [c.id]);
  if (c.tasks_done + open.rows[0].n >= c.tasks_total) throw new ApiError(409, 'contract_full', 'every task in this contract is taken');
  return c;
}

/** Called inside answer(): settle one coached task. */
export async function settleCoachedTask(ctx: Ctx, tx: Tx, contractId: string, taskId: string, passed: boolean, evs: WorldEvent[]) {
  const r = await tx.query('select * from coaching_contracts where id = $1 for update', [contractId]);
  const c = r.rows[0];
  if (!c || c.state !== 'active') return;
  const per = Number(c.price_per_task);
  if (passed) {
    const fee = Math.floor(per * ctx.config.feeBps / 10000);
    await postTransfer(tx, `coach_pay:${taskId}`, 'escrow_out',
      [{ account: escrow(c.id), amount: -per }, { account: agentAccount(c.coach_id), amount: per - fee }, ...(fee ? [{ account: feeAccount(ctx.config), amount: fee }] : [])],
      `coaching task passed (${c.skill})`);
    evs.push({ kind: 'payment', from: c.client_id, to: c.coach_id, amount: per - fee, memo: 'coaching' });
  } else {
    await postTransfer(tx, `coach_refund:${taskId}`, 'refund',
      [{ account: escrow(c.id), amount: -per }, { account: agentAccount(c.client_id), amount: per }], `coaching task missed (${c.skill})`);
  }
  const done = c.tasks_done + 1;
  await tx.query(`update coaching_contracts set tasks_done = $2, tasks_passed = tasks_passed + $3, state = $4, closed_at = case when $4 = 'done' then now() else null end where id = $1`,
    [c.id, done, passed ? 1 : 0, done >= c.tasks_total ? 'done' : 'active']);
}

async function close(ctx: Ctx, tx: Tx, c: any, state: 'cancelled' | 'declined' | 'expired', evs: WorldEvent[]) {
  await tx.query(`update training_tasks set state = 'expired' where contract_id = $1 and state = 'open'`, [c.id]);
  const left = (c.tasks_total - c.tasks_done) * Number(c.price_per_task);
  if (left > 0) {
    await postTransfer(tx, `coach_close:${c.id}`, 'refund', [{ account: escrow(c.id), amount: -left }, { account: agentAccount(c.client_id), amount: left }], `coaching ${state}`);
    evs.push({ kind: 'refunded', job_id: c.id, buyer: c.client_id, amount: left, reason: `coaching ${state}` });
  }
  await tx.query(`update coaching_contracts set state = $2, closed_at = now() where id = $1`, [c.id, state]);
}

export async function endCoaching(ctx: Ctx, agent: AgentRow, id: string, how: 'cancel' | 'decline') {
  const evs: WorldEvent[] = [];
  await withTx(ctx.db, async (tx) => {
    const r = await tx.query('select * from coaching_contracts where id = $1 for update', [id]);
    const c = r.rows[0];
    if (!c) throw new ApiError(404, 'no_contract', 'no such contract');
    if (how === 'cancel' && c.client_id !== agent.id) throw new ApiError(403, 'not_client', 'only the client can cancel');
    if (how === 'decline' && c.coach_id !== agent.id) throw new ApiError(403, 'not_coach', 'only the coach can decline');
    if (c.state !== 'active') throw new ApiError(409, 'closed', `contract is ${c.state}`);
    await close(ctx, tx, c, how === 'cancel' ? 'cancelled' : 'declined', evs);
  });
  await ctx.bus.publish(ctx.db, evs);
  return { closed: id };
}

export async function sweepCoaching(ctx: Ctx) {
  const due = await ctx.db.query(`select id from coaching_contracts where state = 'active' and expires_at < now() limit 50`);
  for (const { id } of due.rows) {
    const evs: WorldEvent[] = [];
    await withTx(ctx.db, async (tx) => {
      const c = (await tx.query('select * from coaching_contracts where id = $1 for update', [id])).rows[0];
      if (c?.state === 'active') await close(ctx, tx, c, 'expired', evs);
    });
    await ctx.bus.publish(ctx.db, evs);
  }
}
