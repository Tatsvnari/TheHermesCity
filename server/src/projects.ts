// One town, same rules (Phase 3): town projects. One at a time, the city builds something big together. Citizens join
// (project_join) and every graded task they pass from then on is work for it, up to DAY_CAP a day each so a tireless
// agent cannot carry it alone; anyone can give Obols (project_give). A project is finished only when the work, the
// Obols and enough people among its builders are all there: it takes agents and people both. Then the map changes,
// the Obols go to the city's works, and every builder gets a trophy. CityRunner residents cheer it on but do not build.
import { randomBytes } from 'node:crypto';
import type { Ctx } from './config.ts';
import type { Q } from './db.ts';
import { withTx } from './db.ts';
import type { AgentRow } from './agents.ts';
import { assertSpend } from './agents.ts';
import { agentAccount, balance, ensureAccount, postTransfer } from './ledger.ts';
import { WORKS, mayorSay } from './civic.ts';
import { ApiError, MILLI } from './types.ts';

export const PROJECTS = [
  { kind: 'footbridge', name: 'the Footbridge', blurb: 'a wooden footbridge across the pond in the park', work: 1200, seeds: 3000, people: 3 },
  { kind: 'lanterns', name: 'the Lantern Walk', blurb: 'lanterns all the way along Meadow Lane, lit at night', work: 2400, seeds: 6000, people: 5 },
  { kind: 'amphitheatre', name: 'the Amphitheatre', blurb: 'stone seats round the bandstand for concerts and the Poetry Slam', work: 4000, seeds: 12000, people: 8 },
];
export const DAY_CAP = 40, BUILDER_WORK = 10, BUILDER_SEEDS = 50;
const account = (kind: string) => `project:${kind}`;
const isCitizen = (ctx: Ctx, a: AgentRow) => (a.role === 'agent' || a.role === 'player') && a.owner_email !== ctx.config.houseOwner;
const title = (s: string) => s.replace(/^the /, 'The ');

export function open(ctx: Ctx) {
  if (!ctx.config.townEnabled) throw new ApiError(403, 'not_open', 'town projects start with the City Hall');
}
export async function current(q: Q) {
  return (await q.query(`select * from projects where state = 'open' order by id desc limit 1`)).rows[0] ?? null;
}
export async function doneKinds(q: Q) {
  return (await q.query(`select kind from projects where state = 'done' order by done_at`).catch(() => ({ rows: [] as any[] }))).rows.map((r) => r.kind as string);
}

/** Every builder's work (capped tasks passed since joining) and gifts on a project. */
export async function builders(q: Q, p: any) {
  const r = await q.query(`
    with w as (select m.agent_id, date_trunc('day', t.answered_at) as d, count(*)::int as n from project_members m
                 join training_tasks t on t.agent_id = m.agent_id and t.state = 'passed' and t.answered_at >= m.joined_at
                   and t.answered_at < coalesce($2::timestamptz, now())
                where m.project_id = $1 group by m.agent_id, d),
         ww as (select agent_id, sum(least(n, ${DAY_CAP}))::int as work from w group by agent_id),
         g as (select agent_id, sum(amount)::bigint as seeds from project_gifts where project_id = $1 group by agent_id),
         who as (select agent_id from project_members where project_id = $1 union select agent_id from g)
    select a.id, a.handle, a.role, coalesce(ww.work, 0) as work, coalesce(g.seeds, 0) as seeds from who
      join agents a on a.id = who.agent_id left join ww on ww.agent_id = who.agent_id left join g on g.agent_id = who.agent_id`, [p.id, p.done_at]);
  return r.rows.map((x) => ({ id: x.id as string, handle: x.handle as string, kind: (x.role === 'player' ? 'person' : 'agent') as 'person' | 'agent', work: Number(x.work), seeds: Number(x.seeds) / MILLI }));
}
const isBuilder = (b: { work: number; seeds: number }) => b.work >= BUILDER_WORK || b.seeds >= BUILDER_SEEDS;
function tally(bs: Awaited<ReturnType<typeof builders>>) {
  return { work: bs.reduce((s, b) => s + b.work, 0), seeds: bs.reduce((s, b) => s + b.seeds, 0),
    people: bs.filter((b) => b.kind === 'person' && isBuilder(b)).length, agents: bs.filter((b) => b.kind === 'agent' && isBuilder(b)).length };
}

export async function view(ctx: Ctx, agent: AgentRow | null) {
  const q = ctx.db, p = await current(q);
  const done = (await q.query(`select kind, done_at from projects where state = 'done' order by done_at`)).rows
    .map((d) => ({ kind: d.kind, name: PROJECTS.find((x) => x.kind === d.kind)?.name ?? d.kind, done_at: d.done_at }));
  const rules = `One project at a time. Join it (project_join) and every task you pass from then on is work for it, up to ${DAY_CAP} a day; give Obols with project_give. `
    + `It is finished when the work, the Obols and enough people among the builders (a builder has done ${BUILDER_WORK}+ work or given ${BUILDER_SEEDS}+ Obols) are all there. Then it appears on the map, and every builder gets a trophy.`;
  if (!p) return { project: null, done, rules };
  const def = PROJECTS.find((x) => x.kind === p.kind)!;
  const bs = await builders(q, p);
  const mine = agent ? bs.find((b) => b.id === agent.id) : undefined;
  const joined = agent ? !!(await q.query('select 1 from project_members where project_id = $1 and agent_id = $2', [p.id, agent.id])).rowCount : false;
  return {
    project: { kind: p.kind, name: def.name, blurb: def.blurb, started_at: p.started_at, goals: { work: def.work, seeds: def.seeds, people: def.people }, progress: tally(bs),
      builders: bs.sort((a, b) => b.work + b.seeds / 10 - (a.work + a.seeds / 10)).slice(0, 12).map(({ id: _i, ...b }) => b),
      ...(agent ? { you: { joined, work: mine?.work ?? 0, seeds: mine?.seeds ?? 0 } } : {}) },
    done, rules,
  };
}

export async function join(ctx: Ctx, agent: AgentRow) {
  open(ctx);
  if (!isCitizen(ctx, agent)) throw new ApiError(403, 'resident', 'town projects are built by citizens: outside agents and players');
  const p = await current(ctx.db);
  if (!p) throw new ApiError(404, 'no_project', 'no project is open right now');
  const r = await ctx.db.query('insert into project_members (project_id, agent_id) values ($1, $2) on conflict do nothing returning joined_at', [p.id, agent.id]);
  if (r.rowCount) { await ctx.bus.publish(ctx.db, [{ kind: 'project_joined', agent: agent.id, what: PROJECTS.find((x) => x.kind === p.kind)?.name } as any]); ctx.bus.emit('projects'); }
  return { joined: PROJECTS.find((x) => x.kind === p.kind)?.name, note: `every task you pass from now counts, up to ${DAY_CAP} a day` };
}

export async function give(ctx: Ctx, agent: AgentRow, seeds: number) {
  open(ctx);
  if (!isCitizen(ctx, agent)) throw new ApiError(403, 'resident', 'town projects are built by citizens: outside agents and players');
  const p = await current(ctx.db);
  if (!p) throw new ApiError(404, 'no_project', 'no project is open right now');
  const m = Math.round(Number(seeds) * MILLI);
  if (!(m >= MILLI && m <= 5000 * MILLI)) throw new ApiError(400, 'bad_amount', 'give 1 to 5,000 Obols');
  await withTx(ctx.db, async (tx) => {
    await assertSpend(ctx, tx, agent.id, m);
    await ensureAccount(tx, account(p.kind), 'system');
    await postTransfer(tx, `project:${p.kind}:${agent.id}:${randomBytes(6).toString('hex')}`, 'pay', [{ account: agentAccount(agent.id), amount: -m }, { account: account(p.kind), amount: m }], `a gift to ${PROJECTS.find((x) => x.kind === p.kind)?.name}`);
    await tx.query('insert into project_gifts (project_id, agent_id, amount) values ($1, $2, $3)', [p.id, agent.id, m]);
  });
  await ctx.bus.publish(ctx.db, [{ kind: 'project_gift', agent: agent.id, amount: m / MILLI, what: PROJECTS.find((x) => x.kind === p.kind)?.name } as any]);
  ctx.bus.emit('projects');
  return { given: m / MILLI, progress: tally(await builders(ctx.db, p)) };
}

/** Every half minute: open the next project when none is, and finish the open one when everything is there. */
export async function sweep(ctx: Ctx) {
  if (!ctx.config.townEnabled) return;
  const p = await current(ctx.db);
  if (!p) {
    const done = new Set(await doneKinds(ctx.db));
    const next = PROJECTS.find((x) => !done.has(x.kind));
    if (!next) return;
    const r = await ctx.db.query('insert into projects (kind) values ($1) on conflict (kind) do nothing returning id', [next.kind]);
    if (r.rowCount) {
      await mayorSay(ctx, `A new city project: ${next.name}, ${next.blurb}. It takes ${next.work.toLocaleString('en-US')} tasks of work, ${next.seeds.toLocaleString('en-US')} Obols and at least ${next.people} people among the builders. Join it at the City Hall!`);
      ctx.bus.emit('projects');
    }
    return;
  }
  const def = PROJECTS.find((x) => x.kind === p.kind);
  if (!def) return;
  const bs = await builders(ctx.db, p), t = tally(bs);
  if (t.work < def.work || t.seeds < def.seeds || t.people < def.people) return;
  const finished = await withTx(ctx.db, async (tx) => {
    const u = await tx.query(`update projects set state = 'done', done_at = now() where id = $1 and state = 'open' returning id`, [p.id]);
    if (!u.rowCount) return false;
    const held = await balance(tx, account(p.kind)).catch(() => 0);
    if (held > 0) await postTransfer(tx, `project_built:${p.kind}`, 'public_works', [{ account: account(p.kind), amount: -held }, { account: WORKS, amount: held }], `${def.name} is built`);
    for (const b of bs.filter(isBuilder)) await tx.query('insert into trophies (agent_id, place, title) values ($1, 1, $2)', [b.id, `Builder of ${title(def.name)}`]);
    return true;
  });
  if (!finished) return;
  await ctx.bus.publish(ctx.db, [{ kind: 'project_done', what: def.name, project: p.kind } as any]);
  await mayorSay(ctx, `It's finished! ${title(def.name)} is built: ${def.blurb}. Built by ${t.people} ${t.people === 1 ? 'person' : 'people'} and ${t.agents} ${t.agents === 1 ? 'agent' : 'agents'} together. Thank you, builders!`);
  ctx.bus.emit('projects');
}
