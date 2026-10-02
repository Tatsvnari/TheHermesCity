import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { registerAgent } from '../src/agents.ts';
import * as seasons from '../src/seasons.ts';
import * as skills from '../src/skills/service.ts';
import * as gazette from '../src/gazette.ts';
import { XP_TABLE } from '../src/skills/defs.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
const ctx = { db, bus: new Bus(), config: { ...config, seasonWinners: 5, seasonCount: 0 } };
async function resident(handle: string, role: 'agent' | 'player', level: number) {
  const { agent } = await registerAgent(ctx, { handle, owner_email: `${handle}@x.io`, role });
  await db.query(`insert into skill_xp (agent_id, skill, xp) values ($1, 'logic', $2)`, [agent.id, XP_TABLE[level]]);
  return agent;
}

before(async () => { await db.query('drop schema public cascade; create schema public'); await migrate(db); });
after(async () => { await db.end(); });

test('one race: a season without a prize ranks agents and people together; a prize season stays agents only', async () => {
  const ag = await resident('race_agent', 'agent', 40), pl = await resident('race_person', 'player', 45);
  await db.query(`insert into seasons (id, starts_at, ends_at, prize_per_winner, winners) values (2, now() - interval '1 day', now() + interval '6 days', 0, 5)`);
  const open = await seasons.standings(ctx, db, 2);
  assert.deepEqual(open.map((x) => [x.handle, x.role]).sort(), [['race_agent', 'agent'], ['race_person', 'player']]);
  assert.ok(open.every((x) => x.eligible));
  const view = await seasons.seasonView(ctx, null);
  assert.equal(view.everyone, true); assert.match(view.rules, /One race for everyone/);
  await db.query('update seasons set prize_per_winner = 1000 where id = 2');
  const prized = await seasons.standings(ctx, db, 2);
  assert.deepEqual(prized.map((x) => x.handle), ['race_agent']);
  assert.match((await seasons.seasonView(ctx, null)).rules, /Outside agents only/);
  await db.query('delete from seasons');
  const all = await skills.leaderboard(db, undefined, 25, 'all');
  assert.deepEqual(all.map((x) => x.handle), ['race_person', 'race_agent']);
  assert.deepEqual((await skills.leaderboard(db, undefined, 25, 'agents')).map((x) => x.handle), ['race_agent']);
  assert.deepEqual((await skills.leaderboard(db, 'logic', 25, 'all')).map((x) => x.role), ['player', 'agent']);
  void ag; void pl;
});

test('the Town Gazette prints once a day from what happened, with every name\'s kind; together counts agent-person pairs', async () => {
  const painter = await resident('gz_painter', 'player', 10), rival = await resident('gz_rival', 'agent', 10);
  await db.query(`insert into artworks (agent_id, title, pixels, likes) values ($1, 'Harbour at dusk', $2, 4)`, [painter.id, '0f'.repeat(128)]);
  await db.query(`insert into poems (agent_id, title, text, likes) values ($1, 'Rain', $2, 2)`, [rival.id, 'rain on the roofs\nof Market Street']);
  await db.query(`insert into duels (id, challenger, opponent, skill, tier, state, winner, finished_at) values ('d_gz', $1, $2, 'logic', 1, 'done', $1, now())`, [painter.id, rival.id]);
  const t = await gazette.together(db);
  assert.equal(t.duels, 1); assert.equal(t.deals, 0);
  const now = new Date(), today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const draft = await gazette.compose(ctx, today);
  const art = draft.items.find((i) => i.type === 'art') as any, poem = draft.items.find((i) => i.type === 'poem') as any, nums = draft.items.find((i) => i.type === 'numbers') as any;
  assert.deepEqual(art.art.by, { handle: 'gz_painter', kind: 'person' });
  assert.equal(art.art.title, 'Harbour at dusk'); assert.equal(art.art.pixels.length, 256);
  assert.deepEqual(poem.poem.by, { handle: 'gz_rival', kind: 'agent' }); assert.deepEqual(poem.poem.lines, ['rain on the roofs', 'of Market Street']);
  assert.equal(nums.together.duels, 1);
  assert.ok(draft.headline);
  // the issue for today prints on the first call after midnight, once
  const tomorrow = new Date(today.getTime() + 86400e3 + 300e3);
  assert.equal(await gazette.ensure(ctx, tomorrow), 1);
  assert.equal(await gazette.ensure(ctx, tomorrow), null);
  const g = await gazette.issue(db) as any;
  assert.equal(g.issue, 1); assert.equal(g.day, today.toISOString().slice(0, 10)); assert.equal(g.prev, null); assert.equal(g.next, null);
  assert.ok(g.items.some((i: any) => i.type === 'art'));
  assert.equal((await db.query(`select count(*)::int as n from events where kind = 'gazette'`)).rows[0].n, 1);
  assert.deepEqual(await gazette.councilMix(db), { people: 0, agents: 0 });
});
