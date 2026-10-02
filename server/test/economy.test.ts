// Runs against TEST_DATABASE_URL (a throwaway DB; its public schema is dropped).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate, withTx } from '../src/db.ts';
import { registerAgent, authenticate } from '../src/agents.ts';
import { agentAccount, balance, postTransfer, reconcile } from '../src/ledger.ts';
import * as m from '../src/market.ts';
import { ApiError } from '../src/types.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
// These tests pin the original small-grant economy (100 Obols in four tranches, 50/day cap) to exercise the tranche logic.
const ctx = { db, bus: new Bus(), config: { ...config, autoAcceptS: 0, grantTotal: 100 * 1000, grantTranches: 4, dailySpendCap: 50 * 1000 } };
const S = 1000;

const csvListing = {
  name: 'CSV clean', price: 5, check_kind: 'rowcount_le_input' as const,
  input_schema: { type: 'object', required: ['csv'], properties: { csv: { type: 'string' } } },
  output_schema: { type: 'object', required: ['csv', 'rows_out'], properties: { csv: { type: 'string' }, rows_out: { type: 'integer' } } },
};

before(async () => {
  await db.query('drop schema public cascade; create schema public');
  await migrate(db);
});
after(async () => { await db.end(); });

const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
let n = 0;
const mk = (owner: string, role: 'agent' | 'house' | 'arbiter' = 'agent') =>
  registerAgent(ctx, { handle: `t${n++}_${owner.replace(/[^a-z0-9]/g, "").slice(0, 6)}`, owner_email: owner, role });

test('registration grants tranche 1 and keys authenticate', async () => {
  const { agent, api_key } = await mk('alice@x.io');
  assert.equal(await balance(db, agentAccount(agent.id)), 25 * S);
  assert.equal((await authenticate(db, api_key)).id, agent.id);
  assert.equal(await code(authenticate(db, api_key + 'x')), 'bad_key');
});

test('per-owner agent cap', async () => {
  for (let i = 0; i < 3; i++) await mk('capped@x.io');
  assert.equal(await code(mk('capped@x.io')), 'owner_limit');
});

test('transfers balance, reject overdraft, and replay by idempotency key', async () => {
  const { agent: a } = await mk('p@x.io'); const { agent: b } = await mk('q@x.io');
  const legs = [{ account: agentAccount(a.id), amount: -3 * S }, { account: agentAccount(b.id), amount: 3 * S }];
  const t1 = await withTx(db, (tx) => postTransfer(tx, 'k1', 'pay', legs));
  const t2 = await withTx(db, (tx) => postTransfer(tx, 'k1', 'pay', legs));
  assert.equal(t1.id, t2.id); assert.equal(t2.replayed, true);
  assert.equal(await balance(db, agentAccount(a.id)), 22 * S);
  assert.equal(await code(withTx(db, (tx) => postTransfer(tx, 'k2', 'pay',
    [{ account: agentAccount(a.id), amount: -999 * S }, { account: agentAccount(b.id), amount: 999 * S }]))), 'insufficient_funds');
  assert.equal(await code(withTx(db, (tx) => postTransfer(tx, 'k3', 'pay',
    [{ account: agentAccount(a.id), amount: -1 }, { account: agentAccount(b.id), amount: 2 }]))), 'unbalanced');
});

test('full job loop: hire -> escrow -> deliver -> accept -> settle with 2% fee; tranche 2 released', async () => {
  const { agent: seller } = await mk('sell@x.io'); const { agent: buyer } = await mk('buy@x.io');
  const l = await m.listService(ctx, seller, csvListing);
  const job = await m.hire(ctx, buyer, { service_id: l.id, input: { csv: 'a,b\n1,2\n1,2\n' }, max_price: 5, idempotency_key: 'h1' });
  const again = await m.hire(ctx, buyer, { service_id: l.id, input: { csv: 'a,b\n1,2\n1,2\n' }, max_price: 5, idempotency_key: 'h1' });
  assert.equal(again.id, job.id, 'retried hire does not pay twice');
  assert.equal(await balance(db, agentAccount(buyer.id)), 20 * S);
  assert.equal(await balance(db, `escrow:${job.id}`), 5 * S);

  const poll = await m.pollJobs(ctx, seller);
  assert.equal(poll.to_do[0].id, job.id);
  assert.equal(await code(m.deliver(ctx, seller, job.id, { csv: 1 })), 'schema_mismatch');
  await m.deliver(ctx, seller, job.id, { csv: 'a,b\n1,2', rows_out: 1 });
  assert.equal((await m.getJob(db, job.id)).check_passed, true);
  await m.accept(ctx, buyer, job.id);

  assert.equal(await balance(db, `escrow:${job.id}`), 0);
  // seller: 25 grant + 4.9 payout + 25 (tranche 2, cross-owner job) ; buyer: 20 + 25 tranche 2
  assert.equal(await balance(db, agentAccount(seller.id)), 25 * S + 4900 + 25 * S);
  assert.equal(await balance(db, agentAccount(buyer.id)), 45 * S);
  assert.equal(await balance(db, 'fees'), 100);
  assert.equal(await code(m.accept(ctx, buyer, job.id)), 'bad_state');
});

test('self-hire, over max price, cancel refund', async () => {
  const { agent: s } = await mk('s2@x.io'); const { agent: b } = await mk('b2@x.io');
  const l = await m.listService(ctx, s, csvListing);
  assert.equal(await code(m.hire(ctx, s, { service_id: l.id, input: { csv: 'x' }, max_price: 5 })), 'self_hire');
  assert.equal(await code(m.hire(ctx, b, { service_id: l.id, input: { csv: 'x' }, max_price: 4 })), 'over_max_price');
  assert.equal(await code(m.hire(ctx, b, { service_id: l.id, input: { nope: 1 }, max_price: 5 })), 'schema_mismatch');
  const j = await m.hire(ctx, b, { service_id: l.id, input: { csv: 'x' }, max_price: 5 });
  await m.cancel(ctx, b, j.id);
  assert.equal(await balance(db, agentAccount(b.id)), 25 * S);
});

test('dispute -> arbiter split, arbiter paid off the top', async () => {
  const { agent: s } = await mk('s3@x.io'); const { agent: b } = await mk('b3@x.io');
  const { agent: arb } = await registerAgent(ctx, { handle: 'arbiter_t', owner_email: config.houseOwner, role: 'arbiter' });
  const l = await m.listService(ctx, s, { ...csvListing, price: 9, check_kind: 'none' });
  const j = await m.hire(ctx, b, { service_id: l.id, input: { csv: 'x' }, max_price: 9 });
  await m.deliver(ctx, s, j.id, { csv: 'y', rows_out: 0 });
  await m.dispute(ctx, b, j.id, 'wrong');
  assert.equal(await code(m.arbitrate(ctx, s as any, j.id, 'seller', '')), 'not_arbiter');
  const arbBefore = await balance(db, agentAccount(arb.id));
  await m.arbitrate(ctx, arb, j.id, 'split', 'both partly right');
  assert.equal(await balance(db, agentAccount(arb.id)) - arbBefore, 1 * S);
  // pot 8: seller 4 minus 2% (0.08) = 3.92 ; buyer 4 back
  assert.equal(await balance(db, 'fees') >= 80, true);
  assert.equal((await m.getJob(db, j.id)).verdict, 'split');
});

test('expiry refunds; quiet delivery with passed check auto-accepts', async () => {
  const { agent: s } = await mk('s4@x.io'); const { agent: b } = await mk('b4@x.io');
  const l = await m.listService(ctx, s, { ...csvListing, check_kind: 'none' });
  const j1 = await m.hire(ctx, b, { service_id: l.id, input: { csv: 'x' }, max_price: 5 });
  const j2 = await m.hire(ctx, b, { service_id: l.id, input: { csv: 'x' }, max_price: 5 });
  await db.query(`update jobs set deadline = now() - interval '1 second' where id = $1`, [j1.id]);
  await m.deliver(ctx, s, j2.id, { csv: 'x', rows_out: 0 });
  await m.sweep(ctx);
  assert.equal((await m.getJob(db, j1.id)).state, 'expired');
  assert.equal((await m.getJob(db, j2.id)).verdict, 'auto');
});

test('guardrails hold under concurrent attack: spend cap and open-job cap', async () => {
  const { agent: s } = await mk('s5@x.io'); const { agent: b } = await mk('b5@x.io');
  // Give the buyer plenty so only the caps can stop it.
  await withTx(db, (tx) => postTransfer(tx, 'topup-b5', 'mint',
    [{ account: 'treasury', amount: -500 * S }, { account: agentAccount(b.id), amount: 500 * S }]));
  const l = await m.listService(ctx, s, { ...csvListing, price: 12, check_kind: 'none' });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    code(m.hire(ctx, b, { service_id: l.id, input: { csv: 'x' }, max_price: 12, idempotency_key: `atk${i}` }))));
  const ok = results.filter((r) => r === 'ok').length;
  assert.equal(ok, 4, `50-Obol cap allows exactly 4 x 12; got ${JSON.stringify(results)}`);
  assert.ok(results.every((r) => r === 'ok' || r === 'spend_cap' || r === 'open_job_limit'));
  const pays = await Promise.all(Array.from({ length: 5 }, (_, i) => code(m.pay(ctx, b, s.id, 1, 'x', `p${i}`))));
  assert.equal(pays.filter((r) => r === 'ok').length, 2, 'remaining 2 Obols of cap');
});

test('open-job cap', async () => {
  const { agent: s } = await mk('s6@x.io'); const { agent: b } = await mk('b6@x.io');
  const l = await m.listService(ctx, s, { ...csvListing, price: 1, check_kind: 'none' });
  const r = [];
  for (let i = 0; i < 6; i++) r.push(await code(m.hire(ctx, b, { service_id: l.id, input: { csv: 'x' }, max_price: 1 })));
  assert.deepEqual(r, ['ok', 'ok', 'ok', 'ok', 'ok', 'open_job_limit']);
});

test('20 jobs between agents leave zero ledger drift', async () => {
  const agents = [];
  for (let i = 0; i < 4; i++) agents.push((await registerAgent(ctx, { handle: `house${i}_t`, owner_email: config.houseOwner, role: 'house' })).agent);
  const listings = [];
  for (const a of agents) listings.push(await m.listService(ctx, a, { ...csvListing, price: 1, check_kind: 'none' }));
  for (let i = 0; i < 20; i++) {
    const buyer = agents[i % 4], li = listings[(i + 1) % 4], seller = agents[(i + 1) % 4];
    const j = await m.hire(ctx, buyer, { service_id: li.id, input: { csv: 'a' }, max_price: 1 });
    await m.pollJobs(ctx, seller);
    await m.deliver(ctx, seller, j.id, { csv: 'a', rows_out: 0 });
    await m.accept(ctx, buyer, j.id);
  }
  const r = await reconcile(db);
  assert.equal(r.ok, true, JSON.stringify(r));
  // corrupt one balance: reconcile must notice
  await db.query(`update accounts set balance = balance + 1 where id = $1`, [agentAccount(agents[0].id)]);
  assert.equal((await reconcile(db)).ok, false);
  await db.query(`update accounts set balance = balance - 1 where id = $1`, [agentAccount(agents[0].id)]);
});

test("when Market Street's 16 stalls are full, new shops open at Merchants' Guild counters; 3 shops per agent", async () => {
  await db.query('update listings set active = false');
  const owners = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => mk(`guild${i}@x.io`)));
  const plots: number[] = [];
  for (const o of owners) for (let k = 0; k < 3; k++) plots.push((await m.listService(ctx, o.agent, { ...csvListing, name: `shop ${k}` })).plot);
  assert.deepEqual(plots.slice(0, 16), Array.from({ length: 16 }, (_, i) => i), 'street stalls fill first');
  assert.deepEqual(plots.slice(16), [16, 17], "then the Guild's counters");
  assert.equal(await code(m.listService(ctx, owners[0].agent, csvListing)), 'listing_limit');
  assert.ok((await m.browseServices(db, 'shop')).some((l) => l.plot >= 16), 'Guild shops are listed like any other');
  await db.query('update listings set active = false');
});
