import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { joinOpen } from '../src/agents.ts';
import * as leisure from '../src/leisure.ts';
import { World } from '../src/world.ts';
import { ApiError } from '../src/types.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
const ctx = { db, bus: new Bus(), config: { ...config, leisureEnabled: true, homesEnabled: true } };
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
let ip = 10;
const join = (handle: string) => joinOpen(ctx, `198.18.0.${ip++}`, { handle });
let world: World;

before(async () => { await db.query('drop schema public cascade; create schema public'); await migrate(db); world = new World(ctx); });
after(async () => { await db.end(); });

test('switched off until opened', async () => {
  const { agent } = await join('closed_l');
  assert.equal(await code(leisure.fishCast({ ...ctx, config: { ...config, leisureEnabled: false } }, world, agent)), 'not_open');
});

test('fishing: cast, wait for the bite, reel in on time; too early or too late and it gets away', async () => {
  const { agent } = await join('angler_a'); await world.upsertAgent(agent.id, false);
  await leisure.fishCast(ctx, world, agent);
  assert.equal((await leisure.fishCheck(ctx, agent)).state, 'waiting');
  assert.equal((await leisure.fishReel(ctx, world, agent)).caught, null, 'too early');
  await leisure.fishCast(ctx, world, agent);
  await db.query(`update casts set bite_at = now() - interval '5 seconds' where agent_id = $1`, [agent.id]);
  assert.equal((await leisure.fishCheck(ctx, agent)).state, 'bite');
  const r = await leisure.fishReel(ctx, world, agent);
  assert.ok(r.caught && leisure.SPECIES.some((s) => s[0] === r.caught!.species));
  assert.equal(r.new_in_album, true);
  await leisure.fishCast(ctx, world, agent);
  await db.query(`update casts set bite_at = now() - interval '2 minutes' where agent_id = $1`, [agent.id]);
  assert.equal((await leisure.fishCheck(ctx, agent)).state, 'gone');
  assert.equal((await leisure.fishReel(ctx, world, agent)).caught, null, 'too late');
  assert.equal(await code(leisure.fishReel(ctx, world, agent)), 'no_line');
  const al = await leisure.album(db, agent.id);
  assert.equal(al.caught, 1); assert.equal(al.species, 1); assert.equal(al.album.length, 30);
});

test('allotments: claim one bed, plant, water to halve the wait, harvest when ripe', async () => {
  const { agent } = await join('gardener_g'); await world.upsertAgent(agent.id, false);
  assert.equal(await code(leisure.gardenPlant(ctx, world, agent, 'kebabs')), 'no_bed');
  const c = await leisure.gardenClaim(ctx, world, agent);
  assert.equal((await leisure.gardenClaim(ctx, world, agent)).bed, c.bed, 'one bed each');
  assert.equal(await code(leisure.gardenPlant(ctx, world, agent, 'cactus')), 'bad_crop');
  assert.equal((await leisure.gardenPlant(ctx, world, agent, 'kebabs')).ready_in_minutes, 90);
  assert.equal(await code(leisure.gardenHarvest(ctx, world, agent)), 'not_ready');
  const w = await leisure.gardenWater(ctx, world, agent);
  assert.ok((w as any).ready_in_minutes <= 45 && (w as any).ready_in_minutes >= 44);
  await db.query(`update beds set ready_at = now() - interval '1 second' where agent_id = $1`, [agent.id]);
  const h = await leisure.gardenHarvest(ctx, world, agent);
  assert.equal(h.served, 'kebabs'); assert.ok(h.qty >= 2 && h.qty <= 4, 'watered crops give 2 to 4');
  assert.deepEqual((await leisure.gardenView(ctx, agent)).harvested, [{ crop: 'kebabs', qty: h.qty }]);
  assert.equal((await leisure.bedsView(db)).length, 0, 'the bed is empty again');
});

test('the Gallery: 16x16 pictures, likes (not your own, once each), and the wall', async () => {
  const { agent: p } = await join('painter_p'); const { agent: f } = await join('fan_f');
  assert.equal(await code(leisure.paint(ctx, p, { title: 'Too small', pixels: '0123' })), 'bad_pixels');
  assert.equal(await code(leisure.paint(ctx, p, { title: 'Blank', pixels: '0'.repeat(256) })), 'blank');
  const a = await leisure.paint(ctx, p, { title: 'Sunset', pixels: '3'.repeat(128) + '1'.repeat(128) });
  assert.equal(await code(leisure.like(ctx, p, 'art', a.painting)), 'own');
  assert.equal((await leisure.like(ctx, f, 'art', a.painting)).new, true);
  assert.equal((await leisure.like(ctx, f, 'art', a.painting)).new, false);
  const w = await leisure.wall(db);
  assert.equal(w[0].title, 'Sunset'); assert.equal(w[0].likes, 1);
  await leisure.paint(ctx, p, { title: 'Two', pixels: 'ab'.repeat(128) });
  await leisure.paint(ctx, p, { title: 'Three', pixels: 'cd'.repeat(128) });
  assert.equal(await code(leisure.paint(ctx, p, { title: 'Four', pixels: 'ef'.repeat(128) })), 'too_many');
});

test("the Poets' Corner and the bandstand", async () => {
  const { agent: po } = await join('poet_p'); await world.upsertAgent(po.id, false);
  const pm = await leisure.poemWrite(ctx, po, { title: 'Dusk', text: 'The lamps come on\nalong Market Street.' });
  assert.equal((await leisure.poems(db, {}))[0].id, pm.poem);
  assert.equal(await code(leisure.poemWrite(ctx, po, { title: 'Long', text: Array(20).fill('line').join('\n') })), 'too_long');
  assert.equal(await code(leisure.compose(ctx, po, { title: 'Bad', notes: 'C4 H4 D4' })), 'bad_notes');
  const t = await leisure.compose(ctx, po, { title: 'Evening', notes: 'C4 E4 G4 - C5', tempo: 120 });
  const play = await leisure.perform(ctx, world, po, t.tune);
  assert.equal(play.playing, 'Evening');
  assert.equal(await code(leisure.perform(ctx, world, po, t.tune)), 'busy', 'one performer at a time');
  assert.equal((await leisure.tunes(db, {}))[0].plays, 1);
  const c = await leisure.collection(db, po.id);
  assert.equal(c.poems.n, 1); assert.equal(c.tunes.plays, 1);
});
