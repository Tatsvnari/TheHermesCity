import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { joinOpen } from '../src/agents.ts';
import * as skills from '../src/skills/service.ts';
import * as seasons from '../src/seasons.ts';
import { questsOf } from '../src/quests.ts';
import { XP_TABLE } from '../src/skills/defs.ts';
import { World } from '../src/world.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
const ctx = { db, bus: new Bus(), config };

before(async () => { await db.query('drop schema public cascade; create schema public'); await migrate(db); });
after(async () => { await db.end(); });

test('players have their own leaderboard and never enter the prize standings', async () => {
  const p = await joinOpen(ctx, '203.0.113.50', { handle: 'person_one', role: 'player' });
  const a = await joinOpen(ctx, '203.0.113.51', { handle: 'agent_one' });
  assert.equal(p.agent.role, 'player');
  assert.equal(a.agent.role, 'agent');
  await db.query(`insert into skill_xp (agent_id, skill, xp) values ($1, 'logic', $2), ($3, 'logic', $4)`, [p.agent.id, XP_TABLE[20], a.agent.id, XP_TABLE[5]]);
  assert.deepEqual((await skills.leaderboard(db, 'overall', 25, 'agents')).map((r) => r.handle), ['agent_one']);
  assert.deepEqual((await skills.leaderboard(db, 'overall', 25, 'players')).map((r) => r.handle), ['person_one']);
  assert.deepEqual((await skills.leaderboard(db, 'logic', 25, 'players')).map((r) => r.handle), ['person_one']);
  const st = await seasons.standings(ctx, db);
  assert.ok(st.some((r) => r.agent_id === a.agent.id), 'agents are in the standings');
  assert.ok(!st.some((r) => r.agent_id === p.agent.id), 'players never are');
});

test("Maia's quests follow what the player has actually done", async () => {
  const p = await joinOpen(ctx, '203.0.113.60', { handle: 'person_two', role: 'player' });
  let q = await questsOf(db, p.agent.id);
  assert.equal(q.done, 0);
  await db.query(`insert into skill_xp (agent_id, skill, xp) values ($1, 'ciphers', $2)`, [p.agent.id, XP_TABLE[3]]);
  await db.query(`insert into chat_messages (channel, agent_id, text) values ('town', $1, 'hello')`, [p.agent.id]);
  q = await questsOf(db, p.agent.id);
  const by = Object.fromEntries(q.quests.map((x) => [x.id, x.done]));
  assert.equal(by.first_level, true);
  assert.equal(by.say_hello, true);
  assert.equal(by.first_task, false);
  assert.equal(q.done, 2);
});

test('walking to a point plots a path along the roads', async () => {
  const w = new World(ctx);
  const p = await joinOpen(ctx, '203.0.113.70', { handle: 'person_three', role: 'player' });
  await w.upsertAgent(p.agent.id, false);
  assert.equal(w.walkTo(p.agent.id, 40, 12), true);
  const sim = w.agents.get(p.agent.id)!;
  assert.ok(sim.path.length >= 1);
  assert.deepEqual(sim.path[sim.path.length - 1], { x: 40, z: 12 });
  assert.equal(w.walkTo('a_nobody', 1, 1), false);
});
