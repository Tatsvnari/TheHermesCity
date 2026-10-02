import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { registerAgent, ensureStartingBalances } from '../src/agents.ts';
import { agentAccount, balance, reconcile } from '../src/ledger.ts';
import * as store from '../src/store.ts';
import * as coaching from '../src/coaching.ts';
import * as sk from '../src/skills/service.ts';
import { ApiError } from '../src/types.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
const ctx = { db, bus: new Bus(), config };
const hooks = { onTrainStart() {}, onResult() {} };
const S = 1000;
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };

before(async () => { await db.query('drop schema public cascade; create schema public'); await migrate(db); });
after(async () => { await db.end(); });

test('every agent starts with 10,000 Obols; old agents are topped up once', async () => {
  const { agent } = await registerAgent(ctx, { handle: 'rich_one', owner_email: 'r@x.io' });
  assert.equal(await balance(db, agentAccount(agent.id)), 10000 * S);
  const oldCtx = { ...ctx, config: { ...config, grantTotal: 100 * S, grantTranches: 4 } };
  const { agent: old } = await registerAgent(oldCtx, { handle: 'old_timer', owner_email: 'o@x.io' });
  assert.equal(await balance(db, agentAccount(old.id)), 25 * S);
  assert.equal(await ensureStartingBalances(ctx), 1);
  assert.equal(await balance(db, agentAccount(old.id)), 10025 * S);
  assert.equal(await ensureStartingBalances(ctx), 0);
});

test('store: buy, wear, one house each, sold plots stay sold', async () => {
  const { agent: a } = await registerAgent(ctx, { handle: 'shopper_a', owner_email: 'sa@x.io', avatar: { body: 3, hat: 1 } });
  const { agent: b } = await registerAgent(ctx, { handle: 'shopper_b', owner_email: 'sb@x.io' });
  await store.buy(ctx, a, 'hat:6');
  assert.equal(await code(store.buy(ctx, a, 'hat:6')), 'owned');
  assert.equal((await db.query('select avatar from agents where id = $1', [a.id])).rows[0].avatar.hat, 6);
  assert.equal(await code(store.equip(ctx, a, { hat: 2 })), 'not_owned');
  await store.equip(ctx, a, { hat: 1 });          // original look is free
  assert.equal(await code(store.equip(ctx, a, { accessory: 1 })), 'not_owned');
  await store.buy(ctx, a, 'house:3');
  assert.equal(await code(store.buy(ctx, b, 'house:3')), 'sold');
  assert.equal(await code(store.buy(ctx, a, 'house:4')), 'one_house');
  assert.equal(await balance(db, agentAccount(a.id)), (10000 - 300 - 2600) * S);
  const houses = await store.housesView(db);
  assert.equal(houses.find((h) => h.plot === 3)!.owner, 'shopper_a');
  assert.equal((await reconcile(db)).ok, true);
});

test('coaching: escrow, coach trains for client, XP to client, pay per pass, refund on miss and cancel', async () => {
  const { agent: client } = await registerAgent(ctx, { handle: 'pupil', owner_email: 'p@x.io' });
  const { agent: coach } = await registerAgent(ctx, { handle: 'tutor', owner_email: 't@x.io' });
  const c = await coaching.hireCoach(ctx, client, { coach: 'tutor', skill: 'arithmetic', tasks: 3, price_per_task: 20 });
  assert.equal(await balance(db, agentAccount(client.id)), 9940 * S);
  assert.equal(await code(sk.train(ctx, hooks, coach, 'logic', undefined, 'pupil')), 'no_contract');
  // pass one
  const t1 = await sk.train(ctx, hooks, coach, 'arithmetic', undefined, 'pupil');
  const k1 = (await db.query('select answer_key from training_tasks where id = $1', [t1.task_id])).rows[0].answer_key;
  assert.equal(await code(sk.answer(ctx, hooks, client, t1.task_id, k1)), 'no_task');   // the client cannot answer the coach's task
  const r1 = await sk.answer(ctx, hooks, coach, t1.task_id, k1);
  assert.equal(r1.passed, true);
  const pupilXp = (await sk.skillsOf(db, client.id)).skills.find((s) => s.skill === 'arithmetic')!.xp;
  const tutorXp = (await sk.skillsOf(db, coach.id)).skills.find((s) => s.skill === 'arithmetic')!.xp;
  assert.ok(pupilXp > 0); assert.equal(tutorXp, 0);
  assert.equal(await balance(db, agentAccount(coach.id)), 10000 * S + 19600);      // 20 minus 2%
  // miss one
  const t2 = await sk.train(ctx, hooks, coach, 'arithmetic', undefined, 'pupil');
  await sk.answer(ctx, hooks, coach, t2.task_id, 'wrong');
  assert.equal(await balance(db, agentAccount(client.id)), 9960 * S);
  // cancel the rest
  await coaching.endCoaching(ctx, client, c.id, 'cancel');
  assert.equal(await balance(db, agentAccount(client.id)), 9980 * S);
  assert.equal((await coaching.coachingOf(db, client.id)).as_client[0].state, 'cancelled');
  assert.equal((await reconcile(db)).ok, true);
});
