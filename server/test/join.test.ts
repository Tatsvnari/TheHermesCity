import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { joinOpen, authenticate, ownerKey } from '../src/agents.ts';
import { agentAccount, balance } from '../src/ledger.ts';
import { ApiError } from '../src/types.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
const ctx = { db, bus: new Bus(), config: { ...config, joinPerHour: 5 } };
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };

before(async () => { await db.query('drop schema public cascade; create schema public'); await migrate(db); });
after(async () => { await db.end(); });

test('anyone can join with no key: wallet, working key, caps and reserved names', async () => {
  const r = await joinOpen(ctx, '203.0.113.7', { handle: 'Visitor_One', description: 'hello' });
  assert.equal(r.agent.handle, 'visitor_one');
  assert.equal(await balance(db, agentAccount(r.agent.id)), 10000 * 1000);
  assert.equal((await authenticate(db, r.api_key)).id, r.agent.id);
  assert.ok(r.agent.owner_email.endsWith('@join.hermescity') && !r.agent.owner_email.includes('203.0.113.7'));
  assert.equal(await code(joinOpen(ctx, '203.0.113.7', { handle: 'maia' })), 'reserved_handle');
  assert.equal(await code(joinOpen(ctx, '203.0.113.7', { handle: 'visitor_one' })), 'handle_taken');
  const two = await joinOpen(ctx, '203.0.113.7', { handle: 'visitor_two' });
  await joinOpen(ctx, '203.0.113.7', { handle: 'visitor_three' });
  assert.equal(await code(joinOpen(ctx, '203.0.113.7', { handle: 'visitor_four' })), 'ok');         // a network is not one person
  assert.equal(await code(joinOpen(ctx, '203.0.113.7', { handle: 'visitor_five' })), 'join_rate');  // but joins per network are limited
  assert.equal(await code(joinOpen(ctx, '198.51.100.9', { handle: 'other_person' })), 'ok');
  assert.notEqual(two.agent.owner_email, r.agent.owner_email, 'each agent is its own owner');
  assert.equal(two.agent.owner_email.split('-')[1], r.agent.owner_email.split('-')[1], 'tagged with the same network');
  assert.equal(await code(joinOpen({ ...ctx, config: { ...ctx.config, joinGlobalPerHour: 1 } }, '198.18.0.1', { handle: 'late_one' })), 'town_busy');
});

test('agents from one network cannot earn Commerce or reputation off each other', async () => {
  const [a, b] = [await joinOpen(ctx, '192.0.2.44', { handle: 'net_a' }), await joinOpen(ctx, '192.0.2.44', { handle: 'net_b' })];
  const c = await joinOpen(ctx, '192.0.2.99', { handle: 'net_c' });
  const same = await db.query(`select ${ownerKey('$1::text')} = ${ownerKey('$2::text')} as s`, [a.agent.owner_email, b.agent.owner_email]);
  const diff = await db.query(`select ${ownerKey('$1::text')} = ${ownerKey('$2::text')} as s`, [a.agent.owner_email, c.agent.owner_email]);
  assert.equal(same.rows[0].s, true);
  assert.equal(diff.rows[0].s, false);
});
