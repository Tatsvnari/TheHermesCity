import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { joinOpen, registerAgent } from '../src/agents.ts';
import * as play2 from '../src/play2.ts';
import { World } from '../src/world.ts';
import { GENERATORS } from '../src/skills/tasks.ts';
import { ApiError } from '../src/types.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
const ctx = { db, bus: new Bus(), config: { ...config, companionsEnabled: true } };
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };

before(async () => { await db.query('drop schema public cascade; create schema public'); await migrate(db); });
after(async () => { await db.end(); });

test('closed until switched on', async () => {
  const p = await joinOpen(ctx, '198.51.100.1', { handle: 'closed_p', role: 'player' });
  assert.equal(await code(play2.duels({ ...ctx, config: { ...config, companionsEnabled: false } }, p.agent)), 'not_open');
});

test('a player links one of their agents as a companion with its key, once', async () => {
  const w = new World(ctx);
  const p = await joinOpen(ctx, '198.51.100.2', { handle: 'comp_player', role: 'player' });
  const a = await joinOpen(ctx, '198.51.100.3', { handle: 'comp_agent' });
  const other = await joinOpen(ctx, '198.51.100.4', { handle: 'other_player', role: 'player' });
  assert.equal(await code(play2.linkCompanion(ctx, w, p.agent, 'hc_not_a_real_key_000')), 'bad_key');
  assert.equal(await code(play2.linkCompanion(ctx, w, a.agent, a.api_key)), 'players_only');
  assert.equal(await code(play2.linkCompanion(ctx, w, p.agent, other.api_key)), 'not_an_agent');
  assert.deepEqual((await play2.linkCompanion(ctx, w, p.agent, a.api_key)).companion?.handle, 'comp_agent');
  assert.equal(w.companions.get(p.agent.id), a.agent.id);
  assert.equal(await code(play2.linkCompanion(ctx, w, other.agent, a.api_key)), 'taken');
  assert.equal((await play2.companionOf(ctx, w, p.agent)).companion?.handle, 'comp_agent');
  await play2.unlinkCompanion(ctx, w, p.agent);
  assert.equal((await play2.companionOf(ctx, w, p.agent)).companion, null);
});

test('duels: one task for both, first correct answer wins, a wrong answer is out, the record counts', async () => {
  const x = await joinOpen(ctx, '198.51.100.5', { handle: 'duel_x', role: 'player' });
  const y = await registerAgent(ctx, { handle: 'duel_y', owner_email: 'y@x.io' });
  assert.equal(await code(play2.challenge(ctx, x.agent, 'duel_x')), 'self');
  assert.equal(await code(play2.challenge(ctx, x.agent, 'duel_y', 'commerce')), 'bad_skill');
  const c = await play2.challenge(ctx, x.agent, 'duel_y', 'arithmetic', 1);
  assert.equal(await code(play2.accept(ctx, x.agent, c.duel)), 'no_duel', 'only the opponent accepts');
  const live = await play2.accept(ctx, y.agent, c.duel);
  const row = (await db.query('select answer_key, prompt from duels where id = $1', [c.duel])).rows[0];
  assert.deepEqual(live.task, row.prompt, 'both sides get the same task');
  const wrong = await play2.answer(ctx, y.agent, c.duel, 'definitely wrong');
  assert.equal(wrong.correct, false); assert.equal(wrong.finished, false);
  assert.equal(await code(play2.answer(ctx, y.agent, c.duel, 'again')), 'answered');
  const right = await play2.answer(ctx, x.agent, c.duel, GENERATORS.arithmetic!.reveal(row.answer_key));
  assert.equal(right.won, true); assert.equal(right.finished, true);
  assert.deepEqual(await play2.record(db, x.agent.id), { won: 1, lost: 0, drawn: 0 });
  assert.deepEqual(await play2.record(db, y.agent.id), { won: 0, lost: 1, drawn: 0 });
  const ach = await play2.achievementsOf(db, x.agent.id);
  assert.equal(ach.achievements.find((a) => a.id === 'duel_win')!.done, true);
  const list = await play2.duels(ctx, x.agent);
  assert.equal(list.recent[0].winner, 'duel_x');
});
