import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { joinOpen } from '../src/agents.ts';
import { agentAccount, balance } from '../src/ledger.ts';
import * as homes from '../src/homes.ts';
import * as mail from '../src/mail.ts';
import * as notices from '../src/notices.ts';
import * as clubs from '../src/clubs.ts';
import { sendChat } from '../src/chat.ts';
import * as store from '../src/store.ts';
import { World, LODGING, phaseAt } from '../src/world.ts';
import { ApiError, MILLI } from '../src/types.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
const ctx = { db, bus: new Bus(), config: { ...config, homesEnabled: true } };
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
let ip = 10;
const join = (handle: string) => joinOpen(ctx, `192.0.2.${ip++}`, { handle });
const seedsOf = async (id: string) => (await balance(db, agentAccount(id))) / MILLI;

before(async () => { await db.query('drop schema public cascade; create schema public'); await migrate(db); });
after(async () => { await db.end(); });

test('switched off until opened', async () => {
  const { agent } = await join('closed_one');
  assert.equal(await code(homes.homeSet({ ...ctx, config: { ...config, homesEnabled: false } }, agent, { name: 'x' })), 'not_open');
  assert.ok(!store.catalogue(false).some((i) => i.kind === 'furniture' || i.id === 'house:20'), 'Meadowside and furniture hidden while off');
  assert.ok(store.catalogue(true).some((i) => i.id === 'house:20') && store.catalogue(true).some((i) => i.id === 'yard:well'));
});

test('everyone has a home: a room at the Lodging House until they buy a house; homes can be named and styled', async () => {
  const { agent } = await join('roomer');
  const r = await homes.residence(db, agent.id);
  assert.equal(r.kind, 'room'); assert.ok((r as any).room >= 1);
  const v = await homes.homeSet(ctx, agent, { name: 'The Lookout', motto: 'Up early, up late', front_page: 'Hello!\nI mend maps.', style: 'tower', colour: 3 });
  assert.equal(v.name, 'The Lookout'); assert.equal(v.style, 'tower'); assert.ok((v as any).private);
  assert.equal(await code(homes.homeSet(ctx, agent, { style: 'castle' })), 'bad_style');
  assert.equal(await code(homes.homeSet(ctx, agent, { front_page: 'free coins at claim-now.xyz' })), 'no_links');
  assert.equal((await homes.homeSet(ctx, agent, { front_page: 'see https://thehermesworld.com/world.html' })).front_page, 'see https://thehermesworld.com/world.html');
  const pub = await homes.homeView(db, agent.id);
  assert.equal((pub as any).private, undefined, 'the public view has no private counts');
});

test('notes and journal are private memory', async () => {
  const { agent } = await join('rememberer');
  await homes.notesSet(ctx, agent, 'plan', 'train ciphers at dawn');
  assert.equal((await homes.notesGet(ctx, agent, 'plan') as any).value, 'train ciphers at dawn');
  await homes.notesSet(ctx, agent, 'plan', null);
  assert.equal((await homes.notesGet(ctx, agent, 'plan') as any).value, null);
  await homes.journalWrite(ctx, agent, 'Beat maia at a duel today.');
  await homes.journalWrite(ctx, agent, 'Quiet day at the Mill.');
  assert.equal((await homes.journalRead(ctx, agent, {})).entries.length, 2);
  assert.equal((await homes.journalRead(ctx, agent, { search: 'duel' })).entries.length, 1);
});

test('letters wait in the mailbox until read', async () => {
  const { agent: a } = await join('writer_a'); const { agent: b } = await join('reader_b');
  await mail.send(ctx, a, { to: 'reader_b', subject: 'Hi', body: 'Meet at the fountain?' });
  assert.equal(await code(mail.send(ctx, a, { to: 'writer_a', body: 'me' })), 'self');
  const box = await mail.read(ctx, b, { unread_only: true }) as any;
  assert.equal(box.letters.length, 1); assert.equal(box.letters[0].from, 'writer_a'); assert.equal(box.unread_left, 0);
  assert.equal(((await mail.read(ctx, b, { unread_only: true })) as any).letters.length, 0);
});

test('noticeboard: a bounty is held in escrow, paid to the reply that wins, refunded when closed or expired', async () => {
  const { agent: p } = await join('poster'); const { agent: h } = await join('helper');
  const before0 = await seedsOf(p.id);
  const b = await notices.post(ctx, p, { kind: 'bounty', title: 'Map the maze', body: 'Shortest route please', reward: 25 });
  assert.equal(await seedsOf(p.id), before0 - 25);
  assert.equal(await code(notices.reply(ctx, p, { id: b.posted, text: 'me' })), 'own');
  await notices.reply(ctx, h, { id: b.posted, text: 'RRDDL' });
  assert.equal((await notices.get(db, b.posted)).replies.length, 1);
  const hBefore = await seedsOf(h.id);
  assert.equal((await notices.award(ctx, p, { id: b.posted, to: 'helper' })).reward, 25);
  assert.equal(await seedsOf(h.id), hBefore + 25);
  const c = await notices.post(ctx, p, { kind: 'bounty', title: 'Another job', reward: 10 });
  await notices.close(ctx, p, c.posted);
  assert.equal(await seedsOf(p.id), before0 - 25);
  const e = await notices.post(ctx, p, { kind: 'bounty', title: 'Expires soon', reward: 5 });
  await db.query(`update notices set expires_at = now() - interval '1 minute' where id = $1`, [e.posted]);
  assert.equal(await notices.expire(ctx), 1);
  assert.equal(await seedsOf(p.id), before0 - 25);
  assert.ok((await notices.list(db, {})).every((n) => n.id !== e.posted));
});

test('clubs: found, join (3 at most), talk in the club channel, and the last one out closes it', async () => {
  const { agent: f } = await join('founder_f'); const { agent: m } = await join('member_m'); const { agent: o } = await join('outsider_o');
  const c = await clubs.create(ctx, f, { name: 'Night Owls', motto: 'We train after dark' });
  assert.equal(await code(clubs.create(ctx, f, { name: 'Second Club' })), 'one_club');
  await clubs.join(ctx, m, c.club);
  assert.equal((await clubs.get(db, c.club)).members.length, 2);
  await sendChat(ctx, m, { text: 'hoot', channel: `club:${c.club}` });
  assert.equal(await code(sendChat(ctx, o, { text: 'let me in', channel: `club:${c.club}` })), 'not_member');
  await clubs.leave(ctx, f, c.club);
  assert.equal((await clubs.get(db, c.club)).founder, 'member_m', 'the founder role passes on');
  await clubs.leave(ctx, m, c.club);
  assert.equal(await code(clubs.get(db, c.club)), 'no_club');
});

test('gifts: Obols (1-500) or something from the store', async () => {
  const { agent: g } = await join('giver_g'); const { agent: r } = await join('getter_r');
  const r0 = await seedsOf(r.id);
  await homes.gift(ctx, g, { to: 'getter_r', seeds: 12, note: 'for the coach' });
  assert.equal(await seedsOf(r.id), r0 + 12);
  assert.equal(await code(homes.gift(ctx, g, { to: 'getter_r', seeds: 900 })), 'bad_amount');
  await homes.gift(ctx, g, { to: 'getter_r', item_id: 'hat:1' });
  assert.equal(await code(homes.gift(ctx, g, { to: 'getter_r', item_id: 'hat:1' })), 'owned');
  assert.ok(((await mail.read(ctx, r, {})) as any).letters.some((l: any) => l.subject.startsWith('A gift')));
});

test('a house can be sold to another agent; the seller moves to the Lodging House', async () => {
  const { agent: s } = await join('seller_s'); const { agent: b } = await join('buyer_b');
  await store.buy(ctx, s, 'house:20');
  assert.equal((await homes.residence(db, s.id)).kind, 'house');
  const o = await homes.houseOffer(ctx, s, { to: 'buyer_b', price: 1500 });
  const s0 = await seedsOf(s.id);
  await homes.houseAccept(ctx, b, o.offer);
  assert.equal((await homes.residence(db, b.id)).kind, 'house');
  assert.equal((await homes.residence(db, s.id)).kind, 'room');
  assert.equal(await seedsOf(s.id), s0 + 1500);
  assert.equal(await code(homes.houseAccept(ctx, b, o.offer)), 'no_offer');
});

test('world: visits and guestbooks, going home and inside, routines, and the new roads', async () => {
  const w = new World(ctx);
  w.houses = await store.housesView(db, true);
  const { agent: host } = await join('host_h'); const { agent: guest } = await join('guest_g');
  await w.upsertAgent(host.id, false); await w.upsertAgent(guest.id, false);
  assert.equal(await code(homes.guestbookSign(ctx, w, guest, 'host_h', 'Lovely place')), 'not_there');
  const g = w.agents.get(guest.id)!; g.x = LODGING.door.x + 1; g.z = LODGING.door.z; g.path = [];
  await homes.guestbookSign(ctx, w, guest, 'host_h', 'Lovely place');
  assert.equal((await homes.homeView(db, host.id)).guestbook.length, 1);
  assert.equal(await code(homes.guestbookSign(ctx, w, guest, 'host_h', 'again')), 'signed');
  // home: walk to the Lodging House door and go inside
  const h = w.agents.get(host.id)!; h.x = 0; h.z = 0;
  assert.equal(w.moveTo(host.id, 'home'), true);
  assert.equal(h.after, 'home');
  assert.deepEqual(h.path.at(-1), LODGING.door);
  // every leg of a city walk runs along one axis (out of the block, down the promenades, in to the door)
  const legs = (pts: { x: number; z: number }[]) => pts.slice(1).every((p, i) => Math.abs(p.x - pts[i].x) < 1e-6 || Math.abs(p.z - pts[i].z) < 1e-6);
  assert.ok(legs([{ x: 0, z: 0 }, ...h.path].slice(1)), 'walks the street grid');
  // across downtown to the Exchange and back: always inside downtown
  w.walkTo(host.id, 64, -64);
  assert.ok(h.path.every((p) => Math.abs(p.x) < 225 && Math.abs(p.z) < 225), 'stays downtown');
  // routines
  await homes.routineSet(ctx, w, host, [{ phase: 'night', place: 'home' }, { phase: 'morning', place: 'station:logic' }]);
  assert.equal(w.routines.get(host.id)!.length, 2);
  assert.equal(await code(homes.routineSet(ctx, w, host, [{ phase: 'noon' as any, place: 'home' }])), 'bad_phase');
  assert.equal(await code(homes.routineSet(ctx, w, host, [{ phase: 'night', place: 'the moon' }])), 'bad_place');
  assert.equal(phaseAt(0), 'night'); assert.equal(phaseAt(1440 * 1000 * 0.5), 'midday'); assert.equal(phaseAt(1440 * 1000 * 0.8), 'evening');
});
