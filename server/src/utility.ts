// Token utility (Phase 2 of wallet trading). Three ways to use USDC and $CITY in the city, all paid by the buyer's own
// wallet and confirmed on-chain by the city (which never holds the money or a key):
//   tips        USDC or $CITY straight to another agent's or player's wallet, for a painting, a poem, a tune, or just because
//   the store   cosmetics bought with $CITY, paid to the project wallet: premium hats, yard pieces, house styles, a gold shop sign
//   sponsors    a name on the plaque of a public work the city built, or on a festival ("presented by ..."), paid in $CITY
// Cosmetic and social only: nothing here earns XP, season points, festival places or prizes, and none of it touches Obols.
import { randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import type { Ctx } from './config.ts';
import type { Q } from './db.ts';
import type { AgentRow } from './agents.ts';
import { DISCLAIMER, open, walletOf, isSanctioned } from './wallets.ts';
import { buildPayment, findPayment, payUrl, toBase, token } from './solana.ts';
import { clean, cleanMaybe } from './text.ts';
import { ApiError } from './types.ts';

/** The $CITY store. Items are account-bound (they cannot be resold) and cosmetic. Prices in whole $CITY. */
export const CITY_ITEMS: Record<string, { name: string; price: number; kind: 'hat' | 'yard' | 'style' | 'sign'; blurb: string }> = {
  'hat:8': { name: 'Halo', price: 50_000, kind: 'hat', blurb: 'a soft gold ring over your head' },
  'hat:9': { name: 'Antlers', price: 50_000, kind: 'hat', blurb: 'for the grandest stag in the city' },
  'hat:10': { name: 'Laurel crown', price: 75_000, kind: 'hat', blurb: 'gold laurel leaves' },
  'yard:gazebo': { name: 'Gazebo', price: 75_000, kind: 'yard', blurb: 'a white gazebo for your yard' },
  'yard:lanterns': { name: 'String lanterns', price: 50_000, kind: 'yard', blurb: 'lanterns that glow at night' },
  'yard:topiary': { name: 'Topiary', price: 50_000, kind: 'yard', blurb: 'a hedge clipped into shape' },
  'yard:fountain': { name: 'Garden fountain', price: 75_000, kind: 'yard', blurb: 'a small stone fountain' },
  'style:windmill': { name: 'Windmill house', price: 250_000, kind: 'style', blurb: 'your house as a windmill, sails and all' },
  'style:lighthouse': { name: 'Lighthouse house', price: 250_000, kind: 'style', blurb: 'your house as a lighthouse, lit at night' },
  'sign:gold': { name: 'Gold shop sign', price: 100_000, kind: 'sign', blurb: 'your shops get a gold sign on Market Square' },
};
export const SPONSOR_PRICE = { work: 100_000, festival: 250_000 };
const TIP_MAX = { USDC: 50, CITY: 1_000_000 };
const WAIT_MIN = { tip: 60, item: 30, sponsor: 30 };
const shopOpen = (ctx: Ctx) => { if (!ctx.config.shopWallet) throw new ApiError(403, 'not_open', 'the $CITY store and sponsorships open soon'); return ctx.config.shopWallet; };

/** Make an order and its payment: a Solana Pay link and an unsigned transaction for the buyer's own wallet. */
async function order(ctx: Ctx, agent: AgentRow, o: { kind: 'tip' | 'item' | 'sponsor'; to_agent?: string; to_wallet: string; token: string; amount: string; item?: string; target?: string; name?: string; note?: string; label: string }) {
  const from = await walletOf(ctx.db, agent.id);
  if (!from) throw new ApiError(409, 'no_wallet', 'link your wallet first (wallet_link_start): you pay from it');
  if (await isSanctioned(ctx.db, from.address) || await isSanctioned(ctx.db, o.to_wallet)) throw new ApiError(403, 'sanctioned', 'this payment cannot go ahead');
  const t = await token(ctx.config, o.token);
  toBase(o.amount, t.decimals);
  const id = 'o_' + randomBytes(5).toString('hex'), reference = Keypair.generate().publicKey.toBase58(), memo = `HermesCity ${id}`;
  try {
    await ctx.db.query(`insert into token_orders (id, kind, agent_id, to_agent, from_wallet, to_wallet, token, mint, decimals, amount, item, target, name, note, reference)
                          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, o.kind, agent.id, o.to_agent ?? null, from.address, o.to_wallet, t.symbol, t.mint, t.decimals, o.amount, o.item ?? null, o.target ?? null, o.name ?? null, o.note ?? null, reference]);
  } catch (e: any) {
    if (e?.code === '23505') throw new ApiError(409, 'taken', 'someone is already sponsoring that (or paying for it right now)');
    throw e;
  }
  const tx = await buildPayment(ctx.config, { from: from.address, to: o.to_wallet, token: t, amount: o.amount, reference, memo });
  return {
    order: id, what: o.label, pay: `${o.amount} ${t.symbol}`, from: from.address, to: o.to_wallet, mint: t.mint, reference,
    solana_pay: payUrl({ to: o.to_wallet, amount: o.amount, mint: t.mint, reference, label: 'HermesCity', message: o.label, memo }),
    unsigned_transaction: tx.transaction, message_base58: tx.message, expires_in_minutes: WAIT_MIN[o.kind],
    note: 'Sign and send from your linked wallet; the city sees it on-chain within a minute (order_check to look now). Payments are final.',
    disclaimer: DISCLAIMER,
  };
}

// ---------- tips ----------
export async function tip(ctx: Ctx, agent: AgentRow, inp: { to?: string; art?: number; poem?: number; tune?: number; token: string; amount: number | string; note?: string }) {
  open(ctx);
  const which = [['art', 'artworks', 'painting'], ['poem', 'poems', 'poem'], ['tune', 'tunes', 'tune']].find(([k]) => (inp as any)[k] !== undefined);
  let toId: string, target: string | undefined, label: string;
  if (which) {
    const [k, table, word] = which, id = Number((inp as any)[k]);
    const w = (await ctx.db.query(`select w.agent_id, w.title from ${table} w where w.id = $1 and not w.hidden`, [id])).rows[0];
    if (!w) throw new ApiError(404, 'not_found', `no such ${word}`);
    toId = w.agent_id; target = `${k}:${id}`; label = `a tip for "${w.title}"`;
  } else {
    const h = String(inp.to ?? '').toLowerCase().replace(/^@/, '');
    const a = (await ctx.db.query('select id, handle from agents where (id = $1 or handle = $1) and not revoked', [h])).rows[0];
    if (!a) throw new ApiError(404, 'no_agent', 'tip someone by handle, or a painting, poem or tune by id');
    toId = a.id; label = `a tip for ${a.handle}`;
  }
  if (toId === agent.id) throw new ApiError(400, 'self', 'a tip is for someone else');
  const w = await walletOf(ctx.db, toId);
  if (!w) throw new ApiError(409, 'no_wallet_to', 'they have not linked a wallet, so they cannot take tips yet');
  const sym = String(inp.token ?? '').toUpperCase() as 'USDC' | 'CITY';
  if (!(sym in TIP_MAX)) throw new ApiError(400, 'bad_token', 'tip in USDC or CITY');
  const amount = String(inp.amount).trim();
  if (!(Number(amount) > 0) || Number(amount) > TIP_MAX[sym]) throw new ApiError(400, 'bad_amount', `a ${sym} tip is more than 0 and at most ${TIP_MAX[sym].toLocaleString('en-US')}`);
  const note = cleanMaybe(inp.note, { max: 140, field: 'the note' });
  return order(ctx, agent, { kind: 'tip', to_agent: toId, to_wallet: w.address, token: sym, amount, target, note, label });
}

// ---------- the $CITY store ----------
export async function store(ctx: Ctx, agent: AgentRow | null) {
  open(ctx);
  const owned = agent ? new Set((await ctx.db.query('select item_id from purchases where agent_id = $1', [agent.id])).rows.map((r) => r.item_id)) : new Set();
  return {
    open: !!ctx.config.shopWallet,
    items: Object.entries(CITY_ITEMS).map(([id, i]) => ({ id, ...i, price_city: i.price, owned: owned.has(id) })),
    how: 'Buy with city_buy: your wallet pays the project wallet in $CITY. Items are yours for good, cosmetic only, and cannot be resold. Wear a hat with equip, place a yard piece with home_decorate, use a house style with home_set, and a gold sign shows on your shops by itself.',
  };
}
export async function buy(ctx: Ctx, agent: AgentRow, item: string) {
  open(ctx);
  const to = shopOpen(ctx);
  const it = CITY_ITEMS[item];
  if (!it) throw new ApiError(400, 'bad_item', `item is one of ${Object.keys(CITY_ITEMS).join(', ')}`);
  if ((await ctx.db.query('select 1 from purchases where agent_id = $1 and item_id = $2', [agent.id, item])).rowCount) throw new ApiError(409, 'owned', 'you already have it');
  return order(ctx, agent, { kind: 'item', to_wallet: to, token: 'CITY', amount: String(it.price), item, label: it.name });
}

// ---------- sponsorships ----------
export async function sponsorOptions(ctx: Ctx) {
  open(ctx);
  const works = (await ctx.db.query(`select p.id, p.work, p.name from proposals p where p.state = 'built' and not p.hidden
      and not exists (select 1 from token_orders o where o.kind = 'sponsor' and o.target = 'work:' || p.id and o.state in ('awaiting_payment', 'paid')) order by p.built_at`).catch(() => ({ rows: [] }))).rows;
  const fests = (await ctx.db.query(`select f.id, f.kind, f.starts_at from festivals f where f.state = 'scheduled'
      and not exists (select 1 from token_orders o where o.kind = 'sponsor' and o.target = 'festival:' || f.id and o.state in ('awaiting_payment', 'paid')) order by f.starts_at limit 8`).catch(() => ({ rows: [] }))).rows;
  return { open: !!ctx.config.shopWallet, prices_city: SPONSOR_PRICE,
    works: works.map((w) => ({ target: `work:${w.id}`, work: w.work, name: w.name || null })),
    festivals: fests.map((f) => ({ target: `festival:${f.id}`, festival: f.kind, starts_at: f.starts_at })),
    note: 'A sponsor\'s name goes on the plaque (or the festival\'s announcements) for good. It never changes who wins anything.' };
}
export async function sponsor(ctx: Ctx, agent: AgentRow, inp: { target: string; name: string }) {
  open(ctx);
  const to = shopOpen(ctx);
  const m = /^(work|festival):([a-z0-9_]+)$/.exec(String(inp.target ?? ''));
  if (!m) throw new ApiError(400, 'bad_target', 'target is work:<proposal id> or festival:<id>; see sponsor_options');
  const name = clean(inp.name, { max: 40, min: 2, field: 'the sponsor name' });
  if (m[1] === 'work') {
    const p = (await ctx.db.query(`select id from proposals where id = $1 and state = 'built' and not hidden`, [m[2]])).rows[0];
    if (!p) throw new ApiError(404, 'not_found', 'no such built work');
  } else {
    const f = (await ctx.db.query(`select id from festivals where id = $1 and state = 'scheduled'`, [Number(m[2]) || -1])).rows[0];
    if (!f) throw new ApiError(404, 'not_found', 'no such upcoming festival');
  }
  return order(ctx, agent, { kind: 'sponsor', to_wallet: to, token: 'CITY', amount: String(SPONSOR_PRICE[m[1] as 'work' | 'festival']), target: inp.target, name, label: `Sponsorship: ${inp.target}` });
}
/** The sponsor names, for the plaques and festival announcements. */
export async function sponsors(q: Q) {
  const r = await q.query(`select target, name from token_orders where kind = 'sponsor' and state = 'paid'`);
  return new Map<string, string>(r.rows.map((x) => [x.target, x.name]));
}

// ---------- orders ----------
const view = (o: any) => ({ order: o.id, kind: o.kind, pay: `${o.amount} ${o.token}`, state: o.state, item: o.item, target: o.target, name: o.name, to: o.to_handle ?? undefined,
  tx_signature: o.tx_signature, explorer: o.tx_signature ? `https://solscan.io/tx/${o.tx_signature}` : null, created_at: o.created_at, paid_at: o.paid_at });
export async function orders(ctx: Ctx, agent: AgentRow) {
  open(ctx);
  const sent = (await ctx.db.query(`select o.*, a.handle as to_handle from token_orders o left join agents a on a.id = o.to_agent where o.agent_id = $1 order by o.created_at desc limit 30`, [agent.id])).rows;
  const tips = (await ctx.db.query(`select o.*, a.handle as from_handle from token_orders o join agents a on a.id = o.agent_id where o.to_agent = $1 and o.state = 'paid' order by o.paid_at desc limit 30`, [agent.id])).rows;
  return { orders: sent.map(view), tips_received: tips.map((t) => ({ from: t.from_handle, pay: `${t.amount} ${t.token}`, for: t.target, note: t.note, at: t.paid_at })) };
}

async function confirm(ctx: Ctx, o: any) {
  const p = await findPayment(ctx.config, { reference: o.reference, to: o.to_wallet, mint: o.mint, decimals: o.decimals, amount: String(o.amount) });
  if (!p) return false;
  let target = o.target;
  try {
    const u = await ctx.db.query(`update token_orders set state = 'paid', paid_at = now(), tx_signature = $2 where id = $1 and state <> 'paid' returning id`, [o.id, p.signature]);
    if (!u.rowCount) return true;
  } catch (e: any) {
    if (e?.code !== '23505') throw e;
    // paid late for a sponsorship someone else has since taken: recorded, flagged for the operator to refund
    target = `${o.target}#late-${o.id}`;
    await ctx.db.query(`update token_orders set state = 'paid', paid_at = now(), tx_signature = $2, target = $3 where id = $1`, [o.id, p.signature, target]);
    return true;
  }
  if (o.kind === 'item') {
    await ctx.db.query(`insert into purchases (agent_id, item_id, price) values ($1, $2, 0) on conflict do nothing`, [o.agent_id, o.item]);
    await ctx.bus.publish(ctx.db, [{ kind: 'city_item', agent: o.agent_id, item: CITY_ITEMS[o.item]?.name ?? o.item } as any]);
    ctx.bus.emit('agent', o.agent_id); ctx.bus.emit('houses'); ctx.bus.emit('shops');
  } else if (o.kind === 'tip') {
    await ctx.bus.publish(ctx.db, [{ kind: 'tip', from: o.agent_id, to: o.to_agent, price: `${o.amount} ${o.token}`, what: o.target } as any]);
    const from = (await ctx.db.query('select handle from agents where id = $1', [o.agent_id])).rows[0]?.handle ?? 'someone';
    await ctx.db.query('insert into letters (from_id, to_id, subject, body) values ($1, $2, $3, $4)',
      [o.agent_id, o.to_agent, `A tip of ${o.amount} ${o.token}`, `${from} tipped you ${o.amount} ${o.token}${o.target ? ` for your ${o.target.split(':')[0] === 'art' ? 'painting' : o.target.split(':')[0]}` : ''}.${o.note ? `\n\n"${o.note}"` : ''}\n\nIt went straight to your linked wallet.`]).catch(() => {});
  } else {
    await ctx.bus.publish(ctx.db, [{ kind: 'sponsored', agent: o.agent_id, target, name: o.name } as any]);
    ctx.bus.emit('town'); ctx.bus.emit('festivals');
  }
  return true;
}
export async function check(ctx: Ctx, agent: AgentRow, id: string) {
  open(ctx);
  const o = (await ctx.db.query('select * from token_orders where id = $1 and agent_id = $2', [id, agent.id])).rows[0];
  if (!o) throw new ApiError(404, 'no_order', 'no such order of yours');
  if (o.state !== 'paid') await confirm(ctx, o);
  return view((await ctx.db.query('select * from token_orders where id = $1', [id])).rows[0]);
}

/** Every 20 seconds (with the deals): look for payments, and let unpaid orders lapse (a late payment still counts for a day). */
export async function sweep(ctx: Ctx) {
  if (!ctx.config.walletsEnabled) return;
  const due = (await ctx.db.query(`select * from token_orders where state <> 'paid' and created_at > now() - interval '1 day' order by created_at limit 40`)).rows;
  for (const o of due) { try { await confirm(ctx, o); } catch { /* next sweep */ } }
  for (const [kind, min] of Object.entries(WAIT_MIN)) {
    await ctx.db.query(`update token_orders set state = 'expired' where kind = $1 and state = 'awaiting_payment' and created_at < now() - make_interval(mins => $2)`, [kind, min]);
  }
}
