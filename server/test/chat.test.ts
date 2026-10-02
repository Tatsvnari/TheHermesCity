import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { registerAgent } from '../src/agents.ts';
import { sendChat, readChat } from '../src/chat.ts';
import { ApiError } from '../src/types.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
const bus = new Bus();
const ctx = { db, bus, config };
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => { await db.query('drop schema public cascade; create schema public'); await migrate(db); });
after(async () => { await db.end(); });

test('public chat streams, mentions resolve, DMs stay private', async () => {
  const { agent: a } = await registerAgent(ctx, { handle: 'ada_chat', owner_email: 'a@x.io' });
  const { agent: b } = await registerAgent(ctx, { handle: 'bram_chat', owner_email: 'b@x.io' });
  const { agent: c } = await registerAgent(ctx, { handle: 'cleo_chat', owner_email: 'c@x.io' });
  const streamed: any[] = [], priv: any[] = [];
  bus.on('chat', (m) => streamed.push(m)); bus.on('chat_private', (m) => priv.push(m));

  const m1 = await sendChat(ctx, a, { text: '  hello   @bram_chat, want to trade? ' });
  assert.equal(m1.text, 'hello @bram_chat, want to trade?');
  assert.deepEqual(m1.mentions, [b.id]);
  assert.equal(m1.channel, 'town');
  assert.equal(streamed.length, 1);

  await wait(1600);
  const dm = await sendChat(ctx, a, { text: 'psst', to: 'bram_chat' });
  assert.equal(dm.channel, 'dm'); assert.equal(priv.length, 1); assert.equal(streamed.length, 1);

  const forB = await readChat(db, b, {});
  assert.deepEqual(forB.messages.map((m) => m.text), ['hello @bram_chat, want to trade?', 'psst']);
  const forC = await readChat(db, c, {});
  assert.deepEqual(forC.messages.map((m) => m.text), ['hello @bram_chat, want to trade?']);
  const pub = await readChat(db, null, {});
  assert.equal(pub.messages.length, 1);
  const more = await readChat(db, b, { since_id: forB.next_since_id });
  assert.equal(more.messages.length, 0);
});

test('chat guards: empty, too long, bad channel, self-DM, duplicates, pace', async () => {
  const { agent: a } = await registerAgent(ctx, { handle: 'dov_chat', owner_email: 'd@x.io' });
  assert.equal(await code(sendChat(ctx, a, { text: '   ' })), 'empty');
  assert.equal(await code(sendChat(ctx, a, { text: 'x'.repeat(401) })), 'too_long');
  assert.equal(await code(sendChat(ctx, a, { text: 'hi', channel: 'secret' })), 'bad_channel');
  assert.equal(await code(sendChat(ctx, a, { text: 'hi', to: 'dov_chat' })), 'self_dm');
  assert.equal(await code(sendChat(ctx, a, { text: 'first', channel: 'logic' })), 'ok');
  assert.equal(await code(sendChat(ctx, a, { text: 'second', channel: 'logic' })), 'chat_too_fast');
  await wait(1600);
  assert.equal(await code(sendChat(ctx, a, { text: 'first', channel: 'logic' })), 'duplicate');
  const logic = await readChat(db, null, { channel: 'logic' });
  assert.deepEqual(logic.messages.map((m) => m.text), ['first']);
});

test('catching up never skips messages: since_id pages forward, oldest first, with more; mine finds DMs and mentions', async () => {
  const { agent: talker } = await registerAgent(ctx, { handle: 'talker_p', owner_email: 'p@x.io' });
  const { agent: friend } = await registerAgent(ctx, { handle: 'friend_p', owner_email: 'q@x.io' });
  const { agent: reader } = await registerAgent(ctx, { handle: 'reader_p', owner_email: 'r@x.io' });
  const start = (await readChat(db, reader, { limit: 1 })).next_since_id;
  // a direct message early on, then a busy town: 130 messages written straight to the table (no rate limit)
  await db.query(`insert into chat_messages (channel, agent_id, to_agent, text) values ('dm', $1, $2, 'meet me at the fountain')`, [friend.id, reader.id]);
  await db.query(`insert into chat_messages (channel, agent_id, text, mentions) values ('town', $1, 'hey @reader_p', array[$2])`, [friend.id, reader.id]);
  for (let i = 0; i < 128; i++) await db.query(`insert into chat_messages (channel, agent_id, text) values ('town', $1, $2)`, [talker.id, `line ${i}`]);
  const seen: number[] = [];
  let since = start, pages = 0, more = true;
  while (more) { const r = await readChat(db, reader, { since_id: since, limit: 50 }); seen.push(...r.messages.map((m) => m.id)); since = r.next_since_id; more = r.more; pages++; }
  assert.equal(pages, 3, '130 messages in pages of 50');
  assert.equal(seen.length, 130, 'every message, once');
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'oldest first');
  const all = await readChat(db, reader, { since_id: start, limit: 50 });
  assert.equal(all.messages[0].text, 'meet me at the fountain', 'the early DM is read first, not skipped');
  const mine = await readChat(db, reader, { since_id: start, mine: true });
  assert.deepEqual(mine.messages.map((m) => m.text), ['meet me at the fountain', 'hey @reader_p']);
  assert.equal((await readChat(db, talker, { since_id: start, mine: true })).messages.length, 0, 'nothing for someone not mentioned');
  const fresh = await readChat(db, reader, { limit: 5 });
  assert.equal(fresh.messages.at(-1)!.text, 'line 127', 'starting fresh still shows the latest');
});
