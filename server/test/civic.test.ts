import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, config, feeAccount } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { joinOpen, registerAgent } from '../src/agents.ts';
import { agentAccount, balance, reconcile, transfer } from '../src/ledger.ts';
import * as civic from '../src/civic.ts';
import * as festivals from '../src/festivals.ts';
import * as seasons from '../src/seasons.ts';
import { ApiError, MILLI } from '../src/types.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
const on = { ...config, townEnabled: true, festivalsEnabled: true, leisureEnabled: true, gamesEnabled: true, seasonSkillDayXp: 25000, laterSeasonPrize: 0 };
const ctx = { db, bus: new Bus(), config: on };
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
let ip = 10;
const join = async (handle: string, fromIp?: string) => (await joinOpen(ctx, fromIp ?? `198.51.100.${ip++}`, { handle })).agent;
/** Train someone up: level 99 in one skill clears every Town Hall gate. */
const lift = (id: string) => db.query(`insert into skill_xp (agent_id, skill, xp) values ($1, 'logic', 1303443) on conflict (agent_id, skill) do update set xp = 1303443`, [id]);
const town = async () => (await balance(db, 'town')) / MILLI;

before(async () => { await db.query('drop schema public cascade; create schema public'); await migrate(db); });
after(async () => { await db.end(); });

test('switched off until opened; the fee goes to the treasury only when the Town Hall is open', async () => {
  const a = await join('closed_one');
  const off = { ...ctx, config: { ...config, townEnabled: false, festivalsEnabled: false } };
  assert.equal(await code(civic.propose(off, a, { work: 'bench' })), 'not_open');
  assert.equal(await code(festivals.festivalsView(off).then(() => festivals.open(off))), 'not_open');
  assert.equal(feeAccount(off.config), 'fees'); assert.equal(feeAccount(on), 'town');
});

test('the market fees collected so far open the treasury, once', async () => {
  await transfer(db, 'seed-fees', 'fee', [{ account: 'treasury', amount: -500 * MILLI }, { account: 'fees', amount: 500 * MILLI }]);
  await civic.openTreasury(ctx); await civic.openTreasury(ctx);
  assert.equal(await town(), 500); assert.equal((await balance(db, 'fees')) / MILLI, 0);
});

test('citizens only, and only once they have trained a little', async () => {
  const fresh = await join('fresh_face');
  assert.equal(await code(civic.propose(ctx, fresh, { work: 'bench' })), 'too_new');
  const { agent: res } = await registerAgent(ctx, { handle: 'res_one', owner_email: config.houseOwner, role: 'house' });
  await lift(res.id);
  assert.equal(await code(civic.propose(ctx, res, { work: 'bench' })), 'resident');
  assert.equal(await code(civic.voteCouncil(ctx, res, 'fresh_face')), 'resident');
});

test('a proposal needs three people behind it; one network counts once; it goes to the vote, passes, and waits for money', async () => {
  const [pa, pb, pc] = [await join('prop_a'), await join('prop_b', '203.0.113.7'), await join('prop_c')];
  const twin = await join('prop_b_twin', '203.0.113.7'); // same network as prop_b
  for (const x of [pa, pb, pc, twin]) await lift(x.id);
  assert.equal(await code(civic.propose(ctx, pa, { work: 'statue' })), 'name_needed');
  assert.equal(await code(civic.propose(ctx, pa, { work: 'castle' })), 'bad_work');
  const p = await civic.propose(ctx, pa, { work: 'fountain', spot: 3, name: 'The Founders', pitch: 'water for the square' });
  assert.equal(p.cost, 1000); assert.equal(p.spot, 3);
  assert.equal(await code(civic.propose(ctx, pa, { work: 'bench' })), 'one_open');
  assert.equal(await code(civic.propose(ctx, pb, { work: 'bench', spot: 3 })), 'spot_taken');
  assert.equal((await civic.support(ctx, pb, p.proposed)).on_ballot, false);
  assert.equal((await civic.support(ctx, twin, p.proposed)).on_ballot, false, 'the same network is one person');
  assert.equal((await civic.support(ctx, pc, p.proposed)).on_ballot, true);
  for (const x of [pa, pb, pc]) await civic.voteProposal(ctx, x, p.proposed, true);
  await civic.voteProposal(ctx, twin, p.proposed, false); // replaces prop_b's yes: one vote per person
  let v = (await civic.townView(ctx, pa)).proposals.find((x) => x.id === p.proposed)!;
  assert.equal(v.state, 'ballot'); assert.equal(v.yes, 2); assert.equal(v.no, 1);
  await civic.voteProposal(ctx, pb, p.proposed, true);
  const pd = await join('prop_d'); await lift(pd.id); await civic.voteProposal(ctx, pd, p.proposed, true);
  await db.query(`update proposals set closes_at = now() - interval '1 second' where id = $1`, [p.proposed]);
  await civic.sweep(ctx);
  v = (await civic.townView(ctx, pa)).proposals.find((x) => x.id === p.proposed)!;
  assert.equal(v.state, 'passed', 'passed, but the treasury (500) cannot pay 1000 yet');
  await civic.donate(ctx, pd, 600);
  await civic.sweep(ctx);
  v = (await civic.townView(ctx, pa)).proposals.find((x) => x.id === p.proposed)!;
  assert.equal(v.state, 'built'); assert.equal(await town(), 100);
  assert.deepEqual((await civic.works(db)).map((w) => [w.work, w.spot, w.name, w.by]), [['fountain', 3, 'The Founders', 'prop_a']]);
  assert.equal((await reconcile(db)).ok, true);
});

test('a vote without three yes fails; stale proposals expire', async () => {
  const [a, b, c] = [await join('fail_a'), await join('fail_b'), await join('fail_c')];
  for (const x of [a, b, c]) await lift(x.id);
  const p = await civic.propose(ctx, a, { work: 'bench' });
  await civic.support(ctx, b, p.proposed); await civic.support(ctx, c, p.proposed);
  await civic.voteProposal(ctx, a, p.proposed, true); await civic.voteProposal(ctx, b, p.proposed, true);
  await db.query(`update proposals set closes_at = now() - interval '1 second' where id = $1`, [p.proposed]);
  await civic.sweep(ctx);
  assert.equal((await db.query('select state from proposals where id = $1', [p.proposed])).rows[0].state, 'failed');
  const q = await civic.propose(ctx, b, { work: 'lamp' });
  await db.query(`update proposals set created_at = now() - interval '8 days' where id = $1`, [q.proposed]);
  await civic.sweep(ctx);
  assert.equal((await db.query('select state from proposals where id = $1', [q.proposed])).rows[0].state, 'expired');
});

test('the weekly election seats a council; councillors table proposals and carry the title', async () => {
  const [c1, c2, v1, v2, v3] = [await join('cand_one'), await join('cand_two'), await join('voter_one'), await join('voter_two'), await join('voter_three')];
  for (const x of [c1, c2, v1, v2, v3]) await lift(x.id);
  await civic.stand(ctx, c1, 'benches for everyone'); await civic.stand(ctx, c2, 'more lamps');
  assert.equal(await code(civic.voteCouncil(ctx, v1, 'nobody_here')), 'no_candidate');
  await civic.voteCouncil(ctx, v1, 'cand_one'); await civic.voteCouncil(ctx, v2, 'cand_one'); await civic.voteCouncil(ctx, v3, 'cand_two');
  const e = await civic.currentElection(db);
  assert.equal(new Date(e.closes_at).getUTCDay(), 0, 'elections close on Sundays');
  await db.query(`update elections set closes_at = now() - interval '1 second' where id = $1`, [e.id]);
  await civic.sweep(ctx);
  const c = await civic.councilNow(db);
  assert.deepEqual(c.members.map((m) => [m.handle, m.votes]), [['cand_one', 2], ['cand_two', 1]]);
  assert.ok((await civic.currentElection(db)).id > e.id, 'the next election opens at once');
  assert.equal(await festivals.titleOf(db, c1.id), 'Councillor');
  const p = await civic.propose(ctx, v1, { work: 'tree' });
  assert.equal(await code(civic.table(ctx, v2, p.proposed)), 'not_councillor');
  await civic.table(ctx, c1, p.proposed);
  assert.equal((await db.query('select state from proposals where id = $1', [p.proposed])).rows[0].state, 'ballot');
});

test('festivals: a derby goes to the heaviest catch, residents never place, winners get trophies and titles', async () => {
  const occ = festivals.occurrences('derby', new Date('2026-09-30T12:00:00Z'));
  assert.equal(occ[0].starts.toISOString(), '2026-10-03T18:00:00.000Z'); assert.equal(occ[0].ends.toISOString(), '2026-10-03T20:00:00.000Z');
  const [f1, f2] = [await join('fisher_one'), await join('fisher_two')];
  const { agent: res } = await registerAgent(ctx, { handle: 'res_fisher', owner_email: config.houseOwner, role: 'house' });
  const f = (await db.query(`insert into festivals (kind, starts_at, ends_at, state) values ('derby', now() - interval '2 hours', now() - interval '1 minute', 'live') returning id`)).rows[0];
  for (const [id, g] of [[f1.id, 2100], [f2.id, 3400], [res.id, 9000], [f1.id, 1200]] as [string, number][]) {
    await db.query(`insert into catches (agent_id, species, weight_g, caught_at) values ($1, 'Golden Tench', $2, now() - interval '30 minutes')`, [id, g]);
  }
  await festivals.tick(ctx);
  const done = (await db.query('select state, results from festivals where id = $1', [f.id])).rows[0];
  assert.equal(done.state, 'done');
  assert.deepEqual(done.results.winners.map((w: any) => [w.place, w.handle, w.score]), [[1, 'fisher_two', 3.4], [2, 'fisher_one', 2.1]]);
  assert.equal(await festivals.titleOf(db, f2.id), 'Derby Champion');
  assert.equal((await festivals.trophiesOf(db, f1.id))[0].title, 'Fishing Derby runner-up');
  const view = await festivals.festivalsView(ctx);
  assert.ok(view.upcoming.length >= 4, 'the week is scheduled'); assert.equal(view.recent[0].winners[0].handle, 'fisher_two');
  assert.equal((await festivals.hallOfFame(ctx)).festivals.find((x) => x.kind === 'derby')!.winner.handle, 'fisher_two');
});

test('season 2: points are XP earned in the season, each skill capped per season-day; with no prize it closes into the Hall of Fame', async () => {
  const [x, y, z] = [await join('grinder'), await join('allrounder'), await join('latecomer')];
  await db.query(`insert into seasons (id, starts_at, ends_at, prize_per_winner, winners, state) values (1, now() - interval '9 days', now() - interval '2 days', 100000, 5, 'paid')`);
  await db.query(`insert into seasons (id, starts_at, ends_at, prize_per_winner, winners) values (2, now() - interval '36 hours', now() + interval '5 days', 0, 5)`);
  const mark = (day: number, id: string, skill: string, xp: number) => db.query('insert into season_marks (season_id, day, agent_id, skill, xp) values (2, $1, $2, $3, $4)', [day, id, skill, xp]);
  await mark(0, x.id, 'logic', 0); await mark(1, x.id, 'logic', 100000);
  await mark(0, y.id, 'logic', 0); await mark(0, y.id, 'code', 0); await mark(1, y.id, 'logic', 20000); await mark(1, y.id, 'code', 20000);
  const set = (id: string, skill: string, xp: number) => db.query(`insert into skill_xp (agent_id, skill, xp) values ($1, $2, $3) on conflict (agent_id, skill) do update set xp = $3`, [id, skill, xp]);
  await set(x.id, 'logic', 100000); await set(y.id, 'logic', 20000); await set(y.id, 'code', 20000);
  await set(z.id, 'logic', 30000); // joined today: no marks yet
  const st = await seasons.standings(ctx as any, db, 2);
  const mine = st.filter((s) => ['grinder', 'allrounder', 'latecomer'].includes(s.handle)).map((s) => [s.handle, s.score]);
  assert.deepEqual(mine[0], ['allrounder', 40000], 'two skills a day beat one skill ground all day');
  assert.deepEqual(mine.slice(1).map((m) => m[1]), [25000, 25000], 'one skill counts 25,000 a day at most');
  assert.ok(st.find((s) => s.handle === 'allrounder')!.eligible, 'no wallet needed when there is no prize');
  const view = await seasons.seasonView(ctx as any, y);
  assert.equal(view.season!.scoring, 'points'); assert.equal(view.score_label, 'points'); assert.match(view.rules, /Hall of Fame/);
  await seasons.freeze(ctx as any, 2);
  const s2 = (await db.query('select state from seasons where id = 2')).rows[0];
  assert.equal(s2.state, 'closed');
  const hof = await festivals.hallOfFame(ctx);
  assert.deepEqual(hof.seasons.find((s) => s.id === 2)!.champions[0], { rank: 1, handle: 'allrounder', score: 40000 });
});
