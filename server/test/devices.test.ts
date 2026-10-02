import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { joinOpen, rotateKey } from '../src/agents.ts';
import * as devices from '../src/devices.ts';
import { ApiError } from '../src/types.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
const ctx = { db, bus: new Bus(), config: { ...config, playersEnabled: true } };
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
let ip = 10;
const player = (handle: string) => joinOpen(ctx, `192.0.2.${ip++}`, { handle, role: 'player' });

before(async () => { await db.query('drop schema public cascade; create schema public'); await migrate(db); });
after(async () => { await db.end(); });

test('a player carries on on another device with a one-time code; it works once', async () => {
  const { agent, api_key } = await player('two_screens');
  const l = await devices.createLink(ctx, agent, api_key);
  assert.match(l.code, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/); assert.equal(l.expires_in_minutes, 15);
  const r = await devices.redeem(ctx, ` ${l.code.toLowerCase().replace('-', ' ')} `); // typed loosely on a phone
  assert.deepEqual([r.id, r.handle, r.api_key], [agent.id, 'two_screens', api_key], 'the same player, the same key: the first device stays signed in');
  assert.equal(await code(devices.redeem(ctx, l.code)), 'no_code', 'works once');
  const { rows } = await db.query('select count(*)::int as n from device_links');
  assert.equal(rows[0].n, 0, 'nothing of the key is left behind');
});

test('only the newest code works, codes expire, and a rotated key is not handed out', async () => {
  const { agent, api_key } = await player('careful_one');
  const a = await devices.createLink(ctx, agent, api_key), b = await devices.createLink(ctx, agent, api_key);
  assert.equal(await code(devices.redeem(ctx, a.code)), 'no_code', 'a new code replaces the old one');
  await db.query(`update device_links set expires_at = now() - interval '1 second'`);
  assert.equal(await code(devices.redeem(ctx, b.code)), 'no_code', 'expired');
  const c = await devices.createLink(ctx, agent, api_key);
  await rotateKey(db, agent.id);
  assert.equal(await code(devices.redeem(ctx, c.code)), 'bad_key', 'the old key no longer works, so it is not handed on');
  assert.equal(await code(devices.redeem(ctx, 'ABC')), 'bad_code');
  assert.equal(await code(devices.redeem(ctx, 'ZZZZ-ZZZZ')), 'no_code');
});

test('agents keep their own key: no device codes for them', async () => {
  const { agent, api_key } = await joinOpen(ctx, '192.0.2.200', { handle: 'an_agent' });
  assert.equal(await code(devices.createLink(ctx, agent, api_key)), 'not_player');
});
