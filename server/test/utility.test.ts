import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { joinOpen } from '../src/agents.ts';
import * as market from '../src/market.ts';
import * as wallets from '../src/wallets.ts';
import * as utility from '../src/utility.ts';
import * as store from '../src/store.ts';
import * as homes from '../src/homes.ts';
import * as civic from '../src/civic.ts';
import * as solana from '../src/solana.ts';
import { ApiError } from '../src/types.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
const shop = (() => { const { publicKey } = generateKeyPairSync('ed25519'); return solana.b58encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)); })();
config.cityMint ||= '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'; // the city token is minted later: tests use a stand-in mint
const ctx = { db, bus: new Bus(), config: { ...config, walletsEnabled: true, homesEnabled: true, townEnabled: true, shopWallet: shop } };
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
let ip = 10;
const join = (handle: string) => joinOpen(ctx, `198.19.0.${ip++}`, { handle }).then((r) => r.agent);
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { address: solana.b58encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)), sign: (m: string) => solana.b58encode(sign(null, Buffer.from(m, 'utf8'), privateKey)) };
}
async function linked(handle: string) {
  const a = await join(handle), w = wallet();
  const s = await wallets.linkStart(ctx, a, w.address);
  await wallets.linkFinish(ctx, a, { signature: w.sign(s.message), accept_terms: true });
  return { a, w };
}
const paid = new Map<string, any>();
solana.setChain({
  async mintInfo(_c: unknown, mint: string) { return { decimals: 6, program: mint === config.cityMint ? 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' : 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }; },
  async blockhash() { return 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k'; },
  async signaturesFor(_c: unknown, ref: string) { return paid.has(ref) ? [{ signature: `sig_${ref.slice(0, 10)}`, err: null }] : []; },
  async transaction(_c: unknown, sig: string) { for (const [ref, tx] of paid) if (sig === `sig_${ref.slice(0, 10)}`) return tx; return null; },
} as any);
const pay = (o: { reference: string; to: string; mint: string; pay: string }) => {
  const base = solana.toBase(o.pay.split(' ')[0], 6);
  paid.set(o.reference, { meta: { err: null, preTokenBalances: [], postTokenBalances: [{ owner: o.to, mint: o.mint, uiTokenAmount: { amount: String(base) } }] }, transaction: { message: { accountKeys: [] } } });
};

before(async () => { await db.query('drop schema public cascade; create schema public'); await migrate(db); });
after(async () => { await db.end(); });

test('tips go wallet to wallet, reach the maker of a painting, leave a letter, and tie Obols like any token deal', async () => {
  const { a: fan } = await linked('tip_fan');
  const { a: artist, w: aw } = await linked('tip_artist');
  const nowallet = await join('tip_nowallet');
  assert.equal(await code(utility.tip(ctx, fan, { to: nowallet.handle, token: 'city', amount: 10 })), 'no_wallet_to');
  assert.equal(await code(utility.tip(ctx, fan, { to: fan.handle, token: 'city', amount: 10 })), 'self');
  assert.equal(await code(utility.tip(ctx, fan, { to: artist.handle, token: 'usdc', amount: 51 })), 'bad_amount');
  const art = (await db.query(`insert into artworks (agent_id, title, pixels) values ($1, 'Harbour', $2) returning id`, [artist.id, '01'.repeat(128)])).rows[0].id;
  const o = await utility.tip(ctx, fan, { art: Number(art), token: 'city', amount: '2500', note: 'lovely boats' });
  assert.equal(o.to, aw.address); assert.equal(o.pay, '2500 CITY'); assert.match(o.solana_pay, /^solana:/); assert.ok(o.disclaimer);
  pay(o as any);
  await utility.sweep(ctx);
  const mine = await utility.orders(ctx, fan);
  assert.equal(mine.orders[0].state, 'paid');
  assert.equal((await utility.orders(ctx, artist)).tips_received[0].from, 'tip_fan');
  const letter = (await db.query(`select subject from letters where to_id = $1 order by id desc limit 1`, [artist.id])).rows[0];
  assert.match(letter.subject, /tip of 2500 CITY/);
  assert.equal(await code(market.pay(ctx, artist, fan.handle, 100, 'Obols back?')), 'token_tie', 'tokens never buy Obols, tips included');
});

test('the $CITY store: cosmetic items bought with $CITY, never with Obols; hats and house styles work once owned', async () => {
  const { a } = await linked('cosmetic_buyer');
  assert.ok(!store.catalogue().some((i) => i.id === 'hat:8' || i.id === 'style:windmill' || i.id === 'yard:gazebo'), 'premium items are not in the Obols store');
  assert.equal(await code(store.buy(ctx, a, 'hat:8')), 'no_item', 'and cannot be bought with Obols');
  const closed = { ...ctx, config: { ...ctx.config, shopWallet: '' } };
  assert.equal(await code(utility.buy(closed, a, 'hat:8')), 'not_open', 'closed until the project wallet is set');
  assert.equal(await code(homes.homeSet(ctx, a, { style: 'windmill' })), 'not_owned');
  const o = await utility.buy(ctx, a, 'hat:8');
  assert.equal(o.to, shop); assert.equal(o.pay, '50000 CITY');
  assert.equal(await code(store.equip(ctx, a, { hat: 8 })), 'not_owned', 'nothing before payment');
  pay(o as any);
  assert.equal((await utility.check(ctx, a, o.order)).state, 'paid');
  assert.equal((await store.equip(ctx, a, { hat: 8 })).avatar.hat, 8);
  assert.equal(await code(utility.buy(ctx, a, 'hat:8')), 'owned');
  const s = await utility.buy(ctx, a, 'style:windmill'); pay(s as any); await utility.sweep(ctx);
  assert.equal((await homes.homeSet(ctx, a, { style: 'windmill' })).style, 'windmill');
  assert.equal((await utility.store(ctx, a)).items.find((i) => i.id === 'hat:8')!.owned, true);
});

test('sponsor plaques: one sponsor per public work, shown on the plaque; the name never changes who wins', async () => {
  const { a } = await linked('sponsor_one');
  const { a: b } = await linked('sponsor_two');
  const proposer = await join('sponsor_proposer');
  await db.query(`insert into proposals (id, agent_id, voter, work, spot, cost, state, built_at) values ('p_sponsor1', $1, 'v', 'fountain', 0, 1000000, 'built', now())`, [proposer.id]);
  const opts = await utility.sponsorOptions(ctx);
  assert.ok(opts.works.some((w) => w.target === 'work:p_sponsor1'));
  assert.equal(await code(utility.sponsor(ctx, a, { target: 'work:p_sponsor1', name: 'see free-coins.xyz' })), 'no_links');
  const o = await utility.sponsor(ctx, a, { target: 'work:p_sponsor1', name: 'The Night Owls' });
  assert.equal(o.pay, '100000 CITY');
  assert.equal(await code(utility.sponsor(ctx, b, { target: 'work:p_sponsor1', name: 'Rival' })), 'taken', 'reserved while it is being paid');
  pay(o as any); await utility.sweep(ctx);
  assert.equal((await civic.works(db)).find((w: any) => w.id === 'p_sponsor1').sponsor, 'The Night Owls');
  assert.ok(!(await utility.sponsorOptions(ctx)).works.some((w) => w.target === 'work:p_sponsor1'), 'no longer on offer');
});
