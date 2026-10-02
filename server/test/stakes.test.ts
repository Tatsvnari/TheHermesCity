import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { joinOpen } from '../src/agents.ts';
import * as projects from '../src/projects.ts';
import * as townjobs from '../src/townjobs.ts';
import * as civic from '../src/civic.ts';
import * as friends from '../src/friends.ts';
import * as gazette from '../src/gazette.ts';
import { XP_TABLE } from '../src/skills/defs.ts';
import { withTx } from '../src/db.ts';
import { agentAccount, ensureAccount, escrowAccount, postTransfer } from '../src/ledger.ts';
import { ApiError } from '../src/types.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
const ctx = { db, bus: new Bus(), config: { ...config, townEnabled: true, homesEnabled: true, playersEnabled: true } };
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
let ip = 10;
const join = (handle: string, role: 'agent' | 'player' = 'agent') => joinOpen(ctx, `198.51.100.${ip++}`, { handle, role }).then((r) => r.agent);
/** Pass n tasks a day for `days` days, ending yesterday (at noon UTC). */
const passTasks = (agentId: string, n: number, days: number) => db.query(`insert into training_tasks (id, agent_id, skill, tier, prompt, answer_key, state, xp_awarded, expires_at, answered_at)
  select 't_' || md5(random()::text), $1, 'logic', 1, '{}', '{}', 'passed', 5, now(), date_trunc('day', now()) - make_interval(days => d) + interval '12 hours'
    from generate_series(1, $3) d, generate_series(1, $2) k`, [agentId, n, days]);
const levelUp = (id: string) => db.query(`insert into skill_xp (agent_id, skill, xp) values ($1, 'logic', $2) on conflict (agent_id, skill) do update set xp = $2`, [id, XP_TABLE[40]]);

before(async () => { await db.query('drop schema public cascade; create schema public'); await migrate(db); });
after(async () => { await db.end(); });

test('town project: work is capped per person per day, it needs people among the builders, and finishing pays out trophies', async () => {
  await projects.sweep(ctx);
  const v0 = await projects.view(ctx, null);
  assert.equal(v0.project?.kind, 'footbridge');
  const [p1, p2, p3, bot] = [await join('pj_ann', 'player'), await join('pj_bob', 'player'), await join('pj_cy', 'player'), await join('pj_bot')];
  for (const a of [p1, p2, bot]) await projects.join(ctx, a);
  await db.query(`update project_members set joined_at = now() - interval '30 days'`);
  await passTasks(bot.id, 90, 20);               // a tireless agent: 90 a day, counted 40
  await passTasks(p1.id, 12, 10); await passTasks(p2.id, 12, 10);
  let v = await projects.view(ctx, bot);
  assert.equal(v.project!.builders.find((b) => b.handle === 'pj_bot')!.work, 800, 'capped at 40 a day');
  await projects.give(ctx, p1, 2000); await projects.give(ctx, p2, 1500);
  await projects.sweep(ctx);
  v = await projects.view(ctx, null);
  assert.equal(v.project!.progress.people, 2); assert.equal(v.project?.kind, 'footbridge', 'two people are not enough');
  assert.ok(v.project!.progress.work >= 1040 && v.project!.progress.seeds >= 3000);
  // a third person builds, and the work reaches its goal too
  await projects.join(ctx, p3); await db.query(`update project_members set joined_at = now() - interval '30 days' where agent_id = $1`, [p3.id]);
  await passTasks(p3.id, 20, 10);
  await projects.sweep(ctx); // finishes it
  assert.equal((await projects.view(ctx, null)).project, null);
  await projects.sweep(ctx); // opens the next
  assert.equal((await projects.view(ctx, null)).project?.kind, 'lanterns', 'finished, and the next one opened');
  const done = await projects.doneKinds(db);
  assert.deepEqual(done, ['footbridge']);
  const t = (await db.query(`select a.handle from trophies t join agents a on a.id = t.agent_id where t.title = 'Builder of The Footbridge' order by a.handle`)).rows.map((r) => r.handle);
  assert.deepEqual(t, ['pj_ann', 'pj_bob', 'pj_bot', 'pj_cy']);
  assert.equal(await code(projects.give(ctx, p1, 0)), 'bad_amount');
});

test('town jobs: stand and vote with the election, seated when it closes; the jury settles a dispute; librarian and crier', async () => {
  const [ju1, ju2, lib, cri, voter] = [await join('tj_ju1', 'player'), await join('tj_ju2'), await join('tj_lib', 'player'), await join('tj_cri'), await join('tj_voter', 'player')];
  for (const a of [ju1, ju2, lib, cri, voter]) await levelUp(a.id);
  await civic.sweep(ctx); // opens the election
  await townjobs.stand(ctx, ju1, 'juror', 'fair and quick'); await townjobs.stand(ctx, ju2, 'juror', '');
  await townjobs.stand(ctx, lib, 'librarian', 'I read everything'); await townjobs.stand(ctx, cri, 'crier', 'loud');
  assert.equal(await code(townjobs.stand(ctx, ju1, 'crier', '')), 'one_job');
  for (const [job, h] of [['juror', 'tj_ju1'], ['librarian', 'tj_lib'], ['crier', 'tj_cri']]) await townjobs.vote(ctx, voter, job, h);
  await townjobs.vote(ctx, ju1, 'juror', 'tj_ju2'); // one vote per person and job: a second juror needs a second voter
  await db.query(`update elections set closes_at = now() - interval '1 minute' where state = 'open'`);
  await civic.sweep(ctx);
  const h = await townjobs.holders(db);
  assert.deepEqual(h.jobs.juror.map((x) => x.handle).sort(), ['tj_ju1', 'tj_ju2']);
  assert.deepEqual(h.jobs.librarian.map((x) => [x.handle, x.kind]), [['tj_lib', 'person']]);
  // a dispute: two jurors agree and it settles
  const buyer = await join('tj_buyer'), seller = await join('tj_seller');
  await db.query(`insert into listings (id, agent_id, name, description, price, plot) values ('l_tj', $1, 'Sort a list', 'sorts', 1000, 3)`, [seller.id]);
  await db.query(`insert into jobs (id, idem_key, listing_id, buyer_id, seller_id, input, output, price, state, deadline, updated_at) values ('j_tj', 'k_tj', 'l_tj', $1, $2, '{"items":[3,1]}', '{"items":[3,1]}', 1000, 'disputed', now() + interval '1 day', now())`, [buyer.id, seller.id]);
  await withTx(db, async (tx) => { await ensureAccount(tx, escrowAccount('j_tj'), 'system'); await postTransfer(tx, 'escrow_in:j_tj', 'escrow_in', [{ account: agentAccount(buyer.id), amount: -1000 }, { account: escrowAccount('j_tj'), amount: 1000 }], 'test escrow'); });
  const cs = await townjobs.cases(ctx, ju1);
  assert.equal(cs.cases[0].job_id, 'j_tj'); assert.equal(cs.cases[0].buyer.handle, 'tj_buyer');
  assert.equal(await code(townjobs.cases(ctx, voter)), 'not_holder');
  assert.equal((await townjobs.juryVote(ctx, ju1, 'j_tj', 'buyer', 'not sorted')).settled, null);
  assert.equal(await code(townjobs.juryVote(ctx, ju2, 'j_tj', 'banana' as any, '')), 'bad_verdict');
  const r = await townjobs.juryVote(ctx, ju2, 'j_tj', 'buyer', 'the list is not sorted');
  assert.equal(r.settled, 'buyer');
  const j = (await db.query(`select state, verdict, note from jobs where id = 'j_tj'`)).rows[0];
  assert.deepEqual([j.state, j.verdict], ['settled', 'buyer']); assert.match(j.note, /^jury: the jury, 2 of 2/);
  assert.equal(await code(townjobs.juryVote(ctx, ju1, 'j_tj', 'seller', '')), 'not_disputed');
  // the librarian picks; the crier cries once a day; both print in the Gazette
  const art = (await db.query(`insert into artworks (agent_id, title, pixels) values ($1, 'Pond', $2) returning id`, [ju1.id, '0a'.repeat(128)])).rows[0].id;
  assert.equal((await townjobs.pick(ctx, lib, 'art', Number(art), 'calm water')).picked, 'Pond');
  assert.equal(await code(townjobs.pick(ctx, cri, 'art', Number(art), '')), 'not_holder');
  assert.equal((await townjobs.cry(ctx, cri, 'The Footbridge needs builders!')).cried, 'The Footbridge needs builders!');
  assert.equal(await code(townjobs.cry(ctx, cri, 'again')), 'once_a_day');
  const now = new Date(), today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const g = await gazette.compose(ctx as any, today);
  assert.equal(g.items[0].type, 'crier');
  assert.ok(g.items.some((i) => i.type === 'picks' && (i as any).picks[0].title === 'Pond'));
});

test('friends are mutual; regulars and the story of two count what they did together', async () => {
  const a = await join('fr_amy', 'player'), b = await join('fr_bea'), c = await join('fr_cal');
  assert.equal((await friends.add(ctx, a, 'fr_bea')).friends, false);
  assert.deepEqual((await friends.of(ctx, b.id)).asked_you.map((x) => x.handle), ['fr_amy']);
  assert.equal((await friends.add(ctx, b, 'fr_amy')).friends, true);
  assert.deepEqual((await friends.of(ctx, a.id)).friends.map((x) => [x.handle, x.kind]), [['fr_bea', 'agent']]);
  assert.equal(await code(friends.add(ctx, a, 'fr_amy')), 'self');
  await db.query(`insert into duels (id, challenger, opponent, skill, tier, state, winner, finished_at) values ('fd1', $1, $2, 'logic', 1, 'done', $1, now()), ('fd2', $2, $1, 'logic', 1, 'done', $1, now())`, [a.id, b.id]);
  await db.query(`insert into letters (from_id, to_id, body) values ($1, $2, 'hi'), ($2, $1, 'hello back')`, [a.id, b.id]);
  const s = await friends.story(ctx, 'fr_amy', 'fr_bea');
  assert.equal(s.duels.count, 2); assert.equal(s.duels.a_won, 2); assert.ok(s.letters >= 2); assert.ok(s.friends_since);
  assert.ok(s.story.some((l) => l.startsWith('2 duels')));
  assert.deepEqual((await friends.story(ctx, 'fr_amy', 'fr_cal')).story, ['fr_amy and fr_cal have not crossed paths yet.']);
  await friends.remove(ctx, a, 'fr_bea');
  assert.deepEqual((await friends.of(ctx, a.id)).friends, []);
  void c;
});
