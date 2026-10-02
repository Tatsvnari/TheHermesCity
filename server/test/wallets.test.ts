import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { joinOpen, registerAgent } from '../src/agents.ts';
import * as market from '../src/market.ts';
import * as wallets from '../src/wallets.ts';
import * as direct from '../src/direct.ts';
import * as solana from '../src/solana.ts';
import { ApiError } from '../src/types.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
config.cityMint ||= '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'; // the city token is minted later: tests use a stand-in mint
const ctx = { db, bus: new Bus(), config: { ...config, walletsEnabled: true, playersEnabled: true } };
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
let ip = 10;
const join = (handle: string, role: 'agent' | 'player' = 'agent') => joinOpen(ctx, `198.18.0.${ip++}`, { handle, role }).then((r) => r.agent);

/** A wallet of our own for the tests: an ed25519 key and its Solana address. */
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { address: solana.b58encode(raw), sign: (msg: string) => solana.b58encode(sign(null, Buffer.from(msg, 'utf8'), privateKey)) };
}
async function linked(handle: string, role: 'agent' | 'player' = 'agent') {
  const a = await join(handle, role), w = wallet();
  const s = await wallets.linkStart(ctx, a, w.address);
  await wallets.linkFinish(ctx, a, { signature: w.sign(s.message), accept_terms: true });
  return { a, w };
}

// the chain, stood in: mints, and payments we "make" by writing token balance changes against a reference
const MINTS: Record<string, { decimals: number; program: string }> = {
  [config.usdcMint]: { decimals: 6, program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
  [config.cityMint]: { decimals: 6, program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' },
};
const paid = new Map<string, any>(); // reference -> parsed transaction
solana.setChain({
  async mintInfo(_c: unknown, mint: string) { return MINTS[mint]; },
  async blockhash() { return 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k'; },
  async signaturesFor(_c: unknown, ref: string) { return paid.has(ref) ? [{ signature: `sig_${ref.slice(0, 8)}`, err: null } as any] : []; },
  async transaction(_c: unknown, sig: string) { for (const [ref, tx] of paid) if (sig === `sig_${ref.slice(0, 8)}`) return tx; return null; },
} as any);
function pay(reference: string, from: string, to: string, mint: string, base: bigint, pre = 0n) {
  paid.set(reference, { meta: { err: null,
    preTokenBalances: [{ owner: to, mint, uiTokenAmount: { amount: String(pre) } }],
    postTokenBalances: [{ owner: to, mint, uiTokenAmount: { amount: String(pre + base) } }] },
  transaction: { message: { accountKeys: [{ pubkey: { toString: () => from }, signer: true }] } } });
}
const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };

before(async () => { await db.query('drop schema public cascade; create schema public'); await migrate(db); });
after(async () => { await db.end(); });

test('base58 round trips, and amounts convert exactly', () => {
  const b = Uint8Array.from([0, 0, 7, 255, 1, 2]);
  assert.deepEqual([...solana.b58decode(solana.b58encode(b))], [...b]);
  assert.equal(solana.toBase('2.5', 6), 2500000n); assert.equal(solana.toBase('0.000001', 6), 1n);
  assert.throws(() => solana.toBase('0.0000001', 6)); assert.throws(() => solana.toBase('-1', 6));
});

test('linking a wallet needs a signature from that wallet and the terms; residents never link', async () => {
  const a = await join('linker'), w = wallet(), other = wallet();
  assert.equal(await code(wallets.linkStart(ctx, a, 'not-an-address')), 'bad_address');
  const s = await wallets.linkStart(ctx, a, w.address);
  assert.match(s.message, /wallet terms/);
  assert.equal(await code(wallets.linkFinish(ctx, a, { signature: w.sign(s.message), accept_terms: false })), 'terms');
  assert.equal(await code(wallets.linkFinish(ctx, a, { signature: other.sign(s.message), accept_terms: true })), 'bad_signature');
  assert.equal(await code(wallets.linkFinish(ctx, a, { signature: w.sign(s.message + ' '), accept_terms: true })), 'bad_signature');
  assert.equal((await wallets.linkFinish(ctx, a, { signature: w.sign(s.message), accept_terms: true })).linked, w.address);
  assert.equal((await wallets.walletOf(db, a.id)).address, w.address);
  const { agent: res } = await registerAgent(ctx, { handle: 'res_wallet', owner_email: config.houseOwner, role: 'house' });
  assert.equal(await code(wallets.linkStart(ctx, res, w.address)), 'resident');
  const off = { ...ctx, config: { ...ctx.config, walletsEnabled: false } };
  assert.equal(await code(wallets.linkStart(off, a, w.address)), 'not_open');
});

test('sanctions: a listed wallet cannot link, and the list refresh drops one already linked', async () => {
  const bad = wallet(), a = await join('screened');
  await db.query(`insert into sanctioned_addresses (address, source) values ($1, 'test')`, [bad.address]);
  const s = await wallets.linkStart(ctx, a, bad.address);
  assert.equal(await code(wallets.linkFinish(ctx, a, { signature: bad.sign(s.message), accept_terms: true })), 'sanctioned');
  const { a: b, w } = await linked('screened_later');
  const xml = `<sdnList><sdnEntry><idList><id><uid>1</uid><idType>Digital Currency Address - SOL</idType><idNumber>${w.address}</idNumber></id></idList></sdnEntry></sdnList>`;
  assert.equal(await wallets.refreshSanctions(ctx, async () => xml), 1);
  assert.equal(await wallets.walletOf(db, b.id), null, 'unlinked once it appears on the list');
});

test('paid up front: list in USDC, hire, pay from the wallet (seen on-chain), deliver, confirm; no Obols, no XP', async () => {
  const { a: seller, w: sw } = await linked('usdc_seller');
  const { a: buyer, w: bw } = await linked('usdc_buyer', 'player');
  assert.equal(await code(market.listService(ctx, seller, { name: 'Poem to order', pay_in: 'usdc', token_price: 999 } as any)), 'bad_amount');
  const l = await market.listService(ctx, seller, { name: 'Poem to order', pay_in: 'usdc', token_price: '2.5', input_schema: schema, output_schema: schema } as any);
  assert.equal((l as any).pay_token, 'USDC');
  assert.equal(await code(market.hire(ctx, buyer, { service_id: l.id, input: { text: 'x' }, max_price: 10 })), 'direct_pay', 'the Obols market will not take it');
  const nowallet = await join('no_wallet_buyer');
  assert.equal(await code(direct.hire(ctx, nowallet, { service_id: l.id, input: { text: 'x' } })), 'no_wallet');
  const d = await direct.hire(ctx, buyer, { service_id: l.id, input: { text: 'about the sea' } });
  assert.equal(d.state, 'awaiting_payment'); assert.equal(d.price, '2.5 USDC');
  assert.equal(await code(direct.deliver(ctx, seller, d.id, { text: 'early' })), 'not_working', 'no work before payment');
  const req = await direct.payRequest(ctx, buyer, d.id);
  assert.match(req.solana_pay, /^solana:/); assert.ok(req.solana_pay.includes('amount=2.5') && req.solana_pay.includes(`reference=${req.reference}`));
  assert.ok(req.unsigned_transaction.length > 100, 'an unsigned transaction for the buyer to sign');
  assert.equal(req.from, bw.address); assert.equal(req.to, sw.address);
  pay(req.reference, bw.address, sw.address, config.usdcMint, 2_000_000n); // short by 0.5
  await direct.sweep(ctx);
  assert.equal((await direct.show(ctx, buyer, d.id)).state, 'awaiting_payment', 'an underpayment does not count');
  pay(req.reference, bw.address, sw.address, config.usdcMint, 2_500_000n, 1_000n);
  await direct.sweep(ctx);
  const p = await direct.show(ctx, seller, d.id);
  assert.equal(p.state, 'working'); assert.ok(p.paid); assert.match(p.explorer!, /solscan/);
  await direct.deliver(ctx, seller, d.id, { text: 'The sea, the sea.' });
  const c = await direct.confirm(ctx, buyer, d.id, 5, 'lovely');
  assert.equal(c.state, 'done'); assert.equal(c.rating, 5);
  assert.deepEqual(await direct.record(db, seller.id), { done: 1, disputed: 0, stars: 5, unpaid_as_buyer: 0 });
  const xp = await db.query(`select coalesce(sum(xp), 0)::int as xp from skill_xp where agent_id = any($1)`, [[seller.id, buyer.id]]);
  assert.equal(xp.rows[0].xp, 0, 'token deals give no XP');
});

test('paid on delivery in $CITY: the seller works first; unpaid deals go on the buyer\'s record; disputes refund nothing', async () => {
  const { a: seller, w: sw } = await linked('token_seller');
  const { a: buyer, w: bw } = await linked('token_buyer');
  const l = await market.listService(ctx, seller, { name: 'Map a route', pay_in: 'city', token_price: 50000, pay_when: 'delivery' } as any);
  const d = await direct.hire(ctx, buyer, { service_id: l.id, input: {} });
  assert.equal(d.state, 'working');
  assert.equal(await code(direct.payRequest(ctx, buyer, d.id)), 'not_due', 'nothing to pay before delivery');
  await direct.deliver(ctx, seller, d.id, { route: 'north' });
  const req = await direct.payRequest(ctx, buyer, d.id);
  assert.equal(req.pay, '50000 CITY'); assert.equal(req.mint, config.cityMint);
  pay(req.reference, bw.address, sw.address, config.cityMint, 50_000_000_000n);
  assert.equal((await direct.check(ctx, buyer, d.id)).state, 'done');
  const e = await direct.hire(ctx, buyer, { service_id: l.id, input: {} });
  await direct.deliver(ctx, seller, e.id, { route: 'south' });
  await db.query(`update direct_jobs set delivered_at = now() - interval '49 hours' where id = $1`, [e.id]);
  await direct.sweep(ctx);
  assert.equal((await direct.show(ctx, seller, e.id)).state, 'unpaid');
  assert.equal((await direct.record(db, buyer.id)).unpaid_as_buyer, 1);
  const f = await direct.dispute(ctx, seller, e.id, 'never paid');
  assert.equal(f.state, 'disputed'); assert.match(f.note, /nothing is refunded/);
});

test('an up-front deal nobody pays expires; paying late still counts (the seller has the money)', async () => {
  const { a: seller, w: sw } = await linked('late_seller');
  const { a: buyer, w: bw } = await linked('late_buyer');
  const l = await market.listService(ctx, seller, { name: 'Late one', pay_in: 'usdc', token_price: 1 } as any);
  const d = await direct.hire(ctx, buyer, { service_id: l.id, input: {} });
  await db.query(`update direct_jobs set created_at = now() - interval '25 hours' where id = $1`, [d.id]);
  await direct.sweep(ctx);
  assert.equal((await direct.show(ctx, buyer, d.id)).state, 'expired');
  const ref = (await db.query('select reference from direct_jobs where id = $1', [d.id])).rows[0].reference;
  pay(ref, bw.address, sw.address, config.usdcMint, 1_000_000n);
  await direct.sweep(ctx);
  assert.equal((await direct.show(ctx, seller, d.id)).state, 'working');
  assert.equal(await code(wallets.unlink(ctx, seller)), 'busy', 'open deals first');
});

test('Obols are never bought with tokens: no Obols move between accounts that traded in tokens with each other', async () => {
  const { a: seller } = await linked('tie_seller');
  const { a: buyer } = await linked('tie_buyer');
  const other = await join('tie_other');
  const l = await market.listService(ctx, seller, { name: '1000 Obols for 1 USDC', pay_in: 'usdc', token_price: 1 } as any);
  await direct.hire(ctx, buyer, { service_id: l.id, input: {} });
  assert.equal(await code(market.pay(ctx, seller, buyer.handle, 1000, 'your Obols')), 'token_tie');
  assert.equal(await code(market.pay(ctx, buyer, seller.handle, 5, 'tip')), 'token_tie', 'either way round');
  const seedsShop = await market.listService(ctx, buyer, { name: 'Anything', price: 900 });
  assert.equal(await code(market.hire(ctx, seller, { service_id: seedsShop.id, input: {}, max_price: 900 })), 'token_tie', 'nor through a Obols shop');
  assert.equal(await code(market.pay(ctx, seller, other.handle, 5, 'fine')), 'ok', 'other accounts are unaffected');
  await db.query(`update direct_jobs set state = 'cancelled' where buyer_id = $1`, [buyer.id]);
  assert.equal(await code(market.pay(ctx, seller, buyer.handle, 5, 'after a cancelled deal')), 'ok', 'an unpaid, cancelled deal ties nothing');
});

test('a payout wallet on the sanctions list cannot be set for a season prize', async () => {
  const { setWallet } = await import('../src/seasons.ts');
  const a = await join('prize_hopeful'), bad = wallet(), good = wallet();
  await db.query(`insert into sanctioned_addresses (address, source) values ($1, 'test') on conflict do nothing`, [bad.address]);
  assert.equal(await code(setWallet(ctx as any, a, bad.address)), 'sanctioned');
  assert.equal((await setWallet(ctx as any, a, good.address)).payout_wallet, good.address);
});
