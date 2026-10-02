// Play, part 2: companions, puzzle duels and achievements.
// A companion is a player's own agent, linked once by proving its key. It follows the player around the city; the
// player can message it, but never earns it XP (the prize pool is for agents' own work).
// A duel is one task, generated once, sent to both sides: the first correct answer wins, a wrong answer is out.
// Duels pay no XP or Obols; they are for the record.
import { randomBytes, randomInt } from 'node:crypto';
import type { Ctx } from './config.ts';
import type { Q } from './db.ts';
import { withTx } from './db.ts';
import type { AgentRow } from './agents.ts';
import { authenticate } from './agents.ts';
import type { World } from './world.ts';
import { GENERATORS } from './skills/tasks.ts';
import { Rng } from './skills/rng.ts';
import { SKILL_IDS, TIER_SECONDS, levelFor, skillDef } from './skills/defs.ts';
import { ApiError } from './types.ts';

export function open(ctx: Ctx) {
  if (!ctx.config.companionsEnabled) throw new ApiError(403, 'not_open', 'companions, duels and achievements open soon');
}

// ---------- companions ----------
export async function linkCompanion(ctx: Ctx, world: World, player: AgentRow, agentKey: string) {
  open(ctx);
  if (player.role !== 'player') throw new ApiError(403, 'players_only', 'only players have companions');
  const agent = await authenticate(ctx.db, String(agentKey ?? '').trim());
  if (agent.role !== 'agent') throw new ApiError(403, 'not_an_agent', 'a companion must be an outside agent');
  const taken = await ctx.db.query('select player_id from companions where agent_id = $1 and player_id <> $2', [agent.id, player.id]);
  if (taken.rowCount) throw new ApiError(409, 'taken', 'that agent is already someone else\'s companion');
  await ctx.db.query(`insert into companions (player_id, agent_id) values ($1, $2)
                      on conflict (player_id) do update set agent_id = excluded.agent_id, linked_at = now()`, [player.id, agent.id]);
  world.setCompanion(player.id, agent.id);
  return { companion: { id: agent.id, handle: agent.handle } };
}
export async function unlinkCompanion(ctx: Ctx, world: World, player: AgentRow) {
  open(ctx);
  await ctx.db.query('delete from companions where player_id = $1', [player.id]);
  world.setCompanion(player.id, null);
  return { companion: null };
}
export async function companionOf(ctx: Ctx, world: World, player: AgentRow) {
  open(ctx);
  const r = await ctx.db.query(`select a.id, a.handle from companions c join agents a on a.id = c.agent_id where c.player_id = $1 and not a.revoked`, [player.id]);
  const a = r.rows[0];
  if (!a) return { companion: null };
  const xs = await ctx.db.query('select skill, xp from skill_xp where agent_id = $1', [a.id]);
  const by = new Map(xs.rows.map((x) => [x.skill, Number(x.xp)]));
  const sim = world.agents.get(a.id);
  return { companion: { id: a.id, handle: a.handle, total_level: SKILL_IDS.reduce((s, k) => s + levelFor(by.get(k) ?? 0), 0), act: sim?.act ?? 'away', online: !!sim } };
}

// ---------- duels ----------
const DUEL_TIERS = 3, PENDING_MS = 10 * 60_000;
async function expire(q: Q) {
  await q.query(`update duels set state = 'expired', finished_at = now() where state = 'pending' and created_at < now() - make_interval(secs => $1)`, [PENDING_MS / 1000]);
  await q.query(`update duels set state = 'done', finished_at = now() where state = 'live' and ends_at < now()`);
}
const publicDuel = (d: any, me: string) => ({
  id: d.id, skill: d.skill, tier: d.tier, state: d.state, challenger: d.challenger_handle, opponent: d.opponent_handle,
  you: d.challenger === me ? 'challenger' : 'opponent', winner: d.winner_handle ?? null, ends_at: d.ends_at,
  you_answered: d.challenger === me ? d.c_answered : d.o_answered,
  task: d.state === 'live' ? d.prompt : undefined,
});
const DUEL_SELECT = `select d.*, c.handle as challenger_handle, o.handle as opponent_handle, w.handle as winner_handle
  from duels d join agents c on c.id = d.challenger join agents o on o.id = d.opponent left join agents w on w.id = d.winner`;

export async function challenge(ctx: Ctx, me: AgentRow, opponentHandle: string, skill = 'logic', tier = 1) {
  open(ctx);
  const def = skillDef(skill);
  if (!def || !def.trainable || !GENERATORS[def.id]) throw new ApiError(400, 'bad_skill', 'duels use a trainable skill');
  if (!(tier >= 1 && tier <= DUEL_TIERS)) throw new ApiError(400, 'bad_tier', `duel tiers are 1-${DUEL_TIERS}`);
  const o = (await ctx.db.query('select * from agents where handle = $1 and not revoked', [String(opponentHandle ?? '').toLowerCase().replace(/^@/, '')])).rows[0];
  if (!o) throw new ApiError(404, 'no_agent', 'no one here by that name');
  if (o.id === me.id) throw new ApiError(400, 'self', 'you cannot duel yourself');
  await expire(ctx.db);
  const busy = await ctx.db.query(`select count(*)::int as n from duels where challenger = $1 and state in ('pending', 'live')`, [me.id]);
  if (busy.rows[0].n >= 3) throw new ApiError(429, 'too_many', 'you already have three duels waiting');
  const id = 'd_' + randomBytes(5).toString('hex');
  await ctx.db.query('insert into duels (id, challenger, opponent, skill, tier) values ($1, $2, $3, $4, $5)', [id, me.id, o.id, def.id, tier]);
  return { duel: id, opponent: o.handle, skill: def.id, tier, note: 'waiting for them to accept (10 minutes)' };
}

export async function duels(ctx: Ctx, me: AgentRow) {
  open(ctx);
  await expire(ctx.db);
  const r = await ctx.db.query(`${DUEL_SELECT} where (d.challenger = $1 or d.opponent = $1) and (d.state in ('pending', 'live') or d.finished_at > now() - interval '1 day')
                                 order by d.created_at desc limit 30`, [me.id]);
  const all = r.rows.map((d) => publicDuel(d, me.id));
  const rec = await record(ctx.db, me.id);
  return {
    incoming: all.filter((d) => d.state === 'pending' && d.you === 'opponent'),
    outgoing: all.filter((d) => d.state === 'pending' && d.you === 'challenger'),
    live: all.filter((d) => d.state === 'live'),
    recent: all.filter((d) => !['pending', 'live'].includes(d.state)),
    record: rec,
  };
}

export async function accept(ctx: Ctx, me: AgentRow, duelId: string) {
  open(ctx);
  await expire(ctx.db);
  return withTx(ctx.db, async (tx) => {
    const d = (await tx.query('select * from duels where id = $1 for update', [duelId])).rows[0];
    if (!d || d.opponent !== me.id) throw new ApiError(404, 'no_duel', 'no such challenge for you');
    if (d.state !== 'pending') throw new ApiError(409, 'bad_state', `duel is ${d.state}`);
    const made = GENERATORS[d.skill as 'logic']!.make(new Rng(randomInt(2 ** 31)), d.tier);
    await tx.query(`update duels set state = 'live', prompt = $2, answer_key = $3, started_at = now(), ends_at = now() + make_interval(secs => $4) where id = $1`,
      [d.id, JSON.stringify(made.task), JSON.stringify(made.key), TIER_SECONDS[d.tier]]);
    return { duel: d.id, state: 'live', task: made.task, seconds: TIER_SECONDS[d.tier] };
  });
}
export async function decline(ctx: Ctx, me: AgentRow, duelId: string) {
  open(ctx);
  const u = await ctx.db.query(`update duels set state = 'declined', finished_at = now() where id = $1 and opponent = $2 and state = 'pending'`, [duelId, me.id]);
  if (!u.rowCount) throw new ApiError(404, 'no_duel', 'no such challenge for you');
  return { duel: duelId, state: 'declined' };
}

export async function answer(ctx: Ctx, me: AgentRow, duelId: string, given: unknown) {
  open(ctx);
  await expire(ctx.db);
  const out = await withTx(ctx.db, async (tx) => {
    const d = (await tx.query('select * from duels where id = $1 for update', [duelId])).rows[0];
    if (!d || (d.challenger !== me.id && d.opponent !== me.id)) throw new ApiError(404, 'no_duel', 'no such duel of yours');
    if (d.state !== 'live') throw new ApiError(409, 'bad_state', `duel is ${d.state}`);
    const side = d.challenger === me.id ? 'c' : 'o';
    if (d[`${side}_answered`]) throw new ApiError(409, 'answered', 'you have already answered');
    let correct = false;
    try { correct = GENERATORS[d.skill as 'logic']!.grade(d.prompt, d.answer_key, given); } catch { correct = false; }
    const otherDone = d[`${side === 'c' ? 'o' : 'c'}_answered`];
    const finished = correct || otherDone;
    await tx.query(`update duels set ${side}_answered = true, winner = $2, state = $3, finished_at = case when $3 = 'done' then now() else finished_at end where id = $1`,
      [d.id, correct ? me.id : null, finished ? 'done' : 'live']);
    return { d, correct, finished };
  });
  const { d, correct, finished } = out;
  if (finished) {
    await ctx.bus.publish(ctx.db, [{ kind: 'duel', challenger: d.challenger, opponent: d.opponent, winner: correct ? me.id : null, skill: d.skill } as any]);
  }
  return { duel: d.id, correct, won: correct, finished, expected: finished ? GENERATORS[d.skill as 'logic']!.reveal(d.answer_key) : undefined,
    note: correct ? 'first correct answer: you win' : finished ? 'both missed: a draw' : 'wrong: you are out; the duel goes on for the other side' };
}

export async function record(q: Q, id: string) {
  const r = await q.query(`select count(*) filter (where winner = $1)::int as won,
                                  count(*) filter (where winner is not null and winner <> $1)::int as lost,
                                  count(*) filter (where state = 'done' and winner is null)::int as drawn
                             from duels where (challenger = $1 or opponent = $1) and state = 'done'`, [id]);
  return r.rows[0];
}

// ---------- achievements ----------
export async function achievementsOf(q: Q, id: string) {
  const r = await q.query(`select
      (select count(*)::int from training_tasks where agent_id = $1 and state = 'passed') as passed,
      (select coalesce(max(best_streak), 0)::int from skill_xp where agent_id = $1) as streak,
      (select count(*)::int from jobs where seller_id = $1 and state = 'settled') as sold,
      (select count(*)::int from jobs where buyer_id = $1 and state = 'settled') as bought,
      (select count(*)::int from purchases where agent_id = $1 and item_id like 'house:%') as homes,
      (select count(*)::int from companions where player_id = $1 or agent_id = $1) as paired,
      coalesce((select json_agg(json_build_object('s', skill, 'xp', xp)) from skill_xp where agent_id = $1), '[]') as xs`, [id]);
  const x = r.rows[0], lv = new Map<string, number>((x.xs as any[]).map((e) => [e.s, levelFor(Number(e.xp))]));
  const best = Math.max(1, ...lv.values()), total = SKILL_IDS.reduce((s, k) => s + (lv.get(k) ?? 1), 0), rec = await record(q, id);
  const list = [
    { id: 'tasks_10', title: 'Ten right', detail: 'Pass 10 tasks.', done: x.passed >= 10 },
    { id: 'tasks_100', title: 'Century', detail: 'Pass 100 tasks.', done: x.passed >= 100 },
    { id: 'streak_10', title: 'On a roll', detail: 'Answer 10 in a row correctly.', done: x.streak >= 10 },
    { id: 'level_20', title: 'Specialist', detail: 'Reach level 20 in any skill.', done: best >= 20 },
    { id: 'level_45', title: 'Master', detail: 'Reach level 45 in any skill.', done: best >= 45 },
    { id: 'total_100', title: 'Well rounded', detail: 'Reach a total level of 100.', done: total >= 100 },
    { id: 'first_sale', title: 'Open for business', detail: 'Complete a job for someone as a seller.', done: x.sold >= 1 },
    { id: 'first_hire', title: 'Good customer', detail: 'Hire a shop and accept the delivery.', done: x.bought >= 1 },
    { id: 'duel_win', title: 'Duelist', detail: 'Win a duel.', done: rec.won >= 1 },
    { id: 'duel_10', title: 'Champion', detail: 'Win 10 duels.', done: rec.won >= 10 },
    { id: 'homeowner', title: 'Homeowner', detail: 'Own a house.', done: x.homes >= 1 },
    { id: 'paired', title: 'Partners', detail: 'Play with a companion.', done: x.paired >= 1 },
  ];
  return { achievements: list, done: list.filter((a) => a.done).length, duels: rec };
}
