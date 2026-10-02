import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Rng } from '../src/skills/rng.ts';
import { GENERATORS } from '../src/skills/tasks.ts';
import { XP_TABLE, levelFor, maxTier, awardXp, SKILL_IDS } from '../src/skills/defs.ts';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { registerAgent } from '../src/agents.ts';
import * as m from '../src/market.ts';
import * as sk from '../src/skills/service.ts';
import { ApiError } from '../src/types.ts';

// ---------- solvers used only to prove each task is solvable and graded correctly ----------
function solvePath(grid: string[]): string {
  const g = grid.map((r) => r.split('')); const h = g.length, w = g[0].length;
  let sx = 0, sy = 0; g.forEach((row, y) => row.forEach((c, x) => { if (c === 'S') { sx = x; sy = y; } }));
  const cost = (c: string) => (c >= '1' && c <= '9' ? Number(c) : 1);
  const dist = new Map<string, number>([[`${sx},${sy}`, 0]]), prev = new Map<string, [string, string]>();
  const pq: [number, number, number][] = [[0, sx, sy]];
  while (pq.length) {
    pq.sort((a, b) => a[0] - b[0]); const [d, x, y] = pq.shift()!;
    if (g[y][x] === 'G') { let k = `${x},${y}`, out = ''; while (prev.has(k)) { const [p, mv] = prev.get(k)!; out = mv + out; k = p; } return out; }
    for (const [mv, dx, dy] of [['U', 0, -1], ['D', 0, 1], ['L', -1, 0], ['R', 1, 0]] as const) {
      const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h || g[ny][nx] === '#') continue;
      const nd = d + cost(g[ny][nx]), k = `${nx},${ny}`;
      if (nd < (dist.get(k) ?? Infinity)) { dist.set(k, nd); prev.set(k, [`${x},${y}`, mv]); pq.push([nd, nx, ny]); }
    }
  }
  return '';
}
function solvePlan(d: any): string[] {
  if (d.meetings) {
    const out: string[] = []; let end = -1;
    for (const x of [...d.meetings].sort((a: any, b: any) => a.end - b.end)) if (x.start >= end) { out.push(x.id); end = x.end; }
    return out;
  }
  let best = { v: -1, pick: [] as string[] }; const n = d.items.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    let w = 0, v = 0; const pick: string[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { w += d.items[i].weight; v += d.items[i].value; pick.push(d.items[i].id); }
    if (w <= d.capacity && v > best.v) best = { v, pick };
  }
  return best.pick;
}
function goodAnswer(skill: string, task: any, key: any): unknown {
  switch (skill) {
    case 'wrangling': return key.map((r: string[]) => r.join(',')).join('\n');
    case 'pathfinding': return solvePath(task.data.grid);
    case 'planning': return solvePlan(task.data);
    case 'markets': return key.v;
    case 'calendar': case 'geometry': case 'probability': case 'sequences': case 'networks': case 'bookkeeping':
    case 'wordplay': case 'encoding': case 'puzzles': case 'patterns': return GENERATORS[skill as 'calendar']!.reveal(key); // what a failed attempt shows
    default: return key;
  }
}
const wrong: Record<string, unknown> = { wrangling: 'x,y\n1,2', arithmetic: '123456789', logic: {}, ciphers: 'nope', pathfinding: 'U',
  planning: [], code: 'nothing', reading: 'nobody', markets: -99999,
  calendar: 'nope', geometry: -99999, probability: '999/1', sequences: 123456789, networks: 'maybe', bookkeeping: 'nobody',
  wordplay: 'zzz', encoding: 'zz', puzzles: [], patterns: ['S99'] };

test('every generator: own answer passes, wrong answer fails, all 5 tiers', () => {
  for (const [skill, gen] of Object.entries(GENERATORS)) {
    for (let tier = 1; tier <= 5; tier++) {
      const seeds = skill === 'planning' && tier === 5 ? 4 : 25;
      for (let s = 1; s <= seeds; s++) {
        const { task, key } = gen!.make(new Rng(s * 7919 + tier), tier);
        assert.ok(gen!.grade(task, key, goodAnswer(skill, task, key)), `${skill} t${tier} seed ${s} rejects its own answer`);
        assert.equal(gen!.grade(task, key, wrong[skill]), false, `${skill} t${tier} seed ${s} accepts a wrong answer`);
        assert.ok(!JSON.stringify(task).includes('answer_key'), 'no key in task');
      }
    }
  }
});

test('pathfinding rejects a valid but non-optimal route', () => {
  const gen = GENERATORS.pathfinding!;
  let checked = 0;
  for (let s = 1; s < 40 && checked < 5; s++) {
    const { task, key } = gen.make(new Rng(s), 3);
    const best = solvePath((task.data as any).grid);
    const detour = best + 'UD'; // same end cell, more cost -- unless U hits a wall
    if (gen.grade(task, key, detour) === false) checked++;
  }
  assert.ok(checked >= 5);
});

test('code tasks match real Python 3 output', () => {
  const py = spawnSync('python3', ['--version']);
  if (py.status !== 0) return; // python not available: skip
  for (let tier = 1; tier <= 5; tier++) for (let s = 1; s <= 30; s++) {
    const { task, key } = GENERATORS.code!.make(new Rng(s * 131 + tier), tier);
    const r = spawnSync('python3', ['-c', (task.data as any).program], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), key, `tier ${tier} seed ${s}\n${(task.data as any).program}`);
  }
});

test('xp curve', () => {
  assert.equal(XP_TABLE[10], 115); assert.equal(XP_TABLE[50], 10133); assert.equal(XP_TABLE[99], 1303443);
  for (let l = 1; l <= 99; l++) assert.equal(levelFor(XP_TABLE[l]), l);
  assert.equal(levelFor(114), 9);
  assert.equal(maxTier(1), 1); assert.equal(maxTier(15), 2); assert.equal(maxTier(60), 5); assert.equal(maxTier(99), 5);
  assert.equal(awardXp(1, 1, 0), 10); assert.equal(awardXp(1, 1, 10), 15); assert.equal(awardXp(1, 60, 0), 5);
});

// ---------- service against Postgres ----------
const dsn = process.env.TEST_DATABASE_URL;
const db = dsn ? makePool(dsn) : null;
const ctx = { db: db!, bus: new Bus(), config };
const hooks = { starts: [] as string[], results: [] as boolean[], onTrainStart(a: string, s: string) { this.starts.push(`${a}:${s}`); }, onResult(_a: string, _s: string, p: boolean) { this.results.push(p); } };
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };

before(async () => { if (!db) return; await db.query('drop schema public cascade; create schema public'); await migrate(db); });
after(async () => { await db?.end(); });

test('training loop: task, correct answer, xp, streak, miss reveals, tier lock, one open task', { skip: !db }, async () => {
  const { agent } = await registerAgent(ctx, { handle: 'trainee_one', owner_email: 'tr@x.io' });
  const t1 = await sk.train(ctx, hooks, agent, 'arithmetic');
  const again = await sk.train(ctx, hooks, agent, 'arithmetic');
  assert.equal(again.task_id, t1.task_id); assert.equal(again.resumed, true);
  assert.equal(hooks.starts.length, 2);
  assert.ok(!('answer_key' in t1));
  const key = (await db!.query('select answer_key from training_tasks where id = $1', [t1.task_id])).rows[0].answer_key;
  const r1 = await sk.answer(ctx, hooks, agent, t1.task_id, key);
  assert.equal(r1.passed, true); assert.equal(r1.xp_gained, 10); assert.equal(r1.level, 2); assert.equal(r1.level_up, 2);
  assert.equal(await code(sk.answer(ctx, hooks, agent, t1.task_id, key)), 'task_closed');
  const t2 = await sk.train(ctx, hooks, agent, 'arithmetic');
  const r2 = await sk.answer(ctx, hooks, agent, t2.task_id, 'definitely wrong');
  assert.equal(r2.passed, false); assert.equal(r2.xp_gained, 0); assert.equal(r2.streak, 0); assert.ok(r2.expected !== undefined);
  assert.equal(await code(sk.train(ctx, hooks, agent, 'arithmetic', 3)), 'tier_locked');
  assert.equal(await code(sk.train(ctx, hooks, agent, 'commerce')), 'not_trainable');
  assert.equal(await code(sk.train(ctx, hooks, agent, 'juggling')), 'bad_skill');
  const t3 = await sk.train(ctx, hooks, agent, 'logic');
  await db!.query(`update training_tasks set expires_at = now() - interval '1 second' where id = $1`, [t3.task_id]);
  const k3 = (await db!.query('select answer_key from training_tasks where id = $1', [t3.task_id])).rows[0].answer_key;
  const r3 = await sk.answer(ctx, hooks, agent, t3.task_id, k3);
  assert.equal(r3.passed, false); assert.equal(r3.expired, true);
  const mine = await sk.skillsOf(db!, agent.id);
  assert.equal(mine.skills.find((s) => s.skill === 'arithmetic')!.attempts, 2);
  assert.equal(mine.total_level, SKILL_IDS.length + 1); // level 2 in one skill, level 1 in the rest
});

test('commerce xp from cross-owner jobs only; leaderboard ranks', { skip: !db }, async () => {
  const { agent: s } = await registerAgent(ctx, { handle: 'seller_c', owner_email: 'sc@x.io' });
  const { agent: b } = await registerAgent(ctx, { handle: 'buyer_c', owner_email: 'bc@x.io' });
  const l = await m.listService(ctx, s, { name: 'thing', price: 3 });
  const j = await m.hire(ctx, b, { service_id: l.id, input: {}, max_price: 3 });
  await m.deliver(ctx, s, j.id, {});
  await m.accept(ctx, b, j.id);
  const sx = (await sk.skillsOf(db!, s.id)).skills.find((x) => x.skill === 'commerce')!;
  const bx = (await sk.skillsOf(db!, b.id)).skills.find((x) => x.skill === 'commerce')!;
  assert.equal(sx.xp, 55); assert.equal(bx.xp, 10);
  const lb = await sk.leaderboard(db!, 'commerce');
  assert.equal(lb[0].handle, 'seller_c');
  const overall = (await sk.leaderboard(db!, 'overall')) as any[];
  assert.ok(overall.length >= 2 && overall[0].total_level >= overall[1].total_level);
});
