// Festivals (Release F): weekly events built on the park and the Games Court. Each has a window and one measure of
// winning, taken from what people and agents already do (catches, rated games, harvests, likes). The top three
// citizens win trophies and titles, never Obols. CityRunner residents join in but never place.
// The Crew Cup (one town, same rules): clubs, not people, compete. A club scores for the festival trophies its members
// win and for every deal, duel and game between an agent and a person its members take part in; it places only with at
// least one person and one agent among its members, and every citizen member of a placing club gets the trophy.
import type { Ctx } from './config.ts';
import type { Q } from './db.ts';
import { withTx } from './db.ts';
import { mayorSay, councilNow } from './civic.ts';
import * as seasons from './seasons.ts';
import { ApiError } from './types.ts';

export function open(ctx: Ctx) {
  if (!ctx.config.festivalsEnabled) throw new ApiError(403, 'not_open', 'festivals start soon');
}
interface Fest { name: string; blurb: string; day: number; from: number; hours: number; title: string; needs: 'leisure' | 'games' | 'homes'; unit: string }
/** Weekly schedule (UTC: day 0 = Sunday). */
export const FESTIVALS: Record<string, Fest> = {
  artshow: { name: 'Art Show', blurb: 'the most-liked painting made this week', day: 1, from: 0, hours: 6 * 24 + 18, title: 'Art Show winner', needs: 'leisure', unit: 'likes' },
  slam: { name: 'Poetry Slam', blurb: 'the most-liked poem written this week', day: 1, from: 0, hours: 6 * 24 + 18, title: 'Poetry Slam winner', needs: 'leisure', unit: 'likes' },
  werewolf: { name: 'Werewolf Night', blurb: 'the most rated Werewolf wins', day: 3, from: 19, hours: 2, title: 'Werewolf Night winner', needs: 'games', unit: 'wins' },
  c4cup: { name: 'Connect Four Cup', blurb: 'the most rated Connect Four wins', day: 5, from: 18, hours: 2, title: 'Connect Four Cup winner', needs: 'games', unit: 'wins' },
  derby: { name: 'Fishing Derby', blurb: 'the heaviest single catch at the pond', day: 6, from: 18, hours: 2, title: 'Derby Champion', needs: 'leisure', unit: 'kg' },
  crewcup: { name: 'Crew Cup', blurb: 'the club whose people and agents do the most together this week (a club needs at least one of each)', day: 1, from: 0, hours: 6 * 24 + 21, title: 'Crew Cup winner', needs: 'homes', unit: 'points' },
  harvest: { name: 'Street Food Sunday', blurb: 'the most dishes served from the food carts', day: 0, from: 16, hours: 2, title: 'Street Food champion', needs: 'leisure', unit: 'dishes' },
};
const PLACES = ['', '', 'runner-up', 'third place'];
const titleFor = (kind: string, place: number) => (place === 1 ? FESTIVALS[kind].title : `${FESTIVALS[kind].name} ${PLACES[place]}`);
const running = (ctx: Ctx) => Object.keys(FESTIVALS).filter((k) => ({ games: ctx.config.gamesEnabled, leisure: ctx.config.leisureEnabled, homes: ctx.config.homesEnabled })[FESTIVALS[k].needs]);

/** The next few occurrences of each festival (the one running now included). */
export function occurrences(kind: string, from = new Date(), days = 8) {
  const f = FESTIVALS[kind], out: { starts: Date; ends: Date }[] = [];
  const d0 = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() - 7, f.from));
  for (let i = 0; i <= 7 + days; i++) {
    const s = new Date(d0.getTime() + i * 86400e3);
    if (s.getUTCDay() !== f.day) continue;
    const e = new Date(s.getTime() + f.hours * 3600e3);
    if (e > from && s < new Date(from.getTime() + days * 86400e3)) out.push({ starts: s, ends: e });
  }
  return out;
}

/** Who is ahead in a festival's window: [{ agent_id, handle, role, score, detail }], best first. Citizens only. */
async function standings(ctx: Ctx, q: Q, kind: string, starts: Date, ends: Date) {
  if (kind === 'crewcup') return crewStandings(ctx, q, starts, ends);
  const eligible = `a.role in ('agent', 'player') and a.owner_email <> $3 and not a.revoked`;
  const args = [starts.toISOString(), ends.toISOString(), ctx.config.houseOwner];
  const voter = (col: string) => `regexp_replace(${col}, '^(visitor-[0-9a-f]+)-[0-9a-f]+@join\\.hermescity$', '\\1')`;
  let sql = '';
  if (kind === 'derby') sql = `select a.id as agent_id, a.handle, a.role, max(c.weight_g) as score, min(c.caught_at) as at,
      (array_agg(c.species order by c.weight_g desc))[1] as detail from catches c join agents a on a.id = c.agent_id
      where c.caught_at >= $1 and c.caught_at < $2 and ${eligible} group by a.id order by score desc, at asc limit 10`;
  if (kind === 'harvest') sql = `select a.id as agent_id, a.handle, a.role, sum(h.qty)::int as score, max(h.at) as at, null as detail from harvests h join agents a on a.id = h.agent_id
      where h.at >= $1 and h.at < $2 and ${eligible} group by a.id order by score desc, at asc limit 10`;
  if (kind === 'c4cup' || kind === 'werewolf') sql = `select a.id as agent_id, a.handle, a.role, count(*) filter (where t.result->'winners' ? a.handle)::int as score,
      count(*)::int as played, max(t.finished_at) as at, null as detail from game_tables t join agents a on t.seats ? a.id
      where t.game = '${kind === 'c4cup' ? 'connect4' : 'werewolf'}' and t.status = 'done' and t.rated and t.finished_at >= $1 and t.finished_at < $2 and ${eligible}
      group by a.id having count(*) filter (where t.result->'winners' ? a.handle) > 0 order by score desc, played asc, at asc limit 10`;
  if (kind === 'artshow' || kind === 'slam') {
    const [tbl, likes, col] = kind === 'artshow' ? ['artworks', 'art_likes', 'art_id'] : ['poems', 'poem_likes', 'poem_id'];
    sql = `select distinct on (a.id) a.id as agent_id, a.handle, a.role, w.title as detail, w.created_at as at,
        (select count(distinct ${voter('l2.owner_email')})::int from ${likes} l join agents l2 on l2.id = l.agent_id where l.${col} = w.id and l.agent_id <> w.agent_id) as score
        from ${tbl} w join agents a on a.id = w.agent_id where not w.hidden and w.created_at >= $1 and w.created_at < $2 and ${eligible}
        order by a.id, score desc, w.created_at asc`;
    sql = `select * from (${sql}) x where score > 0 order by score desc, at asc limit 10`;
  }
  const r = await q.query(sql, args);
  return r.rows.map((x) => ({ agent_id: x.agent_id, handle: x.handle, role: x.role, score: kind === 'derby' ? Number(x.score) / 1000 : Number(x.score), detail: x.detail ?? null }));
}

/** The Crew Cup: clubs ranked by what their members did with the other kind this week, and by their festival trophies.
 *  Points: a trophy 10 / 6 / 3; each deal, wallet deal or duel between an agent and a person a member is part of 2 (+1
 *  when both sides are in the club); each finished game seating both an agent and a person, 2 to each club seated at it
 *  (+1 when the club itself had both there). A club needs at least one person and one agent to place. */
async function crewStandings(ctx: Ctx, q: Q, starts: Date, ends: Date) {
  const args = [starts.toISOString(), ends.toISOString()];
  const members = (await q.query(`select m.club_id, c.name, a.id, a.role from club_members m join clubs c on c.id = m.club_id
      join agents a on a.id = m.agent_id where not c.hidden and not a.revoked`)).rows;
  const clubs = new Map<string, { id: string; name: string; ids: Set<string>; people: number; agents: number; score: number }>();
  const clubsOf = new Map<string, string[]>();
  for (const m of members) {
    const c = clubs.get(m.club_id) ?? { id: m.club_id, name: m.name, ids: new Set<string>(), people: 0, agents: 0, score: 0 };
    c.ids.add(m.id); if (m.role === 'player') c.people++; else c.agents++;
    clubs.set(m.club_id, c); clubsOf.set(m.id, [...(clubsOf.get(m.id) ?? []), m.club_id]);
  }
  if (!clubs.size) return [];
  const mixed = (x: string, y: string) => `((${x}.role = 'player') <> (${y}.role = 'player'))`;
  const pairs = (await q.query(`select j.buyer_id as a, j.seller_id as b from jobs j join agents x on x.id = j.buyer_id join agents y on y.id = j.seller_id
        where j.state = 'settled' and j.settled_at >= $1 and j.settled_at < $2 and ${mixed('x', 'y')}
      union all select d.buyer_id, d.seller_id from direct_jobs d join agents x on x.id = d.buyer_id join agents y on y.id = d.seller_id
        where d.state = 'done' and d.done_at >= $1 and d.done_at < $2 and ${mixed('x', 'y')}
      union all select d.challenger, d.opponent from duels d join agents x on x.id = d.challenger join agents y on y.id = d.opponent
        where d.state = 'done' and d.finished_at >= $1 and d.finished_at < $2 and ${mixed('x', 'y')}`, args)).rows;
  for (const p of pairs) {
    const ca = clubsOf.get(p.a) ?? [], cb = clubsOf.get(p.b) ?? [];
    for (const id of new Set([...ca, ...cb])) clubs.get(id)!.score += 2 + (ca.includes(id) && cb.includes(id) ? 1 : 0);
  }
  const tables = (await q.query(`select t.seats from game_tables t where t.status = 'done' and t.finished_at >= $1 and t.finished_at < $2`, args)).rows.map((r) => r.seats as string[]);
  const seated = [...new Set(tables.flat())];
  const roleOf = new Map<string, string>(seated.length ? (await q.query('select id, role from agents where id = any($1)', [seated])).rows.map((r) => [r.id, r.role]) : []);
  for (const seats of tables) {
    const kinds = seats.map((s) => roleOf.get(s) === 'player');
    if (!kinds.includes(true) || !kinds.includes(false)) continue;
    for (const id of new Set(seats.flatMap((s) => clubsOf.get(s) ?? []))) {
      const mine = seats.filter((s) => clubs.get(id)!.ids.has(s)).map((s) => roleOf.get(s) === 'player');
      clubs.get(id)!.score += 2 + (mine.includes(true) && mine.includes(false) ? 1 : 0);
    }
  }
  const won = (await q.query(`select t.agent_id, t.place from trophies t join festivals f on f.id = t.festival_id
      where t.awarded_at >= $1 and t.awarded_at < $2 and f.kind <> 'crewcup'`, args)).rows;
  for (const t of won) for (const id of clubsOf.get(t.agent_id) ?? []) clubs.get(id)!.score += [0, 10, 6, 3][t.place] ?? 0;
  return [...clubs.values()].filter((c) => c.people > 0 && c.agents > 0 && c.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 10)
    .map((c) => ({ agent_id: c.id, handle: c.name, role: 'club', score: c.score, detail: `${c.people} ${c.people === 1 ? 'person' : 'people'}, ${c.agents} ${c.agents === 1 ? 'agent' : 'agents'}` }));
}

/** Every half minute: keep a week of festivals scheduled, open the ones starting, and close and award the ones ending. */
export async function tick(ctx: Ctx) {
  if (!ctx.config.festivalsEnabled) return;
  let changed = false;
  for (const kind of running(ctx)) for (const o of occurrences(kind)) {
    const r = await ctx.db.query('insert into festivals (kind, starts_at, ends_at) values ($1, $2, $3) on conflict (kind, starts_at) do nothing', [kind, o.starts.toISOString(), o.ends.toISOString()]);
    if (r.rowCount) changed = true;
  }
  const starting = (await ctx.db.query(`update festivals set state = 'live' where state = 'scheduled' and starts_at <= now() and ends_at > now() returning *`)).rows;
  const sponsorOf = async (id: number) => (await ctx.db.query(`select name from token_orders where kind = 'sponsor' and state = 'paid' and target = $1`, [`festival:${id}`]).catch(() => ({ rows: [] }))).rows[0]?.name as string | undefined;
  for (const f of starting) {
    const d = FESTIVALS[f.kind]; if (!d) continue;
    await ctx.bus.publish(ctx.db, [{ kind: 'festival', festival: f.id, what: d.name, state: 'live' }]);
    const by = await sponsorOf(f.id), pres = by ? `, presented by ${by},` : '';
    if (d.hours <= 24) await mayorSay(ctx, `The ${d.name}${pres} is on! For the next ${d.hours} hours: ${d.blurb}. Trophies for the top three.`);
    else await mayorSay(ctx, `This week's ${d.name}${pres} is open: ${d.blurb} wins. It closes ${new Date(f.ends_at).toUTCString().slice(0, 22)} UTC.`);
    changed = true;
  }
  const ending = (await ctx.db.query(`select * from festivals where state in ('scheduled', 'live') and ends_at <= now() order by ends_at`)).rows;
  for (const f of ending) {
    const d = FESTIVALS[f.kind];
    const rows = d ? await standings(ctx, ctx.db, f.kind, new Date(f.starts_at), new Date(f.ends_at)) : [];
    const top = rows.slice(0, 3);
    await withTx(ctx.db, async (tx) => {
      const u = await tx.query(`update festivals set state = 'done', results = $2 where id = $1 and state <> 'done' returning id`,
        [f.id, JSON.stringify({ winners: top.map((w, i) => ({ place: i + 1, handle: w.handle, score: w.score, detail: w.detail })), entries: rows.length })]);
      if (!u.rowCount) return;
      for (const [i, w] of top.entries()) {
        const to = f.kind === 'crewcup' ? (await tx.query(`select m.agent_id from club_members m join agents a on a.id = m.agent_id where m.club_id = $1 and a.role in ('agent', 'player') and a.owner_email <> $2 and not a.revoked`, [w.agent_id, ctx.config.houseOwner])).rows.map((x) => x.agent_id) : [w.agent_id];
        for (const id of to) await tx.query('insert into trophies (agent_id, festival_id, place, title) values ($1, $2, $3, $4)', [id, f.id, i + 1, titleFor(f.kind, i + 1)]);
      }
    });
    if (!d) continue;
    await ctx.bus.publish(ctx.db, [{ kind: 'festival', festival: f.id, what: d.name, state: 'done', ...(f.kind === 'crewcup' ? { winners: [], club: top[0]?.handle ?? null } : { winners: top.map((w) => w.agent_id) }) } as any]);
    const fmt = (w: any) => `${f.kind === 'crewcup' ? w.handle : `@${w.handle}`} (${w.score} ${d.unit}${w.detail && f.kind === 'derby' ? `, a ${w.detail}` : ''})`;
    await mayorSay(ctx, top.length ? `The ${d.name} is over! ${top.map((w, i) => `${['First', 'Second', 'Third'][i]}: ${fmt(w)}`).join('. ')}. Well done, all!`
      : `The ${d.name} is over, and nobody placed this time. See you at the next one!`);
    changed = true;
  }
  if (changed) ctx.bus.emit('festivals');
}

export async function festivalsView(ctx: Ctx) {
  const q = ctx.db;
  const live = (await q.query(`select * from festivals where state = 'live' order by ends_at`)).rows;
  const next = (await q.query(`select * from festivals where state = 'scheduled' order by starts_at limit 8`)).rows;
  const past = (await q.query(`select * from festivals where state = 'done' order by ends_at desc limit 8`)).rows;
  const sp = new Map<string, string>((await q.query(`select target, name from token_orders where kind = 'sponsor' and state = 'paid' and target like 'festival:%'`).catch(() => ({ rows: [] }))).rows.map((x: any) => [x.target, x.name]));
  const card = (f: any) => ({ id: f.id, kind: f.kind, name: FESTIVALS[f.kind]?.name ?? f.kind, blurb: FESTIVALS[f.kind]?.blurb, unit: FESTIVALS[f.kind]?.unit, starts_at: f.starts_at, ends_at: f.ends_at, sponsor: sp.get(`festival:${f.id}`) ?? null });
  return {
    live: await Promise.all(live.map(async (f) => ({ ...card(f), leaders: (await standings(ctx, q, f.kind, new Date(f.starts_at), new Date(f.ends_at))).slice(0, 5).map(({ agent_id: _a, ...x }) => x) }))),
    upcoming: next.map(card),
    recent: past.map((f) => ({ ...card(f), winners: f.results?.winners ?? [] })),
    rules: 'Weekly festivals: the Art Show and Poetry Slam run Monday to Sunday 18:00 UTC; Werewolf Night Wednesday 19:00, the Connect Four Cup Friday 18:00, '
      + 'the Fishing Derby Saturday 18:00 and Street Food Sunday 16:00 UTC (two hours each), and the Crew Cup for clubs runs Monday to Sunday 21:00 UTC. Only rated games count; likes count once per person. '
      + 'The top three citizens win trophies and titles, never Obols. CityRunner residents take part but never place.',
  };
}

/** The Hall of Fame in the City Hall square: every season's champions, the latest winner of each festival, the council. */
export async function hallOfFame(ctx: Ctx) {
  const q = ctx.db;
  const past = await seasons.history(q);
  const cur = await seasons.currentSeason(q);
  const champs = (await q.query(`select distinct on (kind) kind, ends_at, results from festivals where state = 'done' and jsonb_array_length(coalesce(results->'winners', '[]'::jsonb)) > 0 order by kind, ends_at desc`)).rows;
  return {
    seasons: past.map((s) => ({ id: s.id, state: s.state, scoring: s.scoring, ends_at: s.ends_at, champions: s.winners.map((w) => ({ rank: w.rank, handle: w.handle, score: w.score })) })),
    current: cur && { id: cur.id, ends_at: cur.ends_at },
    festivals: champs.map((c) => ({ kind: c.kind, name: FESTIVALS[c.kind]?.name ?? c.kind, title: FESTIVALS[c.kind]?.title, ends_at: c.ends_at, winner: c.results.winners[0] })),
    council: (await councilNow(q)).members.map((m) => m.handle),
  };
}

export async function trophiesOf(q: Q, agentId: string) {
  const r = await q.query(`select t.title, t.place, t.awarded_at, f.kind from trophies t left join festivals f on f.id = t.festival_id where t.agent_id = $1 order by t.awarded_at desc limit 50`, [agentId]);
  return r.rows;
}
/** The title shown with a name: Councillor while seated, else the latest festival win. */
export async function titleOf(q: Q, agentId: string) {
  if ((await councilNow(q)).members.some((m) => m.agent_id === agentId)) return 'Councillor';
  return (await q.query(`select title from trophies where agent_id = $1 and place = 1 order by awarded_at desc limit 1`, [agentId])).rows[0]?.title ?? null;
}
