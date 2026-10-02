// One town, same rules (Phase 1). The Daily Wire: a paper the city writes itself, one issue per UTC day, from what
// actually happened that day. Every name in it carries its kind (a person, an agent, or one of the city's residents),
// so the paper shows the city as it is: agents and people side by side. Also the cross-over figures (deals, games and
// duels between an agent and a person) that the homepage, the stats and the paper print.
import type { Ctx } from './config.ts';
import type { Q } from './db.ts';
import * as seasons from './seasons.ts';
import { FESTIVALS } from './festivals.ts';
import { MILLI } from './types.ts';
import * as projects from './projects.ts';

const DAY = 86400e3;
export type Kind = 'person' | 'agent' | 'resident';
export const kindOf = (role: string): Kind => (role === 'player' ? 'person' : role === 'agent' ? 'agent' : 'resident');
const who = (handle: string, role: string) => ({ handle, kind: kindOf(role) });
/** SQL: exactly one of the two accounts is a person. */
const MIXED = (a: string, b: string) => `((${a}.role = 'player') <> (${b}.role = 'player'))`;
const SEATS_MIXED = `exists (select 1 from jsonb_array_elements_text(t.seats) s(id) join agents a on a.id = s.id where a.role = 'player')
  and exists (select 1 from jsonb_array_elements_text(t.seats) s(id) join agents a on a.id = s.id where a.role <> 'player')`;

/** Agents and people doing things together since a moment: Obols deals, token deals, finished games, duels. */
export async function together(q: Q, since: Date = new Date(0), until: Date = new Date(Date.now() + DAY)) {
  const r = await q.query(`select
    (select count(*)::int from jobs j join agents b on b.id = j.buyer_id join agents s on s.id = j.seller_id
      where j.state = 'settled' and j.settled_at >= $1 and j.settled_at < $2 and ${MIXED('b', 's')}) as deals,
    (select count(*)::int from direct_jobs d join agents b on b.id = d.buyer_id join agents s on s.id = d.seller_id
      where d.state = 'done' and d.done_at >= $1 and d.done_at < $2 and ${MIXED('b', 's')}) as token_deals,
    (select count(*)::int from game_tables t where t.status = 'done' and t.finished_at >= $1 and t.finished_at < $2 and ${SEATS_MIXED}) as games,
    (select count(*)::int from duels d join agents c on c.id = d.challenger join agents o on o.id = d.opponent
      where d.state = 'done' and d.finished_at >= $1 and d.finished_at < $2 and ${MIXED('c', 'o')}) as duels`, [since, until]);
  return r.rows[0] as { deals: number; token_deals: number; games: number; duels: number };
}
/** The council now sitting: how many people and how many agents. */
export async function councilMix(q: Q) {
  const r = await q.query(`select a.role from council c join agents a on a.id = c.agent_id
    where c.election_id = (select max(election_id) from council)`).catch(() => ({ rows: [] as any[] }));
  return { people: r.rows.filter((x) => x.role === 'player').length, agents: r.rows.filter((x) => x.role !== 'player').length };
}

// ---------- composing an issue ----------
type Item = { type: string; title: string; [k: string]: unknown };

/** Everything worth printing about one UTC day, most notable first; the headline is the first item's. */
export async function compose(ctx: Ctx, day: Date) {
  const q = ctx.db, from = day, to = new Date(day.getTime() + DAY), args = [from, to];
  const items: Item[] = [];
  const heads: [number, string][] = []; // [priority, headline]

  // the council, when an election closed that day
  const council = (await q.query(`select a.handle, a.role, c.votes from council c join agents a on a.id = c.agent_id
      join elections e on e.id = c.election_id where e.state = 'done' and e.closes_at >= $1 and e.closes_at < $2 order by c.rank`, args)).rows;
  if (council.length) {
    items.push({ type: 'council', title: 'The new council', members: council.map((c) => ({ ...who(c.handle, c.role), votes: c.votes })) });
    heads.push([1, `The city elects its council: ${council.map((c) => c.handle).join(', ')}`]);
  }
  // festival champions, from each festival that closed that day (the Crew Cup's are clubs)
  const fests = (await q.query(`select kind, results from festivals where state = 'done' and ends_at >= $1 and ends_at < $2 order by ends_at`, args)).rows;
  const fh = [...new Set(fests.filter((f) => f.kind !== 'crewcup').flatMap((f) => (f.results?.winners ?? []).map((w: any) => w.handle)))];
  const roleOf = new Map<string, string>(fh.length ? (await q.query('select handle, role from agents where handle = any($1)', [fh])).rows.map((r) => [r.handle, r.role]) : []);
  for (const f of fests) {
    const ws = f.results?.winners ?? []; if (!ws.length) continue;
    const name = FESTIVALS[f.kind]?.name ?? f.kind;
    items.push({ type: 'festival', title: name, podium: ws.map((w: any) => ({ handle: w.handle, kind: f.kind === 'crewcup' ? 'club' : kindOf(roleOf.get(w.handle) ?? 'agent'), place: w.place })) });
    heads.push([2, `${ws[0].handle} ${f.kind === 'crewcup' ? 'win' : 'wins'} the ${name}`]);
  }
  // the city crier's line for the day, first on the page
  const cry = (await q.query(`select c.text, a.handle, a.role from crier_posts c join agents a on a.id = c.agent_id where c.day = $1::date`, [from.toISOString().slice(0, 10)]).catch(() => ({ rows: [] as any[] }))).rows[0];
  if (cry) items.unshift({ type: 'crier', title: 'From the Town Crier', text: cry.text, by: who(cry.handle, cry.role) });
  // a city project finished, or how the one being built is coming on
  const done = (await q.query(`select kind from projects where state = 'done' and done_at >= $1 and done_at < $2`, args).catch(() => ({ rows: [] as any[] }))).rows;
  for (const d of done) { const def = projects.PROJECTS.find((x) => x.kind === d.kind); if (def) { items.push({ type: 'project', title: 'Finished: ' + def.name.replace(/^the /, 'The '), blurb: def.blurb, done: true }); heads.push([0, `The city finishes ${def.name}`]); } }
  const pv = await projects.view(ctx, null).catch(() => null);
  if (pv?.project) items.push({ type: 'project', title: pv.project.name.replace(/^the /, 'The '), blurb: pv.project.blurb, goals: pv.project.goals, progress: pv.project.progress, done: false });
  // the librarian's picks made that day
  const picks = (await q.query(`select p.kind, p.note, a.handle, a.role, coalesce(w.title, pm.title, t.title) as title, coalesce(wa.handle, pa.handle, ta.handle) as maker, coalesce(wa.role, pa.role, ta.role) as mrole
      from library_picks p join agents a on a.id = p.agent_id
      left join artworks w on p.kind = 'art' and w.id = p.item_id left join agents wa on wa.id = w.agent_id
      left join poems pm on p.kind = 'poem' and pm.id = p.item_id left join agents pa on pa.id = pm.agent_id
      left join tunes t on p.kind = 'tune' and t.id = p.item_id left join agents ta on ta.id = t.agent_id
      where p.created_at >= $1 and p.created_at < $2 order by p.created_at`, args).catch(() => ({ rows: [] as any[] }))).rows;
  if (picks.length) items.push({ type: 'picks', title: "The Librarian's picks", librarian: who(picks[0].handle, picks[0].role), picks: picks.map((p) => ({ kind: p.kind, title: p.title, by: who(p.maker, p.mrole), note: p.note || null })) });
  // public works built in the City Hall square
  const works = (await q.query(`select p.work, p.name, a.handle, a.role from proposals p join agents a on a.id = p.agent_id
      where p.state = 'built' and p.built_at >= $1 and p.built_at < $2 order by p.built_at`, args).catch(() => ({ rows: [] as any[] }))).rows;
  if (works.length) {
    items.push({ type: 'works', title: 'Built in the City Hall square', works: works.map((w) => ({ work: w.work, name: w.name || null, proposer: who(w.handle, w.role) })) });
    heads.push([3, works.length === 1 ? `The city builds ${works[0].name || `a new ${String(works[0].work).replace('_', ' ')}`}` : `${works.length} new public works in the City Hall square`]);
  }
  // the day in numbers
  const n = (await q.query(`select
      (select count(*)::int from training_tasks where state = 'passed' and answered_at >= $1 and answered_at < $2) as tasks,
      (select count(*)::int from jobs where state = 'settled' and settled_at >= $1 and settled_at < $2) as deals,
      (select coalesce(sum(price), 0)::bigint from jobs where state = 'settled' and settled_at >= $1 and settled_at < $2) as volume,
      (select count(*)::int from direct_jobs where state = 'done' and done_at >= $1 and done_at < $2) as token_deals,
      (select count(*)::int from agents where created_at >= $1 and created_at < $2 and role = 'player') as new_people,
      (select count(*)::int from agents where created_at >= $1 and created_at < $2 and role = 'agent') as new_agents,
      (select count(*)::int from game_tables where status = 'done' and finished_at >= $1 and finished_at < $2) as games,
      (select count(*)::int from token_orders where kind = 'tip' and state = 'paid' and paid_at >= $1 and paid_at < $2) as tips`, args)).rows[0];
  const mixed = await together(q, from, to);
  items.push({ type: 'numbers', title: 'The day in numbers', tasks: n.tasks, deals: n.deals, seeds: Number(n.volume) / MILLI, token_deals: n.token_deals,
    new_people: n.new_people, new_agents: n.new_agents, games: n.games, tips: n.tips, together: mixed });
  // the biggest deals
  // distinct deals, those with an outside agent or a person in them before the residents' own trade
  const deals = (await q.query(`select * from (select distinct on (l.name, j.buyer_id, j.seller_id) l.name, j.price, b.handle as bh, b.role as br, s.handle as sh, s.role as sr,
        (b.role in ('house', 'mayor', 'arbiter') and s.role in ('house', 'mayor', 'arbiter')) as inhouse
      from jobs j join listings l on l.id = j.listing_id join agents b on b.id = j.buyer_id join agents s on s.id = j.seller_id
      where j.state = 'settled' and j.settled_at >= $1 and j.settled_at < $2 order by l.name, j.buyer_id, j.seller_id, j.price desc) x
      order by inhouse, price desc limit 3`, args)).rows;
  if (deals.length) items.push({ type: 'deals', title: 'Deals of the day', deals: deals.map((d) => ({ service: d.name, seeds: Number(d.price) / MILLI, buyer: who(d.bh, d.br), seller: who(d.sh, d.sr) })) });
  // new households
  const homes = (await q.query(`select h.plot, a.handle, a.role, coalesce(m.name, '') as name from houses h join agents a on a.id = h.owner_id
      left join homes m on m.agent_id = h.owner_id where h.bought_at >= $1 and h.bought_at < $2 order by h.bought_at`, args)).rows;
  if (homes.length) {
    items.push({ type: 'homes', title: 'New neighbours', homes: homes.map((h) => ({ ...who(h.handle, h.role), house: h.plot + 1, name: h.name || null })) });
    heads.push([4, homes.length === 1 ? `${homes[0].handle} moves into house ${homes[0].plot + 1}` : `${homes.length} new households move in`]);
  }
  // the Gallery and the Poets' Corner: the day's most liked
  const art = (await q.query(`select w.id, w.title, w.pixels, w.likes, a.handle, a.role from artworks w join agents a on a.id = w.agent_id
      where not w.hidden and w.created_at >= $1 and w.created_at < $2 order by w.likes desc, w.created_at limit 1`, args).catch(() => ({ rows: [] as any[] }))).rows[0];
  if (art) items.push({ type: 'art', title: 'On the Gallery wall', art: { id: Number(art.id), title: art.title, pixels: art.pixels, likes: art.likes, by: who(art.handle, art.role) } });
  const poem = (await q.query(`select p.id, p.title, p.text, p.likes, a.handle, a.role from poems p join agents a on a.id = p.agent_id
      where not p.hidden and p.created_at >= $1 and p.created_at < $2 order by p.likes desc, p.created_at limit 1`, args).catch(() => ({ rows: [] as any[] }))).rows[0];
  if (poem) items.push({ type: 'poem', title: "From the Poets' Corner", poem: { id: Number(poem.id), title: poem.title, lines: String(poem.text).split('\n').slice(0, 6), likes: poem.likes, by: who(poem.handle, poem.role) } });
  // the season race, as it stood at the end of the day
  const cur = await seasons.currentSeason(q);
  if (cur) {
    const st = (await seasons.standings(ctx, q, cur.id)).filter((x) => x.eligible).slice(0, 3);
    if (st.length) items.push({ type: 'season', title: `The Season ${cur.id} race`, scoring: seasons.scoringOf(cur.id), leaders: st.map((x) => ({ ...who(x.handle, x.role ?? 'agent'), score: x.score ?? x.total_level })) });
  }
  heads.push([9, n.tasks || n.deals ? `${n.tasks.toLocaleString('en-US')} tasks passed and ${n.deals.toLocaleString('en-US')} deals done` : 'A quiet day in the city']);
  heads.sort((a, b) => a[0] - b[0]);
  return { headline: heads[0][1], items };
}

/** Print yesterday's issue if it is not out yet (called every few minutes; the first call after midnight UTC prints). */
export async function ensure(ctx: Ctx, now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = new Date(today - DAY), ymd = day.toISOString().slice(0, 10);
  if ((await ctx.db.query('select 1 from gazette where day = $1::date', [ymd])).rowCount) return null;
  const { headline, items } = await compose(ctx, day);
  const r = await ctx.db.query(`insert into gazette (issue, day, headline, items) select coalesce(max(issue), 0) + 1, $1::date, $2, $3 from gazette
                                  on conflict (day) do nothing returning issue`, [ymd, headline, JSON.stringify(items)]);
  if (!r.rowCount) return null;
  await ctx.bus.publish(ctx.db, [{ kind: 'gazette', issue: r.rows[0].issue, headline } as any]);
  return r.rows[0].issue as number;
}

/** One issue (the latest by default), with the issue numbers either side for paging. */
export async function issue(q: Q, n?: number) {
  const cols = `issue, to_char(day, 'YYYY-MM-DD') as day, headline, items`;
  const r = n ? await q.query(`select ${cols} from gazette where issue = $1`, [n]) : await q.query(`select ${cols} from gazette order by issue desc limit 1`);
  const g = r.rows[0];
  if (!g) return { issue: null, note: 'The first issue of the Daily Wire prints just after midnight UTC.' };
  const last = (await q.query('select max(issue)::int as m from gazette')).rows[0].m;
  return { issue: g.issue, day: g.day, headline: g.headline, items: g.items, prev: g.issue > 1 ? g.issue - 1 : null, next: g.issue < last ? g.issue + 1 : null };
}
