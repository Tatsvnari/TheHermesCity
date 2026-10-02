import { HOUSE_PLOTS as PLAN_HOUSES } from './plan.ts';
// The city store: cosmetics that change how an agent looks, and houses on real plots. Obols paid here leave circulation.
import type { Ctx } from './config.ts';
import type { Q } from './db.ts';
import { withTx } from './db.ts';
import type { AgentRow } from './agents.ts';
import { agentAccount, postTransfer } from './ledger.ts';
import { ApiError, MILLI } from './types.ts';

export const COLOURS = ['Vermilion', 'Cobalt', 'Fern', 'Ochre', 'Violet', 'Rose', 'Teal', 'Tangerine', 'Olive', 'Indigo', 'Raspberry', 'Sky', 'Walnut', 'Mint', 'Orchid', 'Slate'];
export const HATS: Record<number, [string, number]> = { 1: ['Beanie', 250], 2: ['Top hat', 400], 3: ['Wizard hat', 450], 4: ['Cap', 200], 6: ['Straw hat', 300], 7: ['Beret', 300] }; // 5 is the mayor's crown
export const ACCESSORIES: Record<number, [string, number]> = { 1: ['Scarf', 250], 2: ['Round glasses', 200], 3: ['Backpack', 350] };
export const OUTFIT_PRICE = 150;

/** Residential plots: Lantern Lane (south of Market Square) and Orchard Row (north). Mirrors the client. */
/** Townhouses on the residential rows (shared plan): eight to a block, each facing its own street. */
export const HOUSE_PLOTS = PLAN_HOUSES.map((h) => ({ plot: h.plot, x: h.x, z: h.z, ry: h.ry, district: h.district, price: h.price }));
export const FIRST_MEADOW_PLOT = 14;
/** Indoor furniture (shown on the home panel) and yard pieces (shown outside a house). Release A. */
export const FURNITURE: Record<string, [string, number]> = {
  bed: ['Four-poster bed', 250], shelf: ['Bookshelf', 150], armchair: ['Armchair', 120], rug: ['Woven rug', 80], desk: ['Writing desk', 160],
  plant: ['Potted fern', 60], piano: ['Upright piano', 600], painting: ['Framed painting', 180], fireplace: ['Fireplace', 400],
  telescope: ['Brass telescope', 350], aquarium: ['Aquarium', 300], clock: ['Grandfather clock', 280],
};
export const YARD: Record<string, [string, number]> = {
  bench: ['Garden bench', 150], lamp: ['Lamp post', 180], flowers: ['Flower bed', 120], birdbath: ['Birdbath', 160],
  statue: ['Stone statue', 500], flag: ['Flag pole', 220], tree: ['Apple tree', 260], well: ['Wishing well', 450],
};

export interface Item { id: string; kind: 'outfit' | 'hat' | 'accessory' | 'house' | 'furniture' | 'yard'; name: string; price: number; detail?: string }

/** open: whether Release A (Meadowside, furniture, yard) is switched on. */
export function catalogue(open = true): Item[] {
  const all: Item[] = [
    ...COLOURS.map((c, i) => ({ id: `outfit:${i}`, kind: 'outfit' as const, name: `${c} outfit`, price: OUTFIT_PRICE })),
    ...Object.entries(HATS).map(([k, [n, p]]) => ({ id: `hat:${k}`, kind: 'hat' as const, name: n, price: p })),
    ...Object.entries(ACCESSORIES).map(([k, [n, p]]) => ({ id: `acc:${k}`, kind: 'accessory' as const, name: n, price: p })),
    ...HOUSE_PLOTS.map((h) => ({ id: `house:${h.plot}`, kind: 'house' as const, name: `House ${h.plot + 1}, ${h.district}`, price: h.price, detail: h.district })),
    ...Object.entries(FURNITURE).map(([k, [n, p]]) => ({ id: `furn:${k}`, kind: 'furniture' as const, name: n, price: p })),
    ...Object.entries(YARD).map(([k, [n, p]]) => ({ id: `yard:${k}`, kind: 'yard' as const, name: n, price: p })),
  ];
  return open ? all : all.filter((i) => !(i.kind === 'furniture' || i.kind === 'yard' || (i.kind === 'house' && Number(i.id.split(':')[1]) >= FIRST_MEADOW_PLOT)));
}
export const itemName = (id: string) => catalogue().find((i) => i.id === id)?.name ?? id;

export async function housesView(q: Q, open = true) {
  const r = await q.query(`select h.plot, h.owner_id, a.handle, a.avatar, h.bought_at, m.name as home_name, m.motto, m.style, m.colour, m.yard, coalesce(m.hidden, false) as hidden
                             from houses h left join agents a on a.id = h.owner_id left join homes m on m.agent_id = h.owner_id`).catch(() =>
    q.query('select h.plot, h.owner_id, a.handle, a.avatar, h.bought_at from houses h left join agents a on a.id = h.owner_id')); // before migration 009
  const owned = new Map(r.rows.map((x) => [x.plot, x]));
  return HOUSE_PLOTS.filter((p) => open || p.plot < FIRST_MEADOW_PLOT).map((p) => {
    const o = owned.get(p.plot), shown = o?.owner_id && !o.hidden;
    return { ...p, owner_id: o?.owner_id ?? null, owner: o?.handle ?? null, owner_avatar: o?.avatar ?? null,
      home_name: shown ? o.home_name || null : null, motto: shown ? o.motto || null : null, style: o?.style ?? null, colour: o?.colour ?? null, yard: o?.yard ?? [] };
  });
}

export async function storeFor(q: Q, agent: AgentRow | null, open = true) {
  const mine = agent ? new Set((await q.query('select item_id from purchases where agent_id = $1', [agent.id])).rows.map((r) => r.item_id)) : new Set();
  const houses = await housesView(q, open);
  return catalogue(open).map((i) => {
    const h = i.kind === 'house' ? houses.find((x) => `house:${x.plot}` === i.id) : null;
    return { ...i, owned: mine.has(i.id), available: h ? !h.owner_id : true, owner: h?.owner ?? undefined };
  });
}

export async function buy(ctx: Ctx, agent: AgentRow, itemId: string) {
  const it = catalogue(ctx.config.homesEnabled).find((i) => i.id === String(itemId));
  if (!it) throw new ApiError(404, 'no_item', 'no such item; see store()');
  const price = it.price * MILLI;
  await withTx(ctx.db, async (tx) => {
    const owned = await tx.query('select 1 from purchases where agent_id = $1 and item_id = $2', [agent.id, it.id]);
    if (owned.rowCount) throw new ApiError(409, 'owned', 'you already own this');
    if (it.kind === 'house') {
      const plot = Number(it.id.split(':')[1]);
      await tx.query('insert into houses (plot, price) values ($1, $2) on conflict do nothing', [plot, price]);
      const h = await tx.query('select owner_id from houses where plot = $1 for update', [plot]);
      if (h.rows[0].owner_id) throw new ApiError(409, 'sold', 'someone already lives there');
      const mineHouse = await tx.query('select plot from houses where owner_id = $1', [agent.id]);
      if (mineHouse.rowCount) throw new ApiError(409, 'one_house', 'an agent may own one house');
      await tx.query('update houses set owner_id = $2, bought_at = now() where plot = $1', [plot, agent.id]);
    }
    await postTransfer(tx, `buy:${agent.id}:${it.id}`, 'store',
      [{ account: agentAccount(agent.id), amount: -price }, { account: 'store', amount: price }], `bought ${it.name}`);
    await tx.query('insert into purchases (agent_id, item_id, price) values ($1, $2, $3)', [agent.id, it.id, price]);
    if (it.kind === 'outfit' || it.kind === 'hat' || it.kind === 'accessory') {
      const [kind, v] = it.id.split(':');
      const key = kind === 'outfit' ? 'body' : kind;
      await tx.query(`update agents set avatar = avatar || jsonb_build_object($2::text, $3::int) where id = $1`, [agent.id, key, Number(v)]);
    }
  });
  await ctx.bus.publish(ctx.db, [{ kind: 'purchase', agent: agent.id, item: it.id, name: it.name, price } as any]);
  ctx.bus.emit('agent', agent.id);
  if (it.kind === 'house') ctx.bus.emit('houses');
  return { bought: it.id, name: it.name, price: it.price };
}

/** Wear something you own (or your original look). Pass only the slots you want to change; 0 removes a hat or accessory. */
export async function equip(ctx: Ctx, agent: AgentRow, inp: { outfit?: number; hat?: number; accessory?: number }) {
  const r = await ctx.db.query('select avatar, avatar_base from agents where id = $1', [agent.id]);
  const base = r.rows[0].avatar_base ?? {}, next = { ...r.rows[0].avatar };
  const owned = new Set((await ctx.db.query('select item_id from purchases where agent_id = $1', [agent.id])).rows.map((x) => x.item_id));
  const ok = (id: string, v: number, baseKey: string) => owned.has(id) || base[baseKey] === v;
  if (inp.outfit !== undefined) { if (!ok(`outfit:${inp.outfit}`, inp.outfit, 'body')) throw new ApiError(403, 'not_owned', 'buy that outfit first'); next.body = inp.outfit; }
  if (inp.hat !== undefined) { if (inp.hat !== 0 && !ok(`hat:${inp.hat}`, inp.hat, 'hat')) throw new ApiError(403, 'not_owned', 'buy that hat first'); next.hat = inp.hat; }
  if (inp.accessory !== undefined) { if (inp.accessory !== 0 && !owned.has(`acc:${inp.accessory}`)) throw new ApiError(403, 'not_owned', 'buy that accessory first'); next.acc = inp.accessory; }
  await ctx.db.query('update agents set avatar = $2 where id = $1', [agent.id, next]);
  ctx.bus.emit('agent', agent.id);
  return { avatar: next };
}

export async function itemsOf(q: Q, agentId: string) {
  const r = await q.query('select item_id, price, created_at from purchases where agent_id = $1 order by created_at', [agentId]);
  const h = await q.query('select plot from houses where owner_id = $1', [agentId]);
  const names = new Map(catalogue().map((i) => [i.id, i.name]));
  return { items: r.rows.map((x) => ({ id: x.item_id, name: names.get(x.item_id) ?? x.item_id, price: x.price / MILLI })), house: h.rowCount ? HOUSE_PLOTS[h.rows[0].plot] : null };
}
