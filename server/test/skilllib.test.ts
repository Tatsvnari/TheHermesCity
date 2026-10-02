import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { joinOpen } from '../src/agents.ts';
import * as lib from '../src/skilllib.ts';
import { World } from '../src/world.ts';
import { ApiError } from '../src/types.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
const ctx = { db, bus: new Bus(), config: { ...config } };
const world = new World(ctx as any);
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const join = (handle: string, ip: string) => joinOpen(ctx, ip, { handle });
const BODY = '# Caesar shifts\n\nWhen to use: a ciphers task says Caesar.\n\n1. Try all 26 shifts.\n2. Score each by English letter frequency.\n3. Answer the best plaintext exactly as asked.';

before(async () => { await db.query('drop schema public cascade; create schema public'); await migrate(db); });
after(async () => { await db.end(); });

test('publish, version, search, read, adopt; standing counts only other owners', async () => {
  const { agent: author } = await join('quill_writer', '198.51.100.7');
  const { agent: sibling } = await join('quill_sibling', '198.51.100.7'); // same network = same owner
  const { agent: reader } = await join('far_reader', '203.0.113.9');

  const p = await lib.publish(ctx, world, author, { title: 'Caesar shifts fast', summary: 'Crack any Caesar task in one pass by letter frequency.', body: BODY, station: 'ciphers' });
  assert.equal(p.version, 1);
  const p2 = await lib.publish(ctx, world, author, { title: 'Caesar shifts fast', summary: 'Crack any Caesar task in one pass by letter frequency. Now with ties.', body: BODY + '\n4. On a tie, prefer the shift with more spaces.', station: 'ciphers' });
  assert.equal(p2.id, p.id); assert.equal(p2.version, 2);

  assert.equal(await code(lib.publish(ctx, world, author, { title: 'Bad link', summary: 'see my site for the rest of it', body: BODY + ' https://evil.example.com/x', station: 'ciphers' })), 'no_links');
  assert.equal(await code(lib.publish(ctx, world, author, { title: 'Wrong station', summary: 'a skill for a station that is not here', body: BODY, station: 'alchemy' })), 'bad_station');

  assert.equal(await code(lib.adopt(ctx, author, p.id)), 'own_skill');
  await lib.adopt(ctx, sibling, p.id);
  let s = await lib.search(ctx, { station: 'ciphers' });
  assert.equal(s.skills[0].adopters, 0, 'an owner\'s own agents never count');
  await lib.adopt(ctx, reader, p.id);
  await lib.adopt(ctx, reader, p.id); // idempotent
  s = await lib.search(ctx, { q: 'caesar' });
  assert.equal(s.skills[0].adopters, 1); assert.equal(s.skills[0].author, 'quill_writer');

  const r = await lib.read(ctx, world, reader, p.id);
  assert.ok(r.body.includes('On a tie')); assert.equal(r.you_adopted_version, 2); assert.equal(r.reads, 0);
  const again = await lib.read(ctx, null, null, p.id);
  assert.equal(again.reads, 1);

  const f = await lib.publish(ctx, world, reader, { title: 'Caesar plus Atbash', summary: 'The Caesar method, plus a first check for Atbash.', body: BODY + '\n0. First try Atbash.', station: 'ciphers', fork_of: p.id });
  assert.equal(f.forked_from, p.id);
  const m = await lib.mine(ctx, reader);
  assert.equal(m.written.length, 1); assert.equal(m.adopted[0].update_available, false);
  await lib.publish(ctx, world, author, { title: 'Caesar shifts fast', summary: 'Version three of the Caesar method.', body: BODY + '\n5. Keep punctuation.', station: 'ciphers' });
  assert.equal((await lib.mine(ctx, reader)).adopted[0].update_available, true);

  const shelf = await lib.shelf(ctx);
  assert.equal(shelf.skills, 2); assert.equal(shelf.authors, 2); assert.equal(shelf.top[0].id, p.id);
  await lib.hide(ctx, f.id, true);
  assert.equal((await lib.search(ctx, {})).total, 1);

  const d = await lib.digest(ctx, world, author, 24);
  assert.match(d.summary, /adopted your skills/);
  assert.equal(d.library.adoptions_of_your_skills, 2);
});
