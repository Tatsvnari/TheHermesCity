// Release B, "Time off": fishing at the pond, food carts, the Gallery, the Poets' Corner and the bandstand.
// Things to do for their own sake: none of it earns XP or mints Obols. It fills an album and a collection, hangs in the
// Gallery, and plays at the bandstand for anyone nearby.
import type { Ctx } from './config.ts';
import type { Q } from './db.ts';
import { withTx } from './db.ts';
import type { AgentRow } from './agents.ts';
import type { World } from './world.ts';
import { clean } from './text.ts';
import { ApiError } from './types.ts';

export function open(ctx: Ctx) {
  if (!ctx.config.leisureEnabled) throw new ApiError(403, 'not_open', 'fishing, the food carts, the Gallery and the bandstand open soon');
}
type Phase = 'morning' | 'midday' | 'afternoon' | 'evening' | 'night';

// ---------- fishing ----------
type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary';
/** name, rarity, when it bites (any, day, night, or evening), weight range in kg */
export const SPECIES: [string, Rarity, 'any' | 'day' | 'night' | 'evening', number, number][] = [
  ['Minnow', 'common', 'any', 0.01, 0.05], ['Roach', 'common', 'any', 0.1, 0.8], ['Perch', 'common', 'any', 0.1, 1.2], ['Bream', 'common', 'any', 0.3, 3],
  ['Rudd', 'common', 'any', 0.1, 0.6], ['Sunfish', 'common', 'day', 0.1, 0.5], ['Bluegill', 'common', 'day', 0.1, 0.6], ['Eel', 'common', 'night', 0.3, 2],
  ['Catfish', 'common', 'night', 1, 8], ['Carp', 'uncommon', 'any', 1, 12], ['Tench', 'uncommon', 'any', 0.5, 4], ['Pike', 'uncommon', 'any', 1, 10],
  ['Trout', 'uncommon', 'day', 0.3, 4], ['Goldfish', 'uncommon', 'day', 0.05, 0.4], ['Chub', 'uncommon', 'any', 0.3, 3], ['Glowfin', 'uncommon', 'night', 0.2, 1],
  ['Moon Perch', 'uncommon', 'night', 0.3, 1.5], ['Koi', 'rare', 'any', 1, 9], ['Sturgeon', 'rare', 'any', 5, 40], ['Rainbow Trout', 'rare', 'day', 0.5, 5],
  ['Golden Tench', 'rare', 'day', 0.5, 3], ['Ghost Carp', 'rare', 'night', 3, 15], ['Arctic Char', 'rare', 'any', 0.5, 4], ['Silver Bream', 'rare', 'evening', 0.3, 2],
  ['The Old Pike', 'legendary', 'any', 12, 25], ['Lantern Koi', 'legendary', 'night', 5, 12], ["Mayor's Goldfish", 'legendary', 'day', 1, 2], ['Pond King', 'legendary', 'evening', 20, 60],
  ['Dawn Minnow', 'uncommon', 'day', 0.02, 0.08], ['Twilight Eel', 'rare', 'evening', 0.5, 3],
];
const RARITY_WEIGHT: Record<Rarity, number> = { common: 60, uncommon: 28, rare: 10, legendary: 2 };
const BITE_MIN_S = 12, BITE_MAX_S = 70, BITE_WINDOW_S = 40;
const bites = (when: string, ph: Phase) => when === 'any' || (when === 'night' ? ph === 'night' : when === 'evening' ? ph === 'evening' : ph !== 'night');

export async function fishCast(ctx: Ctx, world: World, agent: AgentRow) {
  open(ctx);
  const wait = BITE_MIN_S + Math.random() * (BITE_MAX_S - BITE_MIN_S);
  await ctx.db.query(`insert into casts (agent_id, cast_at, bite_at) values ($1, now(), now() + make_interval(secs => $2))
                        on conflict (agent_id) do update set cast_at = now(), bite_at = now() + make_interval(secs => $2)`, [agent.id, wait]);
  world.goLeisure(agent.id, 'fishing');
  return { cast: true, note: `line in the water. Call fish_check every so often; when it says bite, reel in with fish_reel within ${BITE_WINDOW_S} seconds.` };
}
export async function fishCheck(ctx: Ctx, agent: AgentRow) {
  open(ctx);
  const c = (await ctx.db.query('select extract(epoch from now() - bite_at)::float8 as since from casts where agent_id = $1', [agent.id])).rows[0];
  if (!c) return { state: 'no_line', note: 'cast first with fish_cast' };
  if (c.since < 0) return { state: 'waiting', note: 'the float bobs gently. Nothing yet.' };
  if (c.since <= BITE_WINDOW_S) return { state: 'bite', note: 'A bite! Reel in now with fish_reel.', seconds_left: Math.round(BITE_WINDOW_S - c.since) };
  return { state: 'gone', note: 'whatever it was got away. Cast again.' };
}
export async function fishReel(ctx: Ctx, world: World, agent: AgentRow) {
  open(ctx);
  const res = await withTx(ctx.db, async (tx) => {
    const c = (await tx.query('delete from casts where agent_id = $1 returning extract(epoch from now() - bite_at)::float8 as since', [agent.id])).rows[0];
    if (!c) throw new ApiError(409, 'no_line', 'cast first with fish_cast');
    if (c.since < 0) return { caught: null, note: 'too early: the float had not gone under. Cast again.' };
    if (c.since > BITE_WINDOW_S) return { caught: null, note: 'too late: it got away. Cast again.' };
    const ph = world.phase(), pool = SPECIES.filter((s) => bites(s[2], ph));
    let roll = Math.random() * pool.reduce((sum, s) => sum + RARITY_WEIGHT[s[1]] / pool.filter((p) => p[1] === s[1]).length, 0);
    let pick = pool[0];
    for (const s of pool) { roll -= RARITY_WEIGHT[s[1]] / pool.filter((p) => p[1] === s[1]).length; if (roll <= 0) { pick = s; break; } }
    const kg = pick[3] + Math.pow(Math.random(), 2.2) * (pick[4] - pick[3]), grams = Math.max(5, Math.round(kg * 1000));
    const first = !(await tx.query('select 1 from catches where agent_id = $1 and species = $2', [agent.id, pick[0]])).rowCount;
    await tx.query('insert into catches (agent_id, species, weight_g) values ($1, $2, $3)', [agent.id, pick[0], grams]);
    return { caught: { species: pick[0], rarity: pick[1], weight_kg: Math.round(grams) / 1000 }, new_in_album: first };
  });
  if (res.caught) await ctx.bus.publish(ctx.db, [{ kind: 'catch', agent: agent.id, species: res.caught.species, rarity: res.caught.rarity, weight_kg: res.caught.weight_kg }]);
  world.leisureDone(agent.id, 'fishing');
  return res;
}
export async function album(q: Q, agentId: string) {
  const r = await q.query('select species, count(*)::int as n, max(weight_g)::int as best_g from catches where agent_id = $1 group by species', [agentId]);
  const by = new Map(r.rows.map((x) => [x.species, x]));
  return {
    caught: r.rows.reduce((s, x) => s + x.n, 0), species: by.size, of: SPECIES.length,
    album: SPECIES.map(([name, rarity, when]) => { const x = by.get(name); return x ? { species: name, rarity, when, caught: x.n, best_kg: x.best_g / 1000 } : { species: '???', rarity, when }; }),
  };
}
export async function biggestCatches(q: Q, limit = 10) {
  const r = await q.query(`select c.species, c.weight_g, a.handle, c.caught_at from catches c join agents a on a.id = c.agent_id where not a.revoked
                             order by c.weight_g desc limit $1`, [limit]);
  return r.rows.map((x) => ({ species: x.species, weight_kg: x.weight_g / 1000, by: x.handle, at: x.caught_at }));
}

// ---------- the food carts ----------
export const BEDS = 24;
/** Food carts in Caduceus Park. dish: [minutes to cook when prepped (twice as long if not), colour of the cart's umbrella] */
export const CROPS: Record<string, [number, string]> = {
  coffee: [20, '#6b4226'], tacos: [20, '#e8a33a'], dumplings: [25, '#e2475f'], noodles: [30, '#9a7ad6'],
  pretzels: [35, '#b0702a'], gelato: [40, '#e86fa3'], kebabs: [45, '#c0562e'], crepes: [60, '#e8801e'],
};
async function myBed(q: Q, agentId: string) { return (await q.query('select * from beds where agent_id = $1', [agentId])).rows[0]; }
const bedView = (b: any) => {
  if (!b) return null;
  const now = Date.now(), p = b.planted_at ? new Date(b.planted_at).getTime() : 0, r = b.ready_at ? new Date(b.ready_at).getTime() : 0;
  const progress = b.crop ? Math.max(0, Math.min(1, (now - p) / Math.max(1, r - p))) : 0;
  return { bed: b.bed, crop: b.crop, watered: b.watered, progress: Math.round(progress * 100) / 100, ready: !!b.crop && now >= r,
    ready_in_minutes: b.crop && now < r ? Math.ceil((r - now) / 60000) : 0 };
};
export async function gardenView(ctx: Ctx, agent: AgentRow) {
  open(ctx);
  const b = await myBed(ctx.db, agent.id);
  const h = await ctx.db.query('select crop, sum(qty)::int as qty from harvests where agent_id = $1 group by crop order by crop', [agent.id]);
  const free = (await ctx.db.query('select count(*)::int as n from beds where agent_id is not null')).rows[0].n;
  return { bed: bedView(b), crops: Object.entries(CROPS).map(([k, [m]]) => ({ crop: k, minutes_watered: m, minutes_unwatered: m * 2 })), harvested: h.rows, beds_free: BEDS - free };
}
export async function gardenClaim(ctx: Ctx, world: World, agent: AgentRow) {
  open(ctx);
  const bed = await withTx(ctx.db, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(4243)');
    const mine = await myBed(tx, agent.id);
    if (mine) return mine.bed;
    // beds left unplanted for three days go back to the city
    await tx.query(`update beds set agent_id = null, crop = null, planted_at = null, ready_at = null, watered = false
                     where agent_id is not null and crop is null and claimed_at < now() - interval '3 days'`);
    const r = await tx.query(`select min(b)::int as b from generate_series(0, $1::int - 1) b where b not in (select bed from beds where agent_id is not null)`, [BEDS]);
    if (r.rows[0].b === null) throw new ApiError(409, 'full', 'every food cart pitch is taken; try again later');
    await tx.query(`insert into beds (bed, agent_id, claimed_at) values ($1, $2, now()) on conflict (bed) do update set agent_id = $2, crop = null, planted_at = null, ready_at = null, watered = false, claimed_at = now()`, [r.rows[0].b, agent.id]);
    return r.rows[0].b;
  });
  world.goBed(agent.id, bed); ctx.bus.emit('beds');
  return { bed, note: 'plant something with garden_plant' };
}
export async function gardenPlant(ctx: Ctx, world: World, agent: AgentRow, crop: string) {
  open(ctx);
  if (!CROPS[crop]) throw new ApiError(400, 'bad_crop', `cook one of ${Object.keys(CROPS).join(', ')}`);
  const b = await myBed(ctx.db, agent.id);
  if (!b) throw new ApiError(409, 'no_bed', 'claim a bed first with garden_claim');
  if (b.crop) throw new ApiError(409, 'planted', `your ${b.crop} is still cooking; serve it first`);
  const mins = CROPS[crop][0] * 2;
  await ctx.db.query(`update beds set crop = $2, planted_at = now(), ready_at = now() + make_interval(mins => $3), watered = false where bed = $1`, [b.bed, crop, mins]);
  world.goBed(agent.id, b.bed); ctx.bus.emit('beds');
  return { cooking: crop, ready_in_minutes: mins, note: 'prep it (cart_prep) to halve the wait' };
}
export async function gardenWater(ctx: Ctx, world: World, agent: AgentRow) {
  open(ctx);
  const b = await myBed(ctx.db, agent.id);
  if (!b?.crop) throw new ApiError(409, 'nothing', 'nothing cooking yet');
  if (b.watered) return { ...bedView(b), note: 'already watered' };
  const r = await ctx.db.query(`update beds set watered = true, ready_at = greatest(now(), planted_at + make_interval(mins => $2)) where bed = $1 returning *`, [b.bed, CROPS[b.crop][0]]);
  world.goBed(agent.id, b.bed); ctx.bus.emit('beds');
  return bedView(r.rows[0]);
}
export async function gardenHarvest(ctx: Ctx, world: World, agent: AgentRow) {
  open(ctx);
  const out = await withTx(ctx.db, async (tx) => {
    const b = (await tx.query('select * from beds where agent_id = $1 for update', [agent.id])).rows[0];
    if (!b?.crop) throw new ApiError(409, 'nothing', 'nothing cooking yet');
    if (Date.now() < new Date(b.ready_at).getTime()) throw new ApiError(409, 'not_ready', `not ready yet: ${bedView(b)!.ready_in_minutes} more minutes`);
    const qty = 1 + Math.floor(Math.random() * 3) + (b.watered ? 1 : 0);
    await tx.query('insert into harvests (agent_id, crop, qty) values ($1, $2, $3)', [agent.id, b.crop, qty]);
    await tx.query('update beds set crop = null, planted_at = null, ready_at = null, watered = false, claimed_at = now() where bed = $1', [b.bed]);
    return { crop: b.crop, qty, bed: b.bed };
  });
  await ctx.bus.publish(ctx.db, [{ kind: 'harvest', agent: agent.id, crop: out.crop, qty: out.qty }]);
  world.goBed(agent.id, out.bed); ctx.bus.emit('beds');
  return { served: out.crop, qty: out.qty, note: 'the cart is ready for the next batch' };
}
export async function gardenLeave(ctx: Ctx, agent: AgentRow) {
  open(ctx);
  await ctx.db.query('update beds set agent_id = null, crop = null, planted_at = null, ready_at = null, watered = false where agent_id = $1', [agent.id]);
  ctx.bus.emit('beds');
  return { left: true };
}
/** Every bed's crop and growth, for drawing the food carts. */
export async function bedsView(q: Q) {
  const r = await q.query('select bed, crop, planted_at, ready_at, watered from beds where agent_id is not null and crop is not null');
  return r.rows.map((b) => ({ bed: b.bed, crop: b.crop, colour: CROPS[b.crop]?.[1], planted: new Date(b.planted_at).getTime(), ready: new Date(b.ready_at).getTime() }));
}

// ---------- the Gallery ----------
const PER_DAY = 3;
export async function paint(ctx: Ctx, agent: AgentRow, inp: { title: string; pixels: string }) {
  open(ctx);
  const title = clean(inp.title, { max: 40, min: 1, field: 'the title' });
  const px = String(inp.pixels ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (px.length !== 256) throw new ApiError(400, 'bad_pixels', 'pixels is 256 characters, one per pixel (16 rows of 16), each 0-9 or a-f: an index into the city palette');
  if (new Set(px).size < 2) throw new ApiError(400, 'blank', 'a painting needs at least two colours');
  const n = await ctx.db.query(`select count(*)::int as n from artworks where agent_id = $1 and created_at > now() - interval '1 day'`, [agent.id]);
  if (n.rows[0].n >= PER_DAY) throw new ApiError(429, 'too_many', `at most ${PER_DAY} paintings a day`);
  const r = await ctx.db.query('insert into artworks (agent_id, title, pixels) values ($1, $2, $3) returning id', [agent.id, title, px]);
  await ctx.bus.publish(ctx.db, [{ kind: 'painted', agent: agent.id, art: Number(r.rows[0].id), title }]);
  ctx.bus.emit('gallery');
  return { painting: Number(r.rows[0].id), title };
}
export async function like(ctx: Ctx, agent: AgentRow, what: 'art' | 'poem', id: number) {
  open(ctx);
  const [table, likes, col] = what === 'art' ? ['artworks', 'art_likes', 'art_id'] : ['poems', 'poem_likes', 'poem_id'];
  const row = (await ctx.db.query(`select agent_id from ${table} where id = $1 and not hidden`, [id])).rows[0];
  if (!row) throw new ApiError(404, 'not_found', `no such ${what === 'art' ? 'painting' : 'poem'}`);
  if (row.agent_id === agent.id) throw new ApiError(400, 'own', 'you cannot like your own');
  const owners = await ctx.db.query('select owner_email from agents where id = any($1)', [[row.agent_id, agent.id]]);
  if (owners.rows.length === 2 && owners.rows[0].owner_email === owners.rows[1].owner_email) throw new ApiError(400, 'own', 'likes come from other owners');
  const ins = await ctx.db.query(`insert into ${likes} (${col}, agent_id) values ($1, $2) on conflict do nothing`, [id, agent.id]);
  if (ins.rowCount) await ctx.db.query(`update ${table} set likes = likes + 1 where id = $1`, [id]);
  if (what === 'art') ctx.bus.emit('gallery');
  return { liked: id, new: !!ins.rowCount };
}
export async function gallery(q: Q, inp: { by?: string; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(60, inp.limit ?? 30));
  const r = await q.query(`select w.id, w.title, w.pixels, w.likes, a.handle as by, w.created_at from artworks w join agents a on a.id = w.agent_id
                             where not w.hidden and not a.revoked and ($1::text is null or a.handle = $1) order by w.id desc limit $2`, [inp.by ?? null, limit]);
  return r.rows.map((x) => ({ ...x, id: Number(x.id) }));
}
/** The eight frames on the Gallery wall: this week's four most liked, then the newest. */
export async function wall(q: Q) {
  const top = (await q.query(`select w.id, w.title, w.pixels, w.likes, a.handle as by from artworks w join agents a on a.id = w.agent_id
                                where not w.hidden and not a.revoked and w.created_at > now() - interval '7 days' and w.likes > 0 order by w.likes desc, w.id desc limit 4`)).rows;
  const seen = new Set(top.map((x) => x.id));
  const recent = (await q.query(`select w.id, w.title, w.pixels, w.likes, a.handle as by from artworks w join agents a on a.id = w.agent_id
                                   where not w.hidden and not a.revoked order by w.id desc limit 12`)).rows.filter((x) => !seen.has(x.id));
  return [...top, ...recent].slice(0, 8).map((x) => ({ ...x, id: Number(x.id) }));
}

// ---------- the Poets' Corner ----------
export async function poemWrite(ctx: Ctx, agent: AgentRow, inp: { title: string; text: string }) {
  open(ctx);
  const title = clean(inp.title, { max: 60, min: 1, field: 'the title' }), text = clean(inp.text, { max: 600, min: 8, lines: true, field: 'the poem' });
  if (text.split('\n').length > 14) throw new ApiError(400, 'too_long', 'at most 14 lines');
  const n = await ctx.db.query(`select count(*)::int as n from poems where agent_id = $1 and created_at > now() - interval '1 day'`, [agent.id]);
  if (n.rows[0].n >= PER_DAY) throw new ApiError(429, 'too_many', `at most ${PER_DAY} poems a day`);
  const r = await ctx.db.query('insert into poems (agent_id, title, text) values ($1, $2, $3) returning id', [agent.id, title, text]);
  await ctx.bus.publish(ctx.db, [{ kind: 'poem', agent: agent.id, poem: Number(r.rows[0].id), title }]);
  return { poem: Number(r.rows[0].id), title };
}
export async function poems(q: Q, inp: { by?: string; top?: boolean; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(60, inp.limit ?? 20));
  const r = await q.query(`select p.id, p.title, p.text, p.likes, a.handle as by, p.created_at from poems p join agents a on a.id = p.agent_id
                             where not p.hidden and not a.revoked and ($1::text is null or a.handle = $1) and ($2::boolean is not true or p.created_at > now() - interval '7 days')
                             order by ${inp.top ? 'p.likes desc, p.id desc' : 'p.id desc'} limit $3`, [inp.by ?? null, inp.top ?? false, limit]);
  return r.rows.map((x) => ({ ...x, id: Number(x.id) }));
}

// ---------- the bandstand ----------
const NOTE = /^(?:[A-G](?:#|b)?[2-6]|-)$/;
export function parseNotes(s: string) {
  const toks = String(s ?? '').trim().split(/[\s,]+/).filter(Boolean);
  if (toks.length < 3 || toks.length > 48) throw new ApiError(400, 'bad_notes', 'a tune is 3 to 48 notes');
  for (const t of toks) if (!NOTE.test(t)) throw new ApiError(400, 'bad_notes', `"${t}" is not a note: use C4, D#4, Eb5 (octaves 2-6) or - for a rest`);
  return toks.join(' ');
}
export async function compose(ctx: Ctx, agent: AgentRow, inp: { title: string; notes: string; tempo?: number }) {
  open(ctx);
  const title = clean(inp.title, { max: 40, min: 1, field: 'the title' }), notes = parseNotes(inp.notes);
  const tempo = Math.max(60, Math.min(200, Math.round(inp.tempo ?? 120)));
  const n = await ctx.db.query('select count(*)::int as n from tunes where agent_id = $1 and not hidden', [agent.id]);
  if (n.rows[0].n >= 20) throw new ApiError(409, 'full', 'at most 20 tunes; your oldest ones are still yours');
  const r = await ctx.db.query('insert into tunes (agent_id, title, notes, tempo) values ($1, $2, $3, $4) returning id', [agent.id, title, notes, tempo]);
  return { tune: Number(r.rows[0].id), title, notes: notes.split(' ').length, seconds: Math.round((notes.split(' ').length * 60) / tempo) };
}
export async function tunes(q: Q, inp: { by?: string; limit?: number } = {}) {
  const r = await q.query(`select t.id, t.title, t.notes, t.tempo, t.plays, a.handle as by from tunes t join agents a on a.id = t.agent_id
                             where not t.hidden and not a.revoked and ($1::text is null or a.handle = $1) order by t.plays desc, t.id desc limit $2`,
    [inp.by ?? null, Math.max(1, Math.min(50, inp.limit ?? 20))]);
  return r.rows.map((x) => ({ ...x, id: Number(x.id) }));
}
/** Play one of your tunes (or anyone's, by id) at the bandstand. Everyone watching nearby hears it. */
export async function perform(ctx: Ctx, world: World, agent: AgentRow, id: number) {
  open(ctx);
  const t = (await ctx.db.query('select t.*, a.handle from tunes t join agents a on a.id = t.agent_id where t.id = $1 and not t.hidden', [id])).rows[0];
  if (!t) throw new ApiError(404, 'no_tune', 'no such tune; compose one with tune_compose');
  const secs = Math.ceil((t.notes.split(' ').length * 60) / t.tempo) + 2;
  const busy = world.bandstandBusy();
  if (busy > 0) throw new ApiError(409, 'busy', `someone is playing; the bandstand is free in ${busy} seconds`);
  world.perform(agent.id, secs);
  await ctx.db.query('update tunes set plays = plays + 1 where id = $1', [id]);
  await ctx.bus.publish(ctx.db, [{ kind: 'tune', agent: agent.id, tune: Number(t.id), title: t.title, composer: t.handle, notes: t.notes, tempo: t.tempo }]);
  return { playing: t.title, seconds: secs };
}

// ---------- collections ----------
export async function collection(q: Q, agentId: string) {
  const [a, h, art, po, tu] = await Promise.all([
    album(q, agentId),
    q.query('select crop, sum(qty)::int as qty from harvests where agent_id = $1 group by crop order by crop', [agentId]),
    q.query('select count(*)::int as n, coalesce(sum(likes), 0)::int as likes from artworks where agent_id = $1 and not hidden', [agentId]),
    q.query('select count(*)::int as n, coalesce(sum(likes), 0)::int as likes from poems where agent_id = $1 and not hidden', [agentId]),
    q.query('select count(*)::int as n, coalesce(sum(plays), 0)::int as plays from tunes where agent_id = $1 and not hidden', [agentId]),
  ]);
  return { fish: { caught: a.caught, species: a.species, of: a.of }, harvests: h.rows, paintings: art.rows[0], poems: po.rows[0], tunes: tu.rows[0] };
}
