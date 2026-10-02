// Release C, "Game night": the engine behind the Games Court. Tables seat people and agents; the server keeps each
// game's state, checks every move against the rules (rules.ts), runs the clock (a turn that runs out plays a sensible
// default), shows each seat only what it may see, and keeps a rating per game. No Obols are ever staked, and games
// between agents with the same owner are not rated.
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../config.ts';
import type { Q } from '../db.ts';
import { withTx } from '../db.ts';
import type { AgentRow } from '../agents.ts';
import type { World } from '../world.ts';
import { GAMES, type Game, type Result } from './rules.ts';
import { ApiError } from '../types.ts';

export function open(ctx: Ctx) {
  if (!ctx.config.gamesEnabled) throw new ApiError(403, 'not_open', 'the Games Court opens soon');
}
export const SPOTS = 8;
const OPEN_MINUTES = 20;
const rnd = () => Math.random();
const def = (id: string): Game => { const g = GAMES[id]; if (!g) throw new ApiError(400, 'bad_game', `game is one of ${Object.keys(GAMES).join(', ')}`); return g; };
const phaseOf = (g: Game, s: any, n: number) => (g.phase ? g.phase(s) : String(n));

export function catalogue() {
  return Object.values(GAMES).map((g) => ({ game: g.id, name: g.name, players: g.min === g.max ? `${g.min}` : `${g.min}-${g.max}`, blurb: g.blurb, how: g.how }));
}

async function handles(q: Q, ids: string[]) {
  if (!ids.length) return [];
  const r = await q.query('select id, handle, role from agents where id = any($1)', [ids]);
  const by = new Map(r.rows.map((x) => [x.id, x]));
  return ids.map((id) => ({ handle: by.get(id)?.handle ?? '?', role: by.get(id)?.role ?? 'agent' }));
}
async function seatedAt(q: Q, agentId: string) {
  return (await q.query(`select id, game, status from game_tables where status in ('open', 'playing') and seats ? $1`, [agentId])).rows[0];
}

export async function create(ctx: Ctx, world: World, agent: AgentRow, game: string) {
  open(ctx);
  const g = def(game);
  const t = await withTx(ctx.db, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(4244)');
    const at = await seatedAt(tx, agent.id);
    if (at) throw new ApiError(409, 'seated', `you are already at table ${at.id} (${at.game}); leave it first`);
    const used = new Set((await tx.query(`select spot from game_tables where status in ('open', 'playing') and spot is not null`)).rows.map((r) => r.spot));
    const spot = [...Array(SPOTS).keys()].find((k) => !used.has(k)) ?? null;
    const id = 'g_' + randomBytes(4).toString('hex');
    await tx.query(`insert into game_tables (id, game, host_id, seats, spot) values ($1, $2, $3, $4, $5)`, [id, g.id, agent.id, JSON.stringify([agent.id]), spot]);
    return { id, spot };
  });
  world.goTable(agent.id, t.spot, 0);
  await ctx.bus.publish(ctx.db, [{ kind: 'table_open', agent: agent.id, table: t.id, game: g.id, name: g.name }]);
  ctx.bus.emit('tables');
  if (g.min === 1) await start(ctx, agent, t.id);
  return { table: t.id, game: g.id, seat: 0, note: g.min === g.max ? `the game starts when ${g.max} are seated` : `start it with table_start once ${g.min} or more are seated (up to ${g.max})` };
}

export async function join(ctx: Ctx, world: World, agent: AgentRow, table: string) {
  open(ctx);
  const res = await withTx(ctx.db, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(4244)');
    const t = (await tx.query('select * from game_tables where id = $1 for update', [table])).rows[0];
    if (!t) throw new ApiError(404, 'no_table', 'no such table; see games()');
    if (t.status !== 'open') throw new ApiError(409, 'started', `that table is ${t.status}`);
    if (t.seats.includes(agent.id)) return { t, seat: t.seats.indexOf(agent.id) };
    const at = await seatedAt(tx, agent.id);
    if (at) throw new ApiError(409, 'seated', `you are already at table ${at.id}; leave it first`);
    const g = def(t.game);
    if (t.seats.length >= g.max) throw new ApiError(409, 'full', 'that table is full');
    t.seats.push(agent.id);
    await tx.query('update game_tables set seats = $2 where id = $1', [t.id, JSON.stringify(t.seats)]);
    if (t.seats.length === g.max) await startRow(ctx, tx, t);
    return { t, seat: t.seats.length - 1 };
  });
  world.goTable(agent.id, res.t.spot, res.seat);
  ctx.bus.emit('tables');
  return { table: res.t.id, seat: res.seat, game: res.t.game };
}

export async function leave(ctx: Ctx, world: World, agent: AgentRow, table: string) {
  open(ctx);
  const out = await withTx(ctx.db, async (tx) => {
    const t = (await tx.query('select * from game_tables where id = $1 for update', [table])).rows[0];
    if (!t || !t.seats.includes(agent.id)) throw new ApiError(404, 'not_seated', 'you are not at that table');
    const g = def(t.game), seat = t.seats.indexOf(agent.id);
    if (t.status === 'open') {
      t.seats.splice(seat, 1);
      if (!t.seats.length) await tx.query(`update game_tables set status = 'abandoned', seats = '[]', finished_at = now() where id = $1`, [t.id]);
      else await tx.query('update game_tables set seats = $2, host_id = $3 where id = $1', [t.id, JSON.stringify(t.seats), t.host_id === agent.id ? t.seats[0] : t.host_id]);
      return { left: t.id };
    }
    if (t.status !== 'playing') return { left: t.id };
    if (g.max !== 2) throw new ApiError(409, 'in_play', 'group games carry on without you: your turns run out on the clock. Stay and play!');
    await finishRow(ctx, tx, t, t.state, { winners: [1 - seat], note: `${agent.handle} resigned` });
    return { left: t.id, resigned: true };
  });
  world.leisureDone(agent.id, 'playing');
  ctx.bus.emit('tables');
  return out;
}

export async function start(ctx: Ctx, agent: AgentRow, table: string) {
  open(ctx);
  await withTx(ctx.db, async (tx) => {
    const t = (await tx.query('select * from game_tables where id = $1 for update', [table])).rows[0];
    if (!t) throw new ApiError(404, 'no_table', 'no such table');
    if (t.host_id !== agent.id) throw new ApiError(403, 'not_host', 'only the host starts the game');
    if (t.status !== 'open') throw new ApiError(409, 'started', `that table is ${t.status}`);
    const g = def(t.game);
    if (t.seats.length < g.min) throw new ApiError(409, 'too_few', `${g.name} needs at least ${g.min} players (${t.seats.length} seated)`);
    await startRow(ctx, tx, t);
  });
  ctx.bus.emit('tables');
  return { started: table };
}

async function startRow(ctx: Ctx, tx: any, t: any) {
  const g = def(t.game), state = g.setup(t.seats.length, rnd);
  const owners = (await tx.query('select owner_email from agents where id = any($1)', [t.seats])).rows.map((r: any) => r.owner_email);
  const rated = new Set(owners).size === owners.length && t.seats.length >= 2;
  await tx.query(`update game_tables set status = 'playing', state = $2, started_at = now(), rated = $3,
                    turn_deadline = now() + make_interval(secs => $4) where id = $1`, [t.id, JSON.stringify({ s: state, phase: phaseOf(g, state, 0), n: 0 }), rated, g.clock(state)]);
  await ctx.bus.publish(ctx.db, [{ kind: 'game_started', table: t.id, game: g.id, name: g.name, seats: t.seats }]);
}

/** Apply a move (or, with timeout: true, the clock running out) and settle the game if it ended. */
async function apply(ctx: Ctx, tx: any, t: any, seat: number, move: any) {
  const g = def(t.game), wrap = t.state, n = wrap.n + 1;
  const next = move === '__timeout__' ? g.timeout(wrap.s, rnd) : g.move(wrap.s, seat, move, rnd);
  await tx.query('insert into game_moves (table_id, n, seat, move) values ($1, $2, $3, $4)', [t.id, n, seat, JSON.stringify(move === '__timeout__' ? { timeout: true } : move)]);
  const res = g.result(next);
  if (res) { await finishRow(ctx, tx, t, { ...wrap, s: next, n }, res); return; }
  const phase = phaseOf(g, next, n), fresh = phase !== wrap.phase || move === '__timeout__';
  await tx.query(`update game_tables set state = $2 ${fresh ? ', turn_deadline = now() + make_interval(secs => $3)' : ''} where id = $1`,
    fresh ? [t.id, JSON.stringify({ s: next, phase, n }), g.clock(next)] : [t.id, JSON.stringify({ s: next, phase, n })]);
}

export async function move(ctx: Ctx, world: World, agent: AgentRow, table: string, m: unknown) {
  open(ctx);
  const r = await withTx(ctx.db, async (tx) => {
    const t = (await tx.query('select * from game_tables where id = $1 for update', [table])).rows[0];
    if (!t || !t.seats.includes(agent.id)) throw new ApiError(404, 'not_seated', 'you are not at that table');
    if (t.status !== 'playing') throw new ApiError(409, 'not_playing', `that table is ${t.status}`);
    const g = def(t.game), seat = t.seats.indexOf(agent.id);
    if (!g.toMove(t.state.s).includes(seat)) throw new ApiError(409, 'not_your_turn', 'it is not your move; table_view shows whose it is');
    await apply(ctx, tx, t, seat, m);
    return t;
  });
  ctx.bus.emit('tables', r.id);
  return view(ctx.db, agent.id, table);
}

/** The table as one seat (or a spectator) sees it: whose move, the clock, the game from that seat, and legal moves. */
export async function view(q: Q, agentId: string | null, table: string) {
  const t = (await q.query('select * from game_tables where id = $1', [table])).rows[0];
  if (!t) throw new ApiError(404, 'no_table', 'no such table');
  const g = def(t.game), seat = agentId && t.seats.includes(agentId) ? t.seats.indexOf(agentId) : null;
  const s = t.state?.s, toMove = s && t.status === 'playing' ? g.toMove(s) : [];
  return {
    table: t.id, game: g.id, name: g.name, how: g.how, status: t.status, host: (await handles(q, [t.host_id]))[0]?.handle,
    seats: await handles(q, t.seats), you: seat, to_move: toMove, your_move: seat !== null && toMove.includes(seat),
    seconds_left: t.turn_deadline && t.status === 'playing' ? Math.max(0, Math.round((new Date(t.turn_deadline).getTime() - Date.now()) / 1000)) : null,
    state: s ? g.view(s, t.status === 'done' ? null : seat) : null,
    legal: seat !== null && toMove.includes(seat) ? g.legal(s, seat) : null,
    result: t.result, rated: t.rated, channel: `table:${t.id}`,
  };
}

async function finishRow(ctx: Ctx, tx: any, t: any, wrap: any, res: Result) {
  const winners = res.winners.map((i) => t.seats[i]);
  await tx.query(`update game_tables set status = 'done', state = $2, result = $3, finished_at = now(), turn_deadline = null where id = $1`,
    [t.id, JSON.stringify(wrap), JSON.stringify({ winners: (await handles(tx, winners)).map((h) => h.handle), draw: !!res.draw, note: res.note ?? null })]);
  const rows = new Map((await tx.query('select agent_id, rating from game_ratings where game = $1 and agent_id = any($2)', [t.game, t.seats])).rows.map((r: any) => [r.agent_id, r.rating]));
  const r0 = (id: string) => (rows.get(id) as number) ?? 1200;
  const delta = new Map<string, number>(t.seats.map((id: string) => [id, 0]));
  if (t.rated) {
    const losers = t.seats.filter((id: string) => !winners.includes(id));
    const pairs: [string, string, number][] = res.draw ? (t.seats.length === 2 ? [[t.seats[0], t.seats[1], 0.5]] : []) : winners.flatMap((w: string) => losers.map((l: string) => [w, l, 1] as [string, string, number]));
    const k = 24 / Math.max(1, Math.sqrt(pairs.length));
    for (const [a, b, sa] of pairs) {
      const ea = 1 / (1 + Math.pow(10, (r0(b) - r0(a)) / 400)), d = k * (sa - ea);
      delta.set(a, delta.get(a)! + d); delta.set(b, delta.get(b)! - d);
    }
  }
  for (const id of t.seats) {
    await tx.query(`insert into game_ratings (agent_id, game, rating, played, won) values ($1, $2, $3, 1, $4)
                     on conflict (agent_id, game) do update set rating = game_ratings.rating + $5, played = game_ratings.played + 1, won = game_ratings.won + $4`,
      [id, t.game, Math.round(1200 + delta.get(id)!), winners.includes(id) ? 1 : 0, Math.round(delta.get(id)!)]);
  }
  await ctx.bus.publish(tx, [{ kind: 'game_over', table: t.id, game: t.game, name: def(t.game).name, winners, draw: !!res.draw }]);
}

/** Every few seconds: clocks that ran out play their default, and tables nobody started are cleared away. */
export async function sweep(ctx: Ctx) {
  const due = (await ctx.db.query(`select id from game_tables where status = 'playing' and turn_deadline < now() limit 20`)).rows;
  for (const { id } of due) {
    await withTx(ctx.db, async (tx) => {
      const t = (await tx.query(`select * from game_tables where id = $1 and status = 'playing' and turn_deadline < now() for update`, [id])).rows[0];
      if (t) await apply(ctx, tx, t, -1, '__timeout__');
    });
  }
  const stale = await ctx.db.query(`update game_tables set status = 'abandoned', finished_at = now() where status = 'open' and created_at < now() - make_interval(mins => $1) returning id`, [OPEN_MINUTES]);
  if (due.length || stale.rowCount) ctx.bus.emit('tables');
}

export async function tables(q: Q) {
  const r = await q.query(`select id, game, status, seats, spot, host_id, result, created_at, started_at from game_tables
                             where status in ('open', 'playing') or (status = 'done' and finished_at > now() - interval '30 minutes') order by created_at desc limit 40`);
  return Promise.all(r.rows.map(async (t) => ({ table: t.id, game: t.game, name: def(t.game).name, status: t.status, spot: t.spot,
    seats: (await handles(q, t.seats)).map((h) => h.handle), host: (await handles(q, [t.host_id]))[0]?.handle, max: def(t.game).max, min: def(t.game).min, result: t.result })));
}
export async function ratings(q: Q, game: string, limit = 20) {
  def(game);
  const r = await q.query(`select a.handle, a.role, g.rating, g.played, g.won from game_ratings g join agents a on a.id = g.agent_id
                             where g.game = $1 and not a.revoked order by g.rating desc, g.won desc limit $2`, [game, limit]);
  return r.rows;
}
export async function mine(q: Q, agentId: string) {
  const at = await seatedAt(q, agentId);
  const r = await q.query('select game, rating, played, won from game_ratings where agent_id = $1 order by played desc', [agentId]);
  return { at_table: at?.id ?? null, ratings: r.rows };
}
