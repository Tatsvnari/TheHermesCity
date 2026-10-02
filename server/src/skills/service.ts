// Training loop: request a task at a station, answer it, earn XP. One open task per skill per agent.
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../config.ts';
import type { Q, Tx } from '../db.ts';
import { withTx } from '../db.ts';
import type { AgentRow } from '../agents.ts';
import { ownerKey } from '../agents.ts';
import { ApiError } from '../types.ts';
import type { WorldEvent } from '../types.ts';
import { Rng } from './rng.ts';
import { GENERATORS } from './tasks.ts';
import { SKILLS, SKILL_IDS, TIER_SECONDS, awardXp, commerceXp, levelFor, maxTier, progress, skillDef, type SkillId } from './defs.ts';
import { contractForTraining, settleCoachedTask } from '../coaching.ts';

export interface TrainHooks { onTrainStart(agentId: string, skill: SkillId): void; onResult(agentId: string, skill: SkillId, passed: boolean, xp: number): void }

async function xpRow(q: Q, agentId: string, skill: string) {
  const r = await q.query('select * from skill_xp where agent_id = $1 and skill = $2', [agentId, skill]);
  return r.rows[0] ?? { xp: 0, attempts: 0, correct: 0, streak: 0, best_streak: 0 };
}

const publicTask = (t: any) => ({
  task_id: t.id, skill: t.skill, tier: t.tier, expires_at: t.expires_at, ...t.prompt,
});

export async function train(ctx: Ctx, hooks: TrainHooks, agent: AgentRow, skill: string, tier?: number, forAgent?: string) {
  const def = skillDef(skill);
  if (!def) throw new ApiError(400, 'bad_skill', `skill one of ${SKILL_IDS.join(', ')}`);
  if (!def.trainable) throw new ApiError(409, 'not_trainable', `${def.name} cannot be practised: it grows only from paid jobs settled with agents of other owners`);
  const gen = GENERATORS[def.id]!;
  const out = await withTx(ctx.db, async (tx) => {
    // coaching: the task belongs to the client, the coach holds it
    const contract = forAgent ? await contractForTraining(tx, agent.id, forAgent, def.id) : null;
    const owner = contract ? contract.client_id : agent.id, coach = contract ? agent.id : null;
    await tx.query(`update training_tasks set state = 'expired' where agent_id = $1 and skill = $2 and state = 'open' and expires_at < now()`, [owner, skill]);
    const open = await tx.query(`select * from training_tasks where agent_id = $1 and skill = $2 and state = 'open' and coach_id is not distinct from $3`, [owner, skill, coach]);
    if (open.rowCount) return { task: open.rows[0], resumed: true };
    const level = levelFor((await xpRow(tx, owner, skill)).xp);
    const cap = maxTier(level);
    const t = tier === undefined ? cap : Math.round(tier);
    if (!(t >= 1 && t <= cap)) throw new ApiError(403, 'tier_locked', `tier ${t} unlocks later: at level ${level} you may take tiers 1-${cap}`);
    const seed = randomBytes(4).readUInt32LE(0);
    const made = gen.make(new Rng(seed), t);
    const r = await tx.query(
      `insert into training_tasks (id, agent_id, skill, tier, prompt, answer_key, expires_at, coach_id, contract_id)
       values ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7), $8, $9) returning *`,
      ['t_' + randomBytes(6).toString('hex'), owner, skill, t, JSON.stringify(made.task), JSON.stringify(made.key), TIER_SECONDS[t], coach, contract?.id ?? null]);
    return { task: r.rows[0], resumed: false };
  });
  hooks.onTrainStart(agent.id, def.id);
  return { ...publicTask(out.task), resumed: out.resumed };
}

export async function answer(ctx: Ctx, hooks: TrainHooks, agent: AgentRow, taskId: string, given: unknown) {
  const evs: WorldEvent[] = [];
  const res = await withTx(ctx.db, async (tx) => {
    const r = await tx.query('select * from training_tasks where id = $1 for update', [taskId]);
    const t = r.rows[0];
    if (!t || (t.coach_id ? t.coach_id !== agent.id : t.agent_id !== agent.id)) throw new ApiError(404, 'no_task', 'no such task of yours');
    const owner = t.agent_id; // XP always goes to the task's owner (the client, when coached)
    if (t.state !== 'open') throw new ApiError(409, 'task_closed', `task is ${t.state}`);
    const gen = GENERATORS[t.skill as SkillId]!;
    const expired = new Date(t.expires_at) < new Date();
    let passed = false;
    if (!expired) { try { passed = gen.grade(t.prompt, t.answer_key, given); } catch { passed = false; } }
    await tx.query(`insert into skill_xp (agent_id, skill) values ($1, $2) on conflict do nothing`, [owner, t.skill]);
    const row = (await tx.query('select * from skill_xp where agent_id = $1 and skill = $2 for update', [owner, t.skill])).rows[0];
    const before = levelFor(row.xp);
    const xp = passed ? awardXp(t.tier, before, row.streak) : 0;
    const streak = passed ? row.streak + 1 : 0;
    await tx.query(
      `update skill_xp set xp = xp + $3, attempts = attempts + 1, correct = correct + $4, streak = $5,
              best_streak = greatest(best_streak, $5), updated_at = now() where agent_id = $1 and skill = $2`,
      [owner, t.skill, xp, passed ? 1 : 0, streak]);
    await tx.query(`update training_tasks set state = $2, xp_awarded = $3, answered_at = now() where id = $1`,
      [taskId, expired ? 'expired' : passed ? 'passed' : 'failed', xp]);
    const after = levelFor(row.xp + xp);
    if (after > before) evs.push({ kind: 'level_up', agent: owner, skill: t.skill, level: after });
    if (t.contract_id) await settleCoachedTask(ctx, tx, t.contract_id, taskId, passed, evs);
    return {
      task_id: taskId, skill: t.skill, tier: t.tier, passed, expired, xp_gained: xp, streak, for: t.coach_id ? owner : undefined,
      ...progress(row.xp + xp), level_up: after > before ? after : null,
      expected: passed ? undefined : gen.reveal(t.answer_key),
    };
  });
  await ctx.bus.publish(ctx.db, evs);
  hooks.onResult(agent.id, res.skill as SkillId, res.passed, res.xp_gained);
  return res;
}

/** Commerce XP for a settled job between agents of different owners. Called inside the settlement transaction. */
export async function grantCommerce(tx: Tx, jobId: string, evs: WorldEvent[]) {
  const r = await tx.query(
    `select j.buyer_id, j.seller_id, j.price, ${ownerKey('b.owner_email')} <> ${ownerKey('s.owner_email')} as cross_owner
       from jobs j join agents b on b.id = j.buyer_id join agents s on s.id = j.seller_id where j.id = $1`, [jobId]);
  const j = r.rows[0];
  if (!j?.cross_owner) return;
  for (const [id, role] of [[j.seller_id, 'seller'], [j.buyer_id, 'buyer']] as const) {
    const gain = commerceXp(j.price, role);
    const prev = await tx.query(
      `insert into skill_xp (agent_id, skill, xp, attempts, correct) values ($1, 'commerce', 0, 0, 0)
       on conflict (agent_id, skill) do update set agent_id = excluded.agent_id returning xp`, [id]);
    const before = levelFor(prev.rows[0].xp);
    await tx.query(`update skill_xp set xp = xp + $2, attempts = attempts + 1, correct = correct + 1, updated_at = now()
                     where agent_id = $1 and skill = 'commerce'`, [id, gain]);
    const after = levelFor(prev.rows[0].xp + gain);
    if (after > before) evs.push({ kind: 'level_up', agent: id, skill: 'commerce', level: after });
  }
}

export async function skillsOf(q: Q, agentId: string) {
  const r = await q.query('select * from skill_xp where agent_id = $1', [agentId]);
  const by = new Map(r.rows.map((x) => [x.skill, x]));
  const skills = SKILLS.map((s) => {
    const x = by.get(s.id) ?? { xp: 0, attempts: 0, correct: 0, streak: 0, best_streak: 0 };
    const p = progress(Number(x.xp));
    return { skill: s.id, name: s.name, ...p, attempts: x.attempts, accuracy: x.attempts ? x.correct / x.attempts : null,
      streak: x.streak, best_streak: x.best_streak, max_tier: s.trainable ? maxTier(p.level) : null };
  });
  return { total_level: skills.reduce((s, x) => s + x.level, 0), total_xp: skills.reduce((s, x) => s + x.xp, 0), skills };
}

/** kind 'agents' (default): every agent, residents included, never players. kind 'players': people playing in the browser. */
export async function leaderboard(q: Q, skill: string | undefined, limit = 25, kind: 'agents' | 'players' | 'all' = 'agents') {
  limit = Math.max(1, Math.min(100, limit));
  const who = kind === 'players' ? `a.role = 'player'` : kind === 'all' ? 'true' : `a.role <> 'player'`; // all: one board, agents and people together
  if (skill && skill !== 'overall') {
    if (!skillDef(skill)) throw new ApiError(400, 'bad_skill', 'unknown skill');
    const r = await q.query(
      `select x.agent_id, a.handle, a.role, a.avatar, x.xp, x.attempts, x.correct, x.best_streak
         from skill_xp x join agents a on a.id = x.agent_id
        where x.skill = $1 and not a.revoked and ${who} and x.xp > 0 order by x.xp desc, x.updated_at asc limit $2`, [skill, limit]);
    return r.rows.map((x, i) => ({ rank: i + 1, agent_id: x.agent_id, handle: x.handle, role: x.role, avatar: x.avatar,
      level: levelFor(Number(x.xp)), xp: Number(x.xp), accuracy: x.attempts ? x.correct / x.attempts : null, best_streak: x.best_streak }));
  }
  const r = await q.query(
    `select a.id as agent_id, a.handle, a.role, a.avatar, x.skill, x.xp from agents a join skill_xp x on x.agent_id = a.id
      where not a.revoked and ${who} and x.xp > 0`);
  const agg = new Map<string, any>();
  for (const x of r.rows) {
    const e = agg.get(x.agent_id) ?? { agent_id: x.agent_id, handle: x.handle, role: x.role, avatar: x.avatar, levels: new Map(), xp: 0 };
    e.levels.set(x.skill, levelFor(Number(x.xp))); e.xp += Number(x.xp); agg.set(x.agent_id, e);
  }
  return [...agg.values()].map((e) => {
    const total = SKILL_IDS.reduce((s, id) => s + (e.levels.get(id) ?? 1), 0);
    let top: string | null = null, topL = 1;
    for (const [k, l] of e.levels) if (l > topL) { top = k; topL = l; }
    return { agent_id: e.agent_id, handle: e.handle, role: e.role, avatar: e.avatar, total_level: total, xp: e.xp, top_skill: top, top_level: topL };
  }).sort((a, b) => b.total_level - a.total_level || b.xp - a.xp).slice(0, limit).map((x, i) => ({ rank: i + 1, ...x }));
}

export async function trainingStats(q: Q) {
  const r = await q.query(`select count(*) filter (where state = 'passed')::int as passed, count(*)::int as attempts,
    coalesce(sum(xp_awarded), 0)::bigint as xp from training_tasks where created_at > now() - interval '24 hours'`);
  return r.rows[0];
}
