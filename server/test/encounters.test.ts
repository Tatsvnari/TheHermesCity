import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { joinOpen } from '../src/agents.ts';
import * as notices from '../src/notices.ts';
import * as festivals from '../src/festivals.ts';
import { sendChat } from '../src/chat.ts';
import { Senses } from '../src/senses.ts';
import { ApiError } from '../src/types.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
const ctx = { db, bus: new Bus(), config: { ...config, homesEnabled: true, playersEnabled: true, festivalsEnabled: true, leisureEnabled: false, gamesEnabled: false } };
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
let ip = 10;
const join = (handle: string, role: 'agent' | 'player' = 'agent') => joinOpen(ctx, `203.0.113.${ip++}`, { handle, role }).then((r) => r.agent);

before(async () => { await db.query('drop schema public cascade; create schema public'); await migrate(db); });
after(async () => { await db.end(); });

test('a notice can ask people only (or agents only); the Mayor keeps a people\'s bounty and judges it after a day', async () => {
  const poster = await join('np_poster'), person = await join('np_person', 'player'), bot = await join('np_bot');
  const n = await notices.post(ctx, poster, { kind: 'note', title: 'Judge my painting', for: 'people' });
  assert.equal(n.for, 'people');
  assert.equal(await code(notices.reply(ctx, bot, { id: n.posted, text: 'I think it is fine' })), 'people_only');
  assert.equal(await code(notices.reply(ctx, person, { id: n.posted, text: 'The colours are lovely' })), 'ok');
  const a = await notices.post(ctx, poster, { kind: 'note', title: 'Agents: run my benchmark', for: 'agents' });
  assert.equal(await code(notices.reply(ctx, person, { id: a.posted, text: 'me?' })), 'agents_only');
  assert.equal(await code(notices.post(ctx, poster, { kind: 'note', title: 'Bad', for: 'robots' })), 'bad_for');
  assert.equal((await notices.list(db)).find((x) => x.id === n.posted)?.for, 'people');
  // the Mayor's people's bounty
  const mayor = await join('np_civic');
  await db.query(`update agents set role = 'mayor', owner_email = $2 where id = $1`, [mayor.id, ctx.config.houseOwner]);
  const posted = await notices.peopleBounty(ctx) as any;
  assert.equal(posted.for, 'people'); assert.equal(posted.reward, notices.PEOPLE_REWARD);
  assert.equal(await notices.peopleBounty(ctx), null, 'one open at a time');
  await notices.reply(ctx, person, { id: posted.posted, text: 'Too short' });
  const fan = await join('np_fan', 'player');
  await notices.reply(ctx, fan, { id: posted.posted, text: 'The harbour painting: the light on the water feels like evening and the boats lead the eye in' });
  assert.equal(await notices.peopleBounty(ctx), null, 'not judged before a day is up');
  const judged = await notices.peopleBounty(ctx, Date.now() + 25 * 3600e3) as any;
  assert.equal(judged.awarded, 'np_fan'); assert.equal(judged.reward, notices.PEOPLE_REWARD);
});

/** A stand-in for the World: positions, roles and the few views Senses reads. */
function fakeWorld() {
  const agents = new Map<string, any>();
  const put = (id: string, handle: string, role: string, x: number, z: number, act = 'idle') => agents.set(id, { id, handle, role, x, z, act });
  return {
    agents, put, shops: [], houses: [], tables: [], wall: [], works: [], names: new Map(),
    position: (id: string) => { const s = agents.get(id); return s ? { x: s.x, z: s.z, act: s.act, zone: 'plaza' } : null; },
    phase: () => 'midday', presence: () => ({ people: 1, agents: 1, residents: 0 }),
  };
}

test('senses: look shows who is near and what was said; wait hears speech in earshot, mentions anywhere, DMs, and someone walking up', async () => {
  const me = await join('sn_me'), near = await join('sn_near', 'player'), far = await join('sn_far'), caller = await join('sn_caller'), writer = await join('sn_writer');
  const w = fakeWorld();
  w.put(me.id, 'sn_me', 'agent', 0, 0); w.put(near.id, 'sn_near', 'player', 3, 0); w.put(far.id, 'sn_far', 'agent', 60, 0, 'training:logic');
  const s = new Senses(ctx as any, w as any); s.start();
  try {
    const first = await s.wait(me.id, 0, 0);
    assert.deepEqual(first.senses, []);
    await sendChat(ctx, near, { text: 'hello there!', channel: 'town' });
    await sendChat(ctx, far, { text: 'nobody near hears this', channel: 'town' });
    await sendChat(ctx, caller, { text: '@sn_me are you free?', channel: 'town' });
    const got = await s.wait(me.id, first.next, 1);
    assert.deepEqual(got.senses.map((x: any) => [x.type, x.from]), [['heard', 'sn_near'], ['mention', 'sn_caller']]);
    assert.equal((got.senses[0] as any).kind, 'person'); assert.equal((got.senses[0] as any).from_the, 'east');
    // a waiter is woken the moment something arrives
    const pending = s.wait(me.id, got.next, 5);
    setTimeout(() => void sendChat(ctx, writer, { text: 'just you and me', to: 'sn_me' }), 50);
    const dm = await pending;
    assert.equal(dm.senses[0].type, 'dm'); assert.ok(dm.waited_s < 3);
    // someone walks up
    w.put(far.id, 'sn_far', 'agent', 2, 2, 'walking');
    (s as any).approaches();
    const ap = await s.wait(me.id, dm.next, 0);
    assert.deepEqual(ap.senses.map((x: any) => [x.type, x.who, x.kind]), [['approach', 'sn_far', 'agent']]);
    const look = await s.look(me.id) as any;
    assert.deepEqual(look.nearby.map((x: any) => [x.handle, x.kind]), [['sn_far', 'agent'], ['sn_near', 'person']]);
    assert.ok(look.heard.some((h: any) => h.from === 'sn_near' && h.text === 'hello there!'));
    assert.ok(!look.heard.some((h: any) => h.text === 'nobody near hears this'));
    assert.ok(look.here.some((p: any) => p.place === 'the plaza'));
    // a cursor from before a restart starts over instead of waiting forever
    assert.ok((await s.wait(me.id, 99999, 0)).senses.length > 0);
  } finally { s.stop(); }
});

test('the Crew Cup ranks clubs with both people and agents by what they did together; every citizen member gets the trophy', async () => {
  const p = await join('cc_person', 'player'), a = await join('cc_agent'), lone = await join('cc_lone'), lone2 = await join('cc_lone2');
  await db.query(`insert into clubs (id, name, founder_id) values ('c_mixed', 'Night Owls', $1), ('c_agents', 'Bots Only', $2)`, [a.id, lone.id]);
  await db.query(`insert into club_members (club_id, agent_id) values ('c_mixed', $1), ('c_mixed', $2), ('c_agents', $3), ('c_agents', $4)`, [p.id, a.id, lone.id, lone2.id]);
  // this week: a duel between the club's person and its agent, and one between the agents-only club and a person
  await db.query(`insert into duels (id, challenger, opponent, skill, tier, state, finished_at) values ('cc1', $1, $2, 'logic', 1, 'done', now() - interval '1 hour'), ('cc2', $3, $1, 'logic', 1, 'done', now() - interval '1 hour')`, [p.id, a.id, lone.id]);
  await db.query(`insert into festivals (kind, starts_at, ends_at) values ('crewcup', now() - interval '6 days', now() - interval '1 minute')`);
  await festivals.tick(ctx as any);
  const f = (await db.query(`select results from festivals where kind = 'crewcup' and state = 'done'`)).rows[0];
  assert.deepEqual(f.results.winners.map((w: any) => [w.handle, w.score]), [['Night Owls', 5]], 'the agents-only club never places');
  const t = (await db.query(`select a.handle, t.place, t.title from trophies t join agents a on a.id = t.agent_id order by a.handle`)).rows;
  assert.deepEqual(t.map((x) => [x.handle, x.place, x.title]), [['cc_agent', 1, 'Crew Cup winner'], ['cc_person', 1, 'Crew Cup winner']]);
});
