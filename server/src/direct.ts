// Direct deals (Phase 1 of wallet trading): services priced in USDC or $CITY and paid wallet to wallet. The city lists
// the service, keeps the record, issues a Solana Pay request for the buyer's own wallet, and watches the chain (read
// only) until the payment lands in the seller's wallet. It never holds the money, so nothing is escrowed: the seller
// chooses to be paid up front or on delivery, and disputes go on reputation, not refunds. Token deals never give XP,
// season points or prizes, and never touch Obols.
//   up front:     awaiting_payment -> working (paid) -> delivered -> done (buyer confirms, or 48 h) | disputed
//   on delivery:  working -> delivered (payment asked) -> done (paid) | unpaid (48 h)
import { randomBytes } from 'node:crypto';
import AjvModule from 'ajv';
import { Keypair } from '@solana/web3.js';
import type { Ctx } from './config.ts';
import type { Q } from './db.ts';
import { withTx } from './db.ts';
import type { AgentRow } from './agents.ts';
import { DISCLAIMER, open, walletOf, isSanctioned } from './wallets.ts';
import { buildPayment, findPayment, payUrl, toBase, token } from './solana.ts';
import { ApiError } from './types.ts';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: false, strict: false });
const PAY_HOURS = 24, CONFIRM_HOURS = 48;
const LIVE = ['awaiting_payment', 'working', 'delivered'];

/** Checks for a token price on a listing (called by list_service). Returns the columns to store. */
export async function tokenPrice(ctx: Ctx, agent: AgentRow, inp: { pay_in?: string; token_price?: number | string; pay_when?: string }) {
  if (!inp.pay_in || inp.pay_in.toLowerCase() === 'seeds') return null;
  open(ctx);
  const t = await token(ctx.config, inp.pay_in);
  if (!(await walletOf(ctx.db, agent.id))) throw new ApiError(409, 'no_wallet', 'link your wallet first (wallet_link_start) to be paid in tokens');
  const amount = String(inp.token_price ?? '').trim();
  toBase(amount, t.decimals);
  const max = t.symbol === 'USDC' ? ctx.config.directMaxUsdc : ctx.config.directMaxCity;
  if (!(Number(amount) > 0) || Number(amount) > max) throw new ApiError(400, 'bad_amount', `a ${t.symbol} price is more than 0 and at most ${max.toLocaleString('en-US')}`);
  const when = inp.pay_when === 'delivery' ? 'delivery' : 'upfront';
  return { pay_token: t.symbol, token_amount: amount, pay_when: when };
}

const view = (j: any, me?: string) => ({
  id: j.id, service: j.service ?? undefined, listing_id: j.listing_id, buyer: j.buyer, seller: j.seller, you: me === j.buyer_id ? 'buyer' : me === j.seller_id ? 'seller' : undefined,
  price: `${j.amount} ${j.token}`, token: j.token, amount: String(j.amount), pay_when: j.pay_when, state: j.state, paid: !!j.paid_at, tx_signature: j.tx_signature,
  explorer: j.tx_signature ? `https://solscan.io/tx/${j.tx_signature}` : null, input: j.input, output: j.output, rating: j.rating, dispute: j.dispute,
  created_at: j.created_at, paid_at: j.paid_at, delivered_at: j.delivered_at, done_at: j.done_at,
});
const SELECT = `select j.*, l.name as service, b.handle as buyer, s.handle as seller from direct_jobs j join listings l on l.id = j.listing_id
                  join agents b on b.id = j.buyer_id join agents s on s.id = j.seller_id`;

export async function hire(ctx: Ctx, buyer: AgentRow, inp: { service_id: string; input?: unknown }) {
  open(ctx);
  const bw = await walletOf(ctx.db, buyer.id);
  if (!bw) throw new ApiError(409, 'no_wallet', 'link your wallet first (wallet_link_start): you pay from it');
  const l = (await ctx.db.query(`select l.*, a.revoked, a.owner_email from listings l join agents a on a.id = l.agent_id where l.id = $1`, [inp.service_id])).rows[0];
  if (!l || !l.active || l.revoked) throw new ApiError(404, 'no_listing', 'no such open service');
  if (!l.pay_token) throw new ApiError(409, 'seeds_service', 'this service is paid in Obols: use hire');
  if (l.agent_id === buyer.id) throw new ApiError(400, 'own', 'that is your own service');
  const sw = await walletOf(ctx.db, l.agent_id);
  if (!sw) throw new ApiError(409, 'seller_no_wallet', 'the seller has no linked wallet right now');
  if (await isSanctioned(ctx.db, sw.address) || await isSanctioned(ctx.db, bw.address)) throw new ApiError(403, 'sanctioned', 'this deal cannot go ahead');
  const input = inp.input ?? {};
  const v = ajv.compile(l.input_schema ?? { type: 'object' });
  if (!v(input)) throw new ApiError(422, 'schema_mismatch', `input fails schema: ${ajv.errorsText(v.errors)}`);
  const t = await token(ctx.config, l.pay_token);
  const live = await ctx.db.query(`select count(*)::int as n from direct_jobs where buyer_id = $1 and state = any($2)`, [buyer.id, LIVE]);
  if (live.rows[0].n >= 5) throw new ApiError(409, 'too_many', 'at most 5 open deals at a time');
  const id = 'd_' + randomBytes(5).toString('hex'), reference = Keypair.generate().publicKey.toBase58();
  const state = l.pay_when === 'delivery' ? 'working' : 'awaiting_payment';
  await ctx.db.query(`insert into direct_jobs (id, listing_id, buyer_id, seller_id, token, mint, decimals, amount, pay_when, seller_wallet, buyer_wallet, reference, input, state)
                        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, l.id, buyer.id, l.agent_id, t.symbol, t.mint, t.decimals, l.token_amount, l.pay_when, sw.address, bw.address, reference, JSON.stringify(input), state]);
  await ctx.bus.publish(ctx.db, [{ kind: 'direct_hired', buyer: buyer.id, seller: l.agent_id, service: l.name, price: `${l.token_amount} ${t.symbol}` } as any]);
  const j = await get(ctx.db, id);
  return { ...view(j, buyer.id), next: state === 'awaiting_payment' ? 'pay it: direct_pay gives you the payment to sign with your wallet; the seller starts once it lands' : 'the seller works first; you pay when it is delivered' };
}

export async function get(q: Q, id: string) {
  const j = (await q.query(`${SELECT} where j.id = $1`, [id])).rows[0];
  if (!j) throw new ApiError(404, 'no_deal', 'no such deal');
  return j;
}
async function mine(q: Q, agent: AgentRow, id: string) {
  const j = await get(q, id);
  if (j.buyer_id !== agent.id && j.seller_id !== agent.id) throw new ApiError(404, 'no_deal', 'no such deal of yours');
  return j;
}
export async function show(ctx: Ctx, agent: AgentRow, id: string) { open(ctx); return view(await mine(ctx.db, agent, id), agent.id); }
export async function list(ctx: Ctx, agent: AgentRow) {
  open(ctx);
  const r = await ctx.db.query(`${SELECT} where j.buyer_id = $1 or j.seller_id = $1 order by j.created_at desc limit 30`, [agent.id]);
  return { deals: r.rows.map((j) => view(j, agent.id)) };
}

/** The payment for a deal that is waiting for one: a Solana Pay link and an unsigned transaction for the buyer's wallet. */
export async function payRequest(ctx: Ctx, agent: AgentRow, id: string) {
  open(ctx);
  const j = await mine(ctx.db, agent, id);
  if (j.buyer_id !== agent.id) throw new ApiError(403, 'not_buyer', 'only the buyer pays');
  const due = !j.paid_at && (j.state === 'awaiting_payment' || (j.state === 'delivered' && j.pay_when === 'delivery'));
  if (!due) throw new ApiError(409, 'not_due', j.paid_at ? 'already paid' : `nothing to pay while the deal is ${j.state}`);
  const t = await token(ctx.config, j.token);
  const memo = `HermesCity ${j.id}`, amount = String(j.amount);
  const tx = await buildPayment(ctx.config, { from: j.buyer_wallet, to: j.seller_wallet, token: t, amount, reference: j.reference, memo });
  return {
    deal: j.id, pay: `${amount} ${t.symbol}`, from: j.buyer_wallet, to: j.seller_wallet, mint: t.mint, reference: j.reference,
    solana_pay: payUrl({ to: j.seller_wallet, amount, mint: t.mint, reference: j.reference, label: 'HermesCity', message: j.service, memo }),
    unsigned_transaction: tx.transaction, message_base58: tx.message,
    note: 'Sign and send from the linked wallet; the city sees the payment on-chain within a minute (direct_check to look now). Payments go straight to the seller and are final.',
    disclaimer: DISCLAIMER,
  };
}

async function confirmPaid(ctx: Ctx, j: any) {
  const p = await findPayment(ctx.config, { reference: j.reference, to: j.seller_wallet, mint: j.mint, decimals: j.decimals, amount: String(j.amount) });
  if (!p) return false;
  // paid up front (or late, after it expired or was cancelled: the seller has the money, so the deal goes ahead)
  const next = ['awaiting_payment', 'expired', 'cancelled'].includes(j.state) ? 'working' : 'done';
  const u = await ctx.db.query(`update direct_jobs set paid_at = now(), tx_signature = $2, state = $3, done_at = case when $3 = 'done' then now() else done_at end
                                  where id = $1 and paid_at is null returning id`, [j.id, p.signature, next]);
  if (u.rowCount) await ctx.bus.publish(ctx.db, [{ kind: 'direct_paid', from: j.buyer_id, to: j.seller_id, deal: j.id, price: `${j.amount} ${j.token}` } as any]);
  return true;
}
export async function check(ctx: Ctx, agent: AgentRow, id: string) {
  open(ctx);
  const j = await mine(ctx.db, agent, id);
  if (!j.paid_at) await confirmPaid(ctx, j);
  return view(await get(ctx.db, id), agent.id);
}

export async function deliver(ctx: Ctx, seller: AgentRow, id: string, output: unknown) {
  open(ctx);
  await withTx(ctx.db, async (tx) => {
    const j = (await tx.query(`select j.*, l.output_schema from direct_jobs j join listings l on l.id = j.listing_id where j.id = $1 for update of j`, [id])).rows[0];
    if (!j || j.seller_id !== seller.id) throw new ApiError(404, 'no_deal', 'no such deal of yours to deliver');
    if (j.state !== 'working') throw new ApiError(409, 'not_working', j.state === 'awaiting_payment' ? 'wait for the payment before you start' : `this deal is ${j.state}`);
    const v = ajv.compile(j.output_schema ?? { type: 'object' });
    if (!v(output)) throw new ApiError(422, 'schema_mismatch', `output fails schema: ${ajv.errorsText(v.errors)}`);
    await tx.query(`update direct_jobs set output = $2, state = 'delivered', delivered_at = now() where id = $1`, [id, JSON.stringify(output)]);
  });
  const j = await get(ctx.db, id);
  return { ...view(j, seller.id), next: j.pay_when === 'delivery' ? 'the buyer pays now (they have 48 hours)' : 'the buyer confirms it (or it closes by itself in 48 hours)' };
}

/** The buyer is happy (up front deals): close it, with an optional rating. */
export async function confirm(ctx: Ctx, buyer: AgentRow, id: string, rating?: number, note?: string) {
  open(ctx);
  const r = Number.isInteger(rating) ? Math.max(1, Math.min(5, rating!)) : null;
  const u = await ctx.db.query(`update direct_jobs set state = 'done', done_at = now(), rating = coalesce($3, rating), note = coalesce($4, note)
                                  where id = $1 and buyer_id = $2 and state = 'delivered' and paid_at is not null returning id`, [id, buyer.id, r, note ? String(note).slice(0, 300) : null]);
  if (!u.rowCount) {
    const done = await ctx.db.query(`update direct_jobs set rating = $3, note = coalesce($4, note) where id = $1 and buyer_id = $2 and state = 'done' and $3::int is not null returning id`, [id, buyer.id, r, note ? String(note).slice(0, 300) : null]);
    if (!done.rowCount) throw new ApiError(409, 'not_ready', 'confirm a paid deal once it is delivered (or rate a finished one)');
  }
  return view(await get(ctx.db, id), buyer.id);
}

/** Either side flags a problem. Nothing can be refunded (the city never held the money); it goes on reputation. */
export async function dispute(ctx: Ctx, agent: AgentRow, id: string, reason: string) {
  open(ctx);
  const j = await mine(ctx.db, agent, id);
  if (!['working', 'delivered', 'unpaid', 'done'].includes(j.state) || (j.state === 'done' && j.done_at && Date.now() - new Date(j.done_at).getTime() > 7 * 86400e3)) {
    throw new ApiError(409, 'too_late', `this deal is ${j.state}`);
  }
  await ctx.db.query(`update direct_jobs set state = 'disputed', dispute = $2 where id = $1`, [id, `${agent.handle}: ${String(reason ?? '').slice(0, 500)}`]);
  await ctx.bus.publish(ctx.db, [{ kind: 'direct_disputed', deal: id, by: agent.id } as any]);
  return { ...view(await get(ctx.db, id), agent.id), note: 'recorded on both reputations; payments are final, so nothing is refunded by the city' };
}

export async function cancel(ctx: Ctx, agent: AgentRow, id: string) {
  open(ctx);
  const j = await mine(ctx.db, agent, id);
  const ok = !j.paid_at && (j.state === 'awaiting_payment' || (j.state === 'working' && j.pay_when === 'delivery'));
  if (!ok) throw new ApiError(409, 'cannot_cancel', j.paid_at ? 'paid deals cannot be cancelled' : `this deal is ${j.state}`);
  await ctx.db.query(`update direct_jobs set state = 'cancelled' where id = $1`, [id]);
  return view(await get(ctx.db, id), agent.id);
}

/** Obols are never bought or sold for money. So Obols cannot move between two accounts that have made a token deal with
 *  each other in the last 30 days (a paid or pending deal, either way round): otherwise "1,000 Obols for 1 USDC" would
 *  turn money into Obols, Obols into coaching and XP, and money into a better chance at a season prize. */
export async function assertNoTokenTie(q: Q, a: string, b: string) {
  const r = await q.query(`select 1 from direct_jobs where ((buyer_id = $1 and seller_id = $2) or (buyer_id = $2 and seller_id = $1))
                             and state not in ('cancelled', 'expired') and created_at > now() - interval '30 days'
                           union all select 1 from token_orders where kind = 'tip' and state = 'paid' and created_at > now() - interval '30 days'
                             and ((agent_id = $1 and to_agent = $2) or (agent_id = $2 and to_agent = $1)) limit 1`, [a, b]);
  if (r.rowCount) throw new ApiError(409, 'token_tie', "Obols can't move between accounts that have traded in tokens with each other in the last 30 days: Obols are never bought or sold for money");
}

/** A seller's record in token deals, shown with their listings. */
export async function record(q: Q, agentId: string) {
  const r = await q.query(`select count(*) filter (where state = 'done')::int as done, count(*) filter (where state = 'disputed')::int as disputed,
                                  round(avg(rating) filter (where rating is not null), 1)::float as stars from direct_jobs where seller_id = $1`, [agentId]);
  const b = await q.query(`select count(*) filter (where state = 'unpaid')::int as unpaid from direct_jobs where buyer_id = $1`, [agentId]);
  return { ...r.rows[0], unpaid_as_buyer: b.rows[0].unpaid };
}

/** Every 20 seconds: look for payments on-chain, close what has waited long enough. */
export async function sweep(ctx: Ctx) {
  if (!ctx.config.walletsEnabled) return;
  const due = (await ctx.db.query(`select * from direct_jobs where paid_at is null and (state = 'awaiting_payment' or (state = 'delivered' and pay_when = 'delivery')
                                       or (state in ('expired', 'cancelled') and pay_when = 'upfront' and created_at > now() - interval '7 days'))
                                     order by created_at limit 40`)).rows;
  for (const j of due) { try { await confirmPaid(ctx, j); } catch { /* the chain can wait for the next sweep */ } }
  await ctx.db.query(`update direct_jobs set state = 'expired' where state = 'awaiting_payment' and paid_at is null and created_at < now() - make_interval(hours => $1)`, [PAY_HOURS]);
  await ctx.db.query(`update direct_jobs set state = 'unpaid' where state = 'delivered' and pay_when = 'delivery' and paid_at is null and delivered_at < now() - make_interval(hours => $1)`, [CONFIRM_HOURS]);
  await ctx.db.query(`update direct_jobs set state = 'done', done_at = now() where state = 'delivered' and paid_at is not null and delivered_at < now() - make_interval(hours => $1)`, [CONFIRM_HOURS]);
}
