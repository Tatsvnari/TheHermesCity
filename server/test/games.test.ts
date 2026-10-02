import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { joinOpen, registerAgent } from '../src/agents.ts';
import { GAMES, connect4, dots, checkers, liarsdice, werewolf, wordhunt, trivia } from '../src/games/rules.ts';
import { TRIVIA } from '../src/games/banks.ts';
import * as games from '../src/games/engine.ts';
import { sendChat } from '../src/chat.ts';
import { World } from '../src/world.ts';
import { ApiError } from '../src/types.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
const ctx = { db, bus: new Bus(), config: { ...config, gamesEnabled: true } };
const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const acode = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const seq = (vals: number[]) => { let i = 0; return () => vals[i++ % vals.length]; };
let ip = 10;
let world: World;

before(async () => { await db.query('drop schema public cascade; create schema public'); await migrate(db); world = new World(ctx); });
after(async () => { await db.end(); });

test('Connect Four: four in a row wins; full columns are refused', () => {
  let s = connect4.setup(2, Math.random);
  for (const [seat, col] of [[0, 3], [1, 0], [0, 3], [1, 0], [0, 3], [1, 0]] as const) s = connect4.move(s, seat, { col }, Math.random);
  assert.equal(connect4.result(s), null);
  s = connect4.move(s, 0, { col: 3 }, Math.random);
  assert.deepEqual(connect4.result(s), { winners: [0] });
  assert.equal(code(() => connect4.move(connect4.setup(2, Math.random), 0, { col: 9 }, Math.random)), 'illegal');
});

test('Dots and Boxes: closing a box scores it and you move again', () => {
  let s = dots.setup(2, Math.random);
  s = dots.move(s, 0, { line: 'h,0,0' }, Math.random); s = dots.move(s, 1, { line: 'v,0,0' }, Math.random);
  s = dots.move(s, 0, { line: 'v,0,1' }, Math.random);
  assert.equal(s.turn, 1);
  s = dots.move(s, 1, { line: 'h,1,0' }, Math.random);
  assert.equal(s.score[1], 1); assert.equal(s.turn, 1, 'the scorer moves again');
  assert.equal(code(() => dots.move(s, 1, { line: 'h,1,0' }, Math.random)), 'illegal');
});

test('Checkers: jumps are compulsory, multi-jumps are finished, and men are crowned', () => {
  const empty = () => Array.from({ length: 8 }, () => Array(8).fill(0));
  const b = empty(); b[5][0] = 1; b[4][1] = 3; b[2][3] = 3; b[7][6] = 1; b[0][7] = 3;
  const s = { board: b, turn: 0, quiet: 0, winner: null, draw: false, last: null };
  const legal = checkers.legal(s, 0)!.map((x: any) => JSON.stringify(x.path));
  assert.deepEqual(legal, [JSON.stringify([[5, 0], [3, 2], [1, 4]])], 'the only move is the double jump');
  assert.equal(code(() => checkers.move(s, 0, { path: [[7, 6], [6, 5]] }, Math.random)), 'illegal');
  const after = checkers.move(s, 0, { path: [[5, 0], [3, 2], [1, 4]] }, Math.random);
  assert.equal(after.board[4][1], 0); assert.equal(after.board[2][3], 0);
  const k = empty(); k[1][2] = 1; k[7][0] = 3;
  const crowned = checkers.move({ board: k, turn: 0, quiet: 0, winner: null, draw: false, last: null }, 0, { path: [[1, 2], [0, 1]] }, Math.random);
  assert.equal(crowned.board[0][1], 2, 'a man reaching the far row becomes a king');
});

test("Liar's Dice: bids must rise; a call counts the dice (ones wild) and the loser drops a die; only your own dice show", () => {
  let s = liarsdice.setup(2, seq([0.0, 0.9]));
  s.dice = [[2, 2, 1, 5, 6], [2, 3, 3, 4, 1]];
  s = liarsdice.move(s, 0, { qty: 3, face: 2 }, Math.random);
  assert.equal(code(() => liarsdice.move(s, 1, { qty: 3, face: 2 }, Math.random)), 'illegal');
  s = liarsdice.move(s, 1, { qty: 5, face: 2 }, Math.random);
  s = liarsdice.move(s, 0, { call: true }, Math.random);
  assert.equal(s.reveal!.count, 5, 'three 2s and two wild 1s');
  assert.equal(s.dice[0].length, 4, 'the bid held, so the caller loses a die');
  const v = liarsdice.view(s, 1) as any;
  assert.ok(v.dice[0].every((d: number) => d === 0) && v.dice[1].every((d: number) => d > 0));
});

test('Werewolf: night, dawn, the vote, and the village wins when the wolf is out', () => {
  let s = werewolf.setup(5, Math.random);
  s.roles = ['wolf', 'seer', 'villager', 'villager', 'villager'];
  assert.deepEqual(werewolf.toMove(s), [0, 1]);
  assert.equal(code(() => werewolf.move(s, 2, { vote: 0 }, Math.random)), 'illegal');
  s = werewolf.move(s, 1, { inspect: 0 }, Math.random);
  s = werewolf.move(s, 0, { kill: 4 }, Math.random);
  assert.equal(s.phase, 'day'); assert.equal(s.alive[4], false);
  assert.equal((werewolf.view(s, 1) as any).you.inspected[0], 'wolf');
  assert.equal((werewolf.view(s, 2) as any).roles, undefined, 'roles stay secret during play');
  for (const seat of [0, 1, 2, 3]) s = werewolf.move(s, seat, { vote: seat === 0 ? 1 : 0 }, Math.random);
  assert.deepEqual(werewolf.result(s), { winners: [1, 2, 3, 4], note: 'the village won' });
});

test('Word Hunt: spymasters see the key; clues cannot be on the board; the black word loses', () => {
  let s = wordhunt.setup(4, Math.random);
  assert.ok((wordhunt.view(s, 0) as any).colours.every((c: any) => c), 'the spymaster sees every colour');
  assert.ok((wordhunt.view(s, 2) as any).colours.every((c: any) => c === null), 'a guesser sees none');
  assert.equal(code(() => wordhunt.move(s, 0, { clue: s.words[3], count: 1 }, Math.random)), 'illegal');
  s = wordhunt.move(s, 0, { clue: 'zebra', count: 2 }, Math.random);
  assert.deepEqual(wordhunt.toMove(s), [2]);
  const black = s.colours.indexOf('black');
  s = wordhunt.move(s, 2, { guess: black }, Math.random);
  assert.equal(s.winner, 'blue');
});

test('Trivia: everyone answers; right and quick scores most', () => {
  let s = trivia.setup(2, Math.random);
  const right = TRIVIA[s.qs[0]][2];
  s = trivia.move(s, 0, { answer: right }, Math.random);
  s = trivia.move(s, 1, { answer: (right + 1) % 4 }, Math.random);
  assert.equal(s.q, 1); assert.ok(s.scores[0] >= 100 && s.scores[1] === 0);
  for (let q = 1; q < 10; q++) s = trivia.timeout(s, Math.random);
  assert.deepEqual(trivia.result(s)!.winners, [0]);
});

test('engine: seating, turns, hidden views, the clock, ratings (not between agents of one owner), resigning, table chat', async () => {
  const a = await joinOpen(ctx, `203.0.113.${ip++}`, { handle: 'gamer_a' });
  const b = await joinOpen(ctx, `203.0.113.${ip++}`, { handle: 'gamer_b' });
  for (const x of [a, b]) await world.upsertAgent(x.agent.id, false);
  const t = await games.create(ctx, world, a.agent, 'connect4');
  assert.equal(await acode(games.create(ctx, world, a.agent, 'dots')), 'seated');
  await games.join(ctx, world, b.agent, t.table);
  let v = await games.view(db, a.agent.id, t.table);
  assert.equal(v.status, 'playing'); assert.equal(v.your_move, true); assert.equal((v.legal as any[]).length, 7);
  assert.equal(await acode(games.move(ctx, world, b.agent, t.table, { col: 0 })), 'not_your_turn');
  for (const [who, col] of [[a, 3], [b, 0], [a, 3], [b, 0], [a, 3], [b, 0], [a, 3]] as const) await games.move(ctx, world, who.agent, t.table, { col });
  v = await games.view(db, null, t.table);
  assert.equal(v.status, 'done'); assert.deepEqual((v.result as any).winners, ['gamer_a']); assert.equal(v.rated, true);
  const ladder = await games.ratings(db, 'connect4');
  assert.equal(ladder[0].handle, 'gamer_a'); assert.ok(ladder[0].rating > 1200 && ladder[1].rating < 1200);
  // the clock: a turn that runs out plays for you
  const t2 = await games.create(ctx, world, a.agent, 'dots');
  await games.join(ctx, world, b.agent, t2.table);
  await db.query(`update game_tables set turn_deadline = now() - interval '1 second' where id = $1`, [t2.table]);
  await games.sweep(ctx);
  assert.equal((await db.query('select count(*)::int as n from game_moves where table_id = $1', [t2.table])).rows[0].n, 1);
  await sendChat(ctx, a.agent, { text: 'good game', channel: `table:${t2.table}` });
  assert.equal(await acode(sendChat(ctx, (await joinOpen(ctx, `203.0.113.${ip++}`, { handle: 'kibitzer' })).agent, { text: 'hi', channel: `table:${t2.table}` })), 'not_seated');
  const r = await games.leave(ctx, world, a.agent, t2.table);
  assert.equal(r.resigned, true);
  assert.deepEqual(((await games.view(db, null, t2.table)).result as any).winners, ['gamer_b']);
  // two agents of one owner: the game counts, the rating does not move
  const c = await registerAgent(ctx, { handle: 'twin_one', owner_email: 'twins@x.io' });
  const d = await registerAgent(ctx, { handle: 'twin_two', owner_email: 'twins@x.io' });
  const t3 = await games.create(ctx, world, c.agent, 'connect4');
  await games.join(ctx, world, d.agent, t3.table);
  assert.equal((await games.view(db, null, t3.table)).rated, false);
  // group games need the host to start them, with enough players
  const w = await games.create(ctx, world, c.agent, 'trivia').catch(() => null);
  assert.equal(w, null, 'still seated at the connect4 table');
  assert.ok(Object.keys(GAMES).length === 7);
});
