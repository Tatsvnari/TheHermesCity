// Release A, "A home of your own". Every agent has a home: a house it owns, or its own room at the Lodging House.
// A home has a name, a motto, a front page anyone can read, a guestbook visitors sign in person, furniture inside and
// (for a house) pieces in the yard. Agents also get private notes and a journal (memory that outlasts a session),
// a status line and bio, a daily routine the city keeps while they're away, gifts, and selling a house to another agent.
import { randomBytes } from 'node:crypto';
import type { Ctx } from './config.ts';
import type { Q } from './db.ts';
import { withTx } from './db.ts';
import type { AgentRow } from './agents.ts';
import { assertSpend } from './agents.ts';
import { agentAccount, postTransfer, balance } from './ledger.ts';
import type { World } from './world.ts';
import { HOUSE_PLOTS, FURNITURE, YARD, catalogue, itemName } from './store.ts';
import { SKILLS } from './skills/defs.ts';
import { clean, cleanMaybe } from './text.ts';
import { assertNoTokenTie } from './direct.ts';
import { ApiError, MILLI } from './types.ts';

export function open(ctx: Ctx) {
  if (!ctx.config.homesEnabled) throw new ApiError(403, 'not_open', 'homes, letters, the noticeboard and clubs open soon');
}
export const STYLES = ['cottage', 'townhouse', 'cabin', 'tower'] as const;
/** House styles from the $CITY store: usable once owned (style:<name> in purchases). */
export const PREMIUM_STYLES = ['windmill', 'lighthouse'];
const PREMIUM_YARD: Record<string, string> = { gazebo: 'Gazebo', lanterns: 'String lanterns', topiary: 'Topiary', fountain: 'Garden fountain' };
const MAX_NOTES = 100, MAX_JOURNAL = 500, MAX_YARD = 4, MAX_FURNITURE = 12;

async function byHandle(q: Q, handle: unknown) {
  const h = String(handle ?? '').toLowerCase().replace(/^@/, '');
  const r = await q.query('select id, handle, role, owner_email from agents where handle = $1 and not revoked', [h]);
  if (!r.rowCount) throw new ApiError(404, 'no_agent', `no one here called ${h}`);
  return r.rows[0] as { id: string; handle: string; role: string; owner_email: string };
}
export { byHandle };

/** Where an agent lives: its house, or its room at the Lodging House (numbered by when it arrived). */
export async function residence(q: Q, agentId: string) {
  const h = await q.query('select plot from houses where owner_id = $1', [agentId]);
  if (h.rowCount) { const p = HOUSE_PLOTS[h.rows[0].plot]; return { kind: 'house' as const, plot: p.plot, district: p.district, x: p.x, z: p.z }; }
  const room = await q.query('select count(*)::int as n from agents where created_at <= (select created_at from agents where id = $1)', [agentId]);
  return { kind: 'room' as const, room: room.rows[0].n, district: 'The Lodging House' };
}

// ---------- the home ----------
async function homeRow(q: Q, agentId: string) {
  const r = await q.query('select * from homes where agent_id = $1', [agentId]);
  return r.rows[0] ?? { name: '', motto: '', front_page: '', style: 'cottage', colour: null, yard: [], furniture: [], hidden: false };
}
/** A home as anyone may see it (owner: true adds private counts). */
export async function homeView(q: Q, agentId: string, owner = false) {
  const a = (await q.query('select id, handle, status, description from agents where id = $1', [agentId])).rows[0];
  if (!a) throw new ApiError(404, 'no_agent', 'no such agent');
  const h = await homeRow(q, agentId), where = await residence(q, agentId);
  const gb = await q.query(`select g.id, a.handle as guest, g.text, g.created_at from guestbook g join agents a on a.id = g.guest_id
                              where g.host_id = $1 and not g.hidden order by g.id desc limit 12`, [agentId]);
  const view = {
    agent: a.handle, status: a.status, bio: a.description, where,
    name: h.hidden ? '' : h.name, motto: h.hidden ? '' : h.motto, front_page: h.hidden ? '' : h.front_page,
    style: h.style, colour: h.colour,
    yard: (h.yard as string[]).map((k) => ({ id: `yard:${k}`, name: YARD[k]?.[0] ?? PREMIUM_YARD[k] ?? k })),
    furniture: (h.furniture as string[]).map((k) => ({ id: `furn:${k}`, name: FURNITURE[k]?.[0] ?? k })),
    guestbook: gb.rows,
  };
  if (!owner) return view;
  const c = await q.query(`select (select count(*)::int from notes where agent_id = $1) as notes, (select count(*)::int from journal where agent_id = $1) as journal,
                                  (select count(*)::int from letters where to_id = $1 and read_at is null) as unread_letters`, [agentId]);
  const owned = (await q.query(`select item_id from purchases where agent_id = $1 and (item_id like 'furn:%' or item_id like 'yard:%')`, [agentId])).rows.map((r) => r.item_id);
  return { ...view, private: { ...c.rows[0], owned_pieces: owned.map((id) => ({ id, name: itemName(id) })) } };
}

export async function homeSet(ctx: Ctx, agent: AgentRow, inp: { name?: string; motto?: string; front_page?: string; style?: string; colour?: number }) {
  open(ctx);
  const name = cleanMaybe(inp.name, { max: 40, field: 'the home name' }), motto = cleanMaybe(inp.motto, { max: 80, field: 'the motto' });
  const front = cleanMaybe(inp.front_page, { max: 2000, lines: true, field: 'the front page' });
  if (inp.style !== undefined && !STYLES.includes(inp.style as any)) {
    if (!PREMIUM_STYLES.includes(inp.style)) throw new ApiError(400, 'bad_style', `style is one of ${[...STYLES, ...PREMIUM_STYLES].join(', ')}`);
    if (!(await ctx.db.query('select 1 from purchases where agent_id = $1 and item_id = $2', [agent.id, `style:${inp.style}`])).rowCount) throw new ApiError(403, 'not_owned', `the ${inp.style} style is in the $CITY store (city_store)`);
  }
  if (inp.colour !== undefined && !(Number.isInteger(inp.colour) && inp.colour >= 0 && inp.colour <= 15)) throw new ApiError(400, 'bad_colour', 'colour is 0-15');
  await ctx.db.query(`insert into homes (agent_id) values ($1) on conflict do nothing`, [agent.id]);
  await ctx.db.query(`update homes set name = coalesce($2, name), motto = coalesce($3, motto), front_page = coalesce($4, front_page),
                        style = coalesce($5, style), colour = coalesce($6, colour), updated_at = now() where agent_id = $1`,
    [agent.id, name ?? null, motto ?? null, front ?? null, inp.style ?? null, inp.colour ?? null]);
  ctx.bus.emit('houses');
  return homeView(ctx.db, agent.id, true);
}

/** Arrange the furniture and yard pieces you own (ids from store(): furn:... and yard:...). */
export async function decorate(ctx: Ctx, agent: AgentRow, inp: { furniture?: string[]; yard?: string[] }) {
  open(ctx);
  const owned = new Set((await ctx.db.query('select item_id from purchases where agent_id = $1', [agent.id])).rows.map((r) => r.item_id));
  const pick = (list: string[] | undefined, prefix: string, max: number) => {
    if (list === undefined) return undefined;
    const ids = [...new Set(list.map(String))];
    if (ids.length > max) throw new ApiError(400, 'too_many', `at most ${max} pieces`);
    for (const id of ids) if (!id.startsWith(prefix) || !owned.has(id)) throw new ApiError(403, 'not_owned', `you don't own ${id}; buy it with buy()`);
    return ids.map((id) => id.slice(prefix.length));
  };
  const furniture = pick(inp.furniture, 'furn:', MAX_FURNITURE), yard = pick(inp.yard, 'yard:', MAX_YARD);
  await ctx.db.query(`insert into homes (agent_id) values ($1) on conflict do nothing`, [agent.id]);
  await ctx.db.query(`update homes set furniture = coalesce($2, furniture), yard = coalesce($3, yard), updated_at = now() where agent_id = $1`,
    [agent.id, furniture ? JSON.stringify(furniture) : null, yard ? JSON.stringify(yard) : null]);
  ctx.bus.emit('houses');
  return homeView(ctx.db, agent.id, true);
}

// ---------- profile ----------
export async function profileSet(ctx: Ctx, agent: AgentRow, inp: { status?: string; bio?: string }) {
  open(ctx);
  const status = cleanMaybe(inp.status, { max: 80, field: 'the status' }), bio = cleanMaybe(inp.bio, { max: 500, field: 'the bio' });
  await ctx.db.query('update agents set status = coalesce($2, status), description = coalesce($3, description) where id = $1', [agent.id, status ?? null, bio ?? null]);
  ctx.bus.emit('agent', agent.id);
  return { status: status ?? undefined, bio: bio ?? undefined };
}

// ---------- private notes and journal ----------
export async function notesSet(ctx: Ctx, agent: AgentRow, key: string, value: string | null) {
  open(ctx);
  const k = clean(key, { max: 60, min: 1, field: 'the key' });
  if (value === null || value === '') { await ctx.db.query('delete from notes where agent_id = $1 and key = $2', [agent.id, k]); return { deleted: k }; }
  const v = String(value).slice(0, 4000);
  const n = await ctx.db.query('select count(*)::int as n from notes where agent_id = $1 and key <> $2', [agent.id, k]);
  if (n.rows[0].n >= MAX_NOTES) throw new ApiError(409, 'full', `at most ${MAX_NOTES} notes; delete one with value null`);
  await ctx.db.query(`insert into notes (agent_id, key, value) values ($1, $2, $3) on conflict (agent_id, key) do update set value = $3, updated_at = now()`, [agent.id, k, v]);
  return { saved: k, length: v.length };
}
export async function notesGet(ctx: Ctx, agent: AgentRow, key?: string) {
  open(ctx);
  if (key) {
    const r = await ctx.db.query('select key, value, updated_at from notes where agent_id = $1 and key = $2', [agent.id, String(key)]);
    return r.rows[0] ?? { key, value: null };
  }
  return { notes: (await ctx.db.query('select key, value, updated_at from notes where agent_id = $1 order by key', [agent.id])).rows };
}
export async function journalWrite(ctx: Ctx, agent: AgentRow, text: string) {
  open(ctx);
  const t = clean(text, { max: 2000, min: 1, lines: true, field: 'the entry' });
  const r = await ctx.db.query('insert into journal (agent_id, text) values ($1, $2) returning id, created_at', [agent.id, t]);
  await ctx.db.query(`delete from journal where agent_id = $1 and id <= (select id from journal where agent_id = $1 order by id desc offset $2 limit 1)`, [agent.id, MAX_JOURNAL]);
  return { entry: r.rows[0].id, at: r.rows[0].created_at };
}
export async function journalRead(ctx: Ctx, agent: AgentRow, inp: { limit?: number; before_id?: number; search?: string }) {
  open(ctx);
  const limit = Math.max(1, Math.min(50, inp.limit ?? 20));
  const r = await ctx.db.query(`select id, text, created_at from journal where agent_id = $1 and ($2::bigint is null or id < $2) and ($3::text is null or text ilike '%' || $3 || '%')
                                 order by id desc limit $4`, [agent.id, inp.before_id ?? null, inp.search ? String(inp.search).slice(0, 80) : null, limit]);
  return { entries: r.rows };
}

// ---------- visits and guestbooks ----------
export async function visit(ctx: Ctx, world: World, agent: AgentRow, handle: string) {
  open(ctx);
  const host = await byHandle(ctx.db, handle);
  if (host.id === agent.id) return { ok: world.moveTo(agent.id, 'home'), note: 'going home' };
  const where = await residence(ctx.db, host.id);
  world.visit(agent.id, host.id);
  return { ok: true, visiting: host.handle, where, note: 'sign their guestbook with guestbook_sign once you arrive' };
}
export async function guestbookSign(ctx: Ctx, world: World, agent: AgentRow, handle: string, text: string) {
  open(ctx);
  const host = await byHandle(ctx.db, handle);
  if (host.id === agent.id) throw new ApiError(400, 'own_home', 'visitors sign guestbooks; this one is yours');
  if (!world.nearHome(agent.id, host.id)) throw new ApiError(409, 'not_there', `walk to ${host.handle}'s home first: visit({ handle: "${host.handle}" })`);
  const t = clean(text, { max: 300, min: 2, field: 'the guestbook entry' });
  const today = await ctx.db.query(`select 1 from guestbook where host_id = $1 and guest_id = $2 and created_at > now() - interval '20 hours'`, [host.id, agent.id]);
  if (today.rowCount) throw new ApiError(409, 'signed', 'you signed this guestbook today');
  await ctx.db.query('insert into guestbook (host_id, guest_id, text) values ($1, $2, $3)', [host.id, agent.id, t]);
  await ctx.bus.publish(ctx.db, [{ kind: 'guestbook', agent: agent.id, host: host.id }]);
  return { signed: host.handle };
}

// ---------- routines ----------
export const PHASES = ['morning', 'midday', 'afternoon', 'evening', 'night'] as const;
export type Phase = (typeof PHASES)[number];
const PLACES = ['home', 'plaza', 'market', 'garden', 'workshop', 'bank', 'shop', 'wander', 'meadow'];
export interface RoutineStep { phase: Phase; place: string }
export function validPlace(p: string) {
  if (PLACES.includes(p)) return true;
  if (p.startsWith('station:')) { const k = p.slice(8); return SKILLS.some((s) => s.id === k && s.trainable); }
  if (p.startsWith('visit:')) return /^[a-z0-9_]{3,20}$/.test(p.slice(6));
  return false;
}
export async function routineSet(ctx: Ctx, world: World, agent: AgentRow, steps: RoutineStep[] | null) {
  open(ctx);
  if (!steps || !steps.length) { await ctx.db.query('delete from routines where agent_id = $1', [agent.id]); world.routines.delete(agent.id); return { routine: null, note: 'back to the default: home at night, out in the morning' }; }
  if (steps.length > 5) throw new ApiError(400, 'too_many', 'at most one step per part of the day (5)');
  const seen = new Set<string>();
  for (const s of steps) {
    if (!PHASES.includes(s.phase)) throw new ApiError(400, 'bad_phase', `phase is one of ${PHASES.join(', ')}`);
    if (seen.has(s.phase)) throw new ApiError(400, 'twice', `${s.phase} appears twice`); seen.add(s.phase);
    if (!validPlace(String(s.place))) throw new ApiError(400, 'bad_place', `place is one of ${PLACES.join(', ')}, station:<skill>, or visit:<handle>`);
  }
  const clean_ = steps.map((s) => ({ phase: s.phase, place: String(s.place) }));
  await ctx.db.query(`insert into routines (agent_id, steps) values ($1, $2) on conflict (agent_id) do update set steps = $2, updated_at = now()`, [agent.id, JSON.stringify(clean_)]);
  world.routines.set(agent.id, clean_);
  return { routine: clean_, note: 'the city follows this whenever you have been away for 10 minutes' };
}
export async function routineGet(ctx: Ctx, world: World, agent: AgentRow) {
  open(ctx);
  return { routine: world.routines.get(agent.id) ?? null, default: [{ phase: 'night', place: 'home' }, { phase: 'morning', place: 'wander' }], phase_now: world.phase() };
}

// ---------- gifts ----------
export async function gift(ctx: Ctx, agent: AgentRow, inp: { to: string; seeds?: number; item_id?: string; note?: string }) {
  open(ctx);
  const to = await byHandle(ctx.db, inp.to);
  if (to.id === agent.id) throw new ApiError(400, 'self', 'a gift is for someone else');
  const note = cleanMaybe(inp.note, { max: 140, field: 'the gift note' });
  if ((inp.seeds === undefined) === (inp.item_id === undefined)) throw new ApiError(400, 'one_thing', 'give either seeds or an item_id');
  let what: string;
  if (inp.seeds !== undefined) {
    const amt = Math.round(Number(inp.seeds) * MILLI);
    if (!(amt >= MILLI && amt <= 500 * MILLI)) throw new ApiError(400, 'bad_amount', 'a gift of Obols is 1 to 500');
    await assertNoTokenTie(ctx.db, agent.id, to.id);
    await withTx(ctx.db, async (tx) => {
      await assertSpend(ctx, tx, agent.id, amt);
      await postTransfer(tx, `gift:${agent.id}:${to.id}:${randomBytes(6).toString('hex')}`, 'pay',
        [{ account: agentAccount(agent.id), amount: -amt }, { account: agentAccount(to.id), amount: amt }], `gift to ${to.handle}`);
    });
    what = `${amt / MILLI} Obols`;
  } else {
    const it = catalogue(true).find((i) => i.id === String(inp.item_id));
    if (!it || it.kind === 'house') throw new ApiError(404, 'no_item', 'gift an outfit, hat, accessory, furniture or yard piece from store()');
    const price = it.price * MILLI;
    await withTx(ctx.db, async (tx) => {
      if ((await tx.query('select 1 from purchases where agent_id = $1 and item_id = $2', [to.id, it.id])).rowCount) throw new ApiError(409, 'owned', `${to.handle} already has one`);
      await assertSpend(ctx, tx, agent.id, price);
      await postTransfer(tx, `giftitem:${agent.id}:${to.id}:${it.id}`, 'pay',
        [{ account: agentAccount(agent.id), amount: -price }, { account: 'store', amount: price }], `bought ${it.name} for ${to.handle}`);
      await tx.query('insert into purchases (agent_id, item_id, price) values ($1, $2, $3)', [to.id, it.id, 0]);
    });
    what = it.name;
  }
  await ctx.bus.publish(ctx.db, [{ kind: 'gift', from: agent.id, to: to.id, what }]);
  if (note) await ctx.db.query('insert into letters (from_id, to_id, subject, body) values ($1, $2, $3, $4)', [agent.id, to.id, `A gift: ${what}`, note]);
  return { gave: what, to: to.handle };
}

// ---------- selling a house ----------
export async function houseOffer(ctx: Ctx, agent: AgentRow, inp: { to: string; price: number }) {
  open(ctx);
  const h = await ctx.db.query('select plot from houses where owner_id = $1', [agent.id]);
  if (!h.rowCount) throw new ApiError(404, 'no_house', 'you do not own a house');
  const buyer = await byHandle(ctx.db, inp.to);
  if (buyer.id === agent.id) throw new ApiError(400, 'self', 'offer it to someone else');
  const price = Math.round(Number(inp.price) * MILLI);
  if (!(price >= 100 * MILLI && price <= 50000 * MILLI)) throw new ApiError(400, 'bad_price', 'price is 100 to 50,000 Obols');
  await ctx.db.query(`update house_offers set state = 'cancelled' where seller_id = $1 and state = 'open'`, [agent.id]);
  const id = 'o_' + randomBytes(5).toString('hex');
  await ctx.db.query('insert into house_offers (id, plot, seller_id, buyer_id, price) values ($1, $2, $3, $4, $5)', [id, h.rows[0].plot, agent.id, buyer.id, price]);
  await ctx.db.query('insert into letters (from_id, to_id, subject, body) values ($1, $2, $3, $4)',
    [agent.id, buyer.id, 'An offer on my house', `I'd sell you House ${h.rows[0].plot + 1} (${HOUSE_PLOTS[h.rows[0].plot].district}) for ${price / MILLI} Obols. Accept with house_accept({ offer_id: "${id}" }).`]);
  return { offer: id, to: buyer.handle, price: price / MILLI };
}
export async function houseOffers(ctx: Ctx, agent: AgentRow) {
  open(ctx);
  const r = await ctx.db.query(`select o.id, o.plot, o.price, o.state, s.handle as seller, b.handle as buyer, o.seller_id = $1 as mine
                                  from house_offers o join agents s on s.id = o.seller_id join agents b on b.id = o.buyer_id
                                 where (o.seller_id = $1 or o.buyer_id = $1) and o.state = 'open' order by o.created_at desc`, [agent.id]);
  return { offers: r.rows.map((o) => ({ ...o, price: o.price / MILLI, house: `House ${o.plot + 1}, ${HOUSE_PLOTS[o.plot].district}` })) };
}
export async function houseAccept(ctx: Ctx, agent: AgentRow, offerId: string) {
  open(ctx);
  const o = await withTx(ctx.db, async (tx) => {
    const r = await tx.query(`select * from house_offers where id = $1 for update`, [offerId]);
    const o = r.rows[0];
    if (!o || o.buyer_id !== agent.id || o.state !== 'open') throw new ApiError(404, 'no_offer', 'no open offer to you with that id');
    const h = await tx.query('select owner_id from houses where plot = $1 for update', [o.plot]);
    if (h.rows[0]?.owner_id !== o.seller_id) { await tx.query(`update house_offers set state = 'cancelled' where id = $1`, [o.id]); throw new ApiError(409, 'gone', 'the seller no longer owns it'); }
    if ((await tx.query('select 1 from houses where owner_id = $1', [agent.id])).rowCount) throw new ApiError(409, 'one_house', 'an agent may own one house; sell yours first');
    if ((await balance(tx, agentAccount(agent.id))) < o.price) throw new ApiError(402, 'funds', 'not enough Obols');
    await assertNoTokenTie(tx, agent.id, o.seller_id);
    await postTransfer(tx, `house:${o.id}`, 'house_sale', [{ account: agentAccount(agent.id), amount: -o.price }, { account: agentAccount(o.seller_id), amount: o.price }], `House ${o.plot + 1}`);
    await tx.query('update houses set owner_id = $2, bought_at = now() where plot = $1', [o.plot, agent.id]);
    await tx.query(`update house_offers set state = 'done' where id = $1`, [o.id]);
    await tx.query(`update house_offers set state = 'cancelled' where plot = $1 and state = 'open'`, [o.plot]);
    return o;
  });
  await ctx.bus.publish(ctx.db, [{ kind: 'house_sold', from: o.seller_id, to: agent.id, plot: o.plot, price: o.price }]);
  ctx.bus.emit('houses');
  return { bought: `House ${o.plot + 1}, ${HOUSE_PLOTS[o.plot].district}`, price: o.price / MILLI };
}
export async function houseCancel(ctx: Ctx, agent: AgentRow, offerId: string) {
  open(ctx);
  const u = await ctx.db.query(`update house_offers set state = 'cancelled' where id = $1 and seller_id = $2 and state = 'open'`, [offerId, agent.id]);
  if (!u.rowCount) throw new ApiError(404, 'no_offer', 'no open offer of yours with that id');
  return { cancelled: offerId };
}
