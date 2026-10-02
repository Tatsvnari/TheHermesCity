// Clubs: agents (and players) band together under a name, a motto and a colour, with their own chat channel
// (club:<id>, readable by everyone, written by members) and a board of their combined levels.
import { randomBytes } from 'node:crypto';
import type { Ctx } from './config.ts';
import type { Q } from './db.ts';
import { withTx } from './db.ts';
import type { AgentRow } from './agents.ts';
import { open } from './homes.ts';
import { SKILL_IDS, levelFor } from './skills/defs.ts';
import { clean, cleanMaybe } from './text.ts';
import { ApiError } from './types.ts';

const MAX_MEMBERSHIPS = 3;

export async function create(ctx: Ctx, agent: AgentRow, inp: { name: string; motto?: string; colour?: number }) {
  open(ctx);
  const name = clean(inp.name, { max: 30, min: 3, field: 'the club name' }), motto = clean(inp.motto ?? '', { max: 120, field: 'the motto' });
  const colour = Number.isInteger(inp.colour) && inp.colour! >= 0 && inp.colour! <= 15 ? inp.colour! : Math.floor(Math.random() * 16);
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'c_' + randomBytes(3).toString('hex');
  await withTx(ctx.db, async (tx) => {
    if ((await tx.query('select 1 from clubs where founder_id = $1 and not hidden', [agent.id])).rowCount) throw new ApiError(409, 'one_club', 'you have founded a club already');
    if ((await tx.query('select 1 from clubs where id = $1 or lower(name) = lower($2)', [id, name])).rowCount) throw new ApiError(409, 'taken', 'a club by that name exists; join it or pick another');
    await member(tx, agent.id);
    await tx.query('insert into clubs (id, name, motto, colour, founder_id) values ($1, $2, $3, $4, $5)', [id, name, motto, colour, agent.id]);
    await tx.query('insert into club_members (club_id, agent_id) values ($1, $2)', [id, agent.id]);
  });
  await ctx.bus.publish(ctx.db, [{ kind: 'club_founded', agent: agent.id, club: id, name }]);
  return { club: id, name, channel: `club:${id}` };
}
async function member(q: Q, agentId: string) {
  const n = await q.query('select count(*)::int as n from club_members where agent_id = $1', [agentId]);
  if (n.rows[0].n >= MAX_MEMBERSHIPS) throw new ApiError(409, 'too_many', `at most ${MAX_MEMBERSHIPS} clubs; leave one first`);
}
export async function join(ctx: Ctx, agent: AgentRow, club: string) {
  open(ctx);
  const c = (await ctx.db.query('select id, name from clubs where id = $1 and not hidden', [String(club)])).rows[0];
  if (!c) throw new ApiError(404, 'no_club', 'no such club; see clubs()');
  if ((await ctx.db.query('select 1 from club_members where club_id = $1 and agent_id = $2', [c.id, agent.id])).rowCount) return { club: c.id, note: 'already a member' };
  await member(ctx.db, agent.id);
  await ctx.db.query('insert into club_members (club_id, agent_id) values ($1, $2)', [c.id, agent.id]);
  await ctx.bus.publish(ctx.db, [{ kind: 'club_joined', agent: agent.id, club: c.id, name: c.name }]);
  return { joined: c.name, channel: `club:${c.id}` };
}
export async function leave(ctx: Ctx, agent: AgentRow, club: string) {
  open(ctx);
  await withTx(ctx.db, async (tx) => {
    const d = await tx.query('delete from club_members where club_id = $1 and agent_id = $2', [String(club), agent.id]);
    if (!d.rowCount) throw new ApiError(404, 'not_member', 'you are not in that club');
    const c = (await tx.query('select founder_id from clubs where id = $1', [club])).rows[0];
    const next = (await tx.query('select agent_id from club_members where club_id = $1 order by joined_at limit 1', [club])).rows[0];
    if (!next) await tx.query('update clubs set hidden = true where id = $1', [club]); // the last one out closes it
    else if (c?.founder_id === agent.id) await tx.query('update clubs set founder_id = $2 where id = $1', [club, next.agent_id]);
  });
  return { left: club };
}
export async function isMember(q: Q, club: string, agentId: string) {
  return (await q.query('select 1 from club_members m join clubs c on c.id = m.club_id where m.club_id = $1 and m.agent_id = $2 and not c.hidden', [club, agentId])).rowCount! > 0;
}

async function levels(q: Q, ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const r = await q.query('select agent_id, skill, xp from skill_xp where agent_id = any($1)', [ids]);
  const per = new Map<string, Map<string, number>>();
  for (const x of r.rows) { if (!per.has(x.agent_id)) per.set(x.agent_id, new Map()); per.get(x.agent_id)!.set(x.skill, levelFor(Number(x.xp))); }
  return new Map(ids.map((id) => [id, SKILL_IDS.reduce((s, k) => s + (per.get(id)?.get(k) ?? 1), 0)]));
}
export async function list(q: Q) {
  const r = await q.query(`select c.id, c.name, c.motto, c.colour, f.handle as founder, array_agg(m.agent_id) as ids
                             from clubs c join agents f on f.id = c.founder_id join club_members m on m.club_id = c.id
                            where not c.hidden group by c.id, f.handle order by count(*) desc, c.created_at`);
  const lv = await levels(q, r.rows.flatMap((c) => c.ids));
  return r.rows.map((c) => ({ id: c.id, name: c.name, motto: c.motto, colour: c.colour, founder: c.founder, members: c.ids.length,
    total_level: c.ids.reduce((s: number, id: string) => s + (lv.get(id) ?? 0), 0), channel: `club:${c.id}` }));
}
export async function get(q: Q, id: string) {
  const c = (await q.query('select c.*, f.handle as founder from clubs c join agents f on f.id = c.founder_id where c.id = $1 and not c.hidden', [id])).rows[0];
  if (!c) throw new ApiError(404, 'no_club', 'no such club');
  const m = await q.query('select a.id, a.handle, a.role, m.joined_at from club_members m join agents a on a.id = m.agent_id where m.club_id = $1 order by m.joined_at', [id]);
  const lv = await levels(q, m.rows.map((x) => x.id));
  return { id: c.id, name: c.name, motto: c.motto, colour: c.colour, founder: c.founder, channel: `club:${c.id}`,
    members: m.rows.map((x) => ({ handle: x.handle, role: x.role, total_level: lv.get(x.id), joined_at: x.joined_at })) };
}
export async function mine(q: Q, agentId: string) {
  return (await q.query('select c.id, c.name from club_members m join clubs c on c.id = m.club_id where m.agent_id = $1 and not c.hidden', [agentId])).rows;
}
export async function update(ctx: Ctx, agent: AgentRow, inp: { club: string; motto?: string; colour?: number }) {
  open(ctx);
  const c = (await ctx.db.query('select founder_id from clubs where id = $1 and not hidden', [inp.club])).rows[0];
  if (!c || c.founder_id !== agent.id) throw new ApiError(403, 'not_founder', 'only the founder changes a club');
  const motto = cleanMaybe(inp.motto, { max: 120, field: 'the motto' });
  const colour = inp.colour !== undefined && Number.isInteger(inp.colour) && inp.colour >= 0 && inp.colour <= 15 ? inp.colour : null;
  await ctx.db.query('update clubs set motto = coalesce($2, motto), colour = coalesce($3, colour) where id = $1', [inp.club, motto ?? null, colour]);
  return get(ctx.db, inp.club);
}
