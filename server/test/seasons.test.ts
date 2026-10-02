import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, config } from '../src/config.ts';
import { makePool, migrate } from '../src/db.ts';
import { registerAgent } from '../src/agents.ts';
import * as seasons from '../src/seasons.ts';
import { XP_TABLE } from '../src/skills/defs.ts';
import { ApiError } from '../src/types.ts';

const dsn = process.env.TEST_DATABASE_URL;
if (!dsn) throw new Error('set TEST_DATABASE_URL');
const db = makePool(dsn);
const ctx = { db, bus: new Bus(), config: { ...config, seasonWinners: 3, seasonCount: 0 } };
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const W = ['7UfcTJD2RSRg9AJ4k2V2rs71Ew8Zy2avaU5roc8bpump', 'So11111111111111111111111111111111111111112', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'Vote111111111111111111111111111111111111111', 'Stake11111111111111111111111111111111111111'];
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

async function agent(handle: string, owner: string, level: number, role: 'agent' | 'house' = 'agent') {
  const { agent: a } = await registerAgent(ctx, { handle, owner_email: owner, role });
  await db.query(`insert into skill_xp (agent_id, skill, xp) values ($1, 'logic', $2)`, [a.id, XP_TABLE[level]]);
  return a;
}

before(async () => { await db.query('drop schema public cascade; create schema public'); await migrate(db); });
after(async () => { await db.end(); });

test('addresses and signatures are validated', async () => {
  assert.ok(seasons.isSolanaAddress(W[0]) && seasons.isSolanaAddress(W[1]));
  assert.equal(seasons.isSolanaAddress('not-a-wallet'), false);
  assert.equal(seasons.isSolanaAddress(W[0].slice(0, 40)), false);
  assert.ok(seasons.isSignature(SIG));
});

test('season: residents excluded, wallet required, one prize per person and per wallet, freeze, DQ, paid, rollover', async () => {
  await seasons.tickSeasons(ctx);
  const s1 = await seasons.currentSeason(db);
  assert.equal(s1.id, 1);
  const top = await agent('top_agent', 'a@x.io', 60);
  const twin = await agent('top_twin', 'a@x.io', 55);          // same person as top_agent
  const second = await agent('second', 'b@x.io', 50);
  const nowallet = await agent('no_wallet', 'c@x.io', 58);
  const shared = await agent('shared_wallet', 'd@x.io', 45);   // reuses second's wallet
  const third = await agent('third', 'e@x.io', 40);
  const fourth = await agent('fourth', 'f@x.io', 30);
  await agent('resident', config.houseOwner, 90, 'house');
  assert.equal(await code(seasons.setWallet(ctx, top, 'nope')), 'bad_address');
  await seasons.setWallet(ctx, top, W[0]); await seasons.setWallet(ctx, twin, W[1]); await seasons.setWallet(ctx, second, W[2]);
  await seasons.setWallet(ctx, shared, W[2]); await seasons.setWallet(ctx, third, W[3]); await seasons.setWallet(ctx, fourth, W[4]);
  const view = await seasons.seasonView(ctx, null);
  const reasons = Object.fromEntries(view.standings.map((r) => [r.handle, r.eligible ? 'ok' : r.reason]));
  assert.equal(reasons.resident, undefined, 'residents are not listed');
  assert.deepEqual([reasons.top_agent, reasons.top_twin, reasons.no_wallet, reasons.second, reasons.shared_wallet, reasons.third],
    ['ok', 'one prize per person', 'no payout wallet set', 'ok', 'one prize per wallet', 'ok']);

  await db.query(`update seasons set ends_at = now() - interval '1 second' where id = 1`);
  await seasons.tickSeasons(ctx);
  let res = await seasons.payoutFile(db, 1);
  assert.deepEqual(res.map((r) => r.handle), ['top_agent', 'second', 'third']);
  assert.ok(res.every((r) => r.amount === 100000));
  assert.equal((await seasons.currentSeason(db)).id, 2, 'next season opened');

  // a level gained after the season ended must not change season 1
  await db.query(`update skill_xp set xp = $2 where agent_id = $1`, [fourth.id, XP_TABLE[99]]);
  await seasons.disqualify(ctx, 1, second.id, 'farming');
  res = await seasons.payoutFile(db, 1);
  assert.deepEqual(res.map((r) => r.handle), ['top_agent', 'shared_wallet', 'third'], 'the frozen snapshot is re-ranked without the disqualified agent');

  for (const r of res) await seasons.markPaid(ctx, 1, r.rank, SIG);
  assert.equal((await db.query('select state from seasons where id = 1')).rows[0].state, 'paid');
  const hist = await seasons.history(db);
  assert.equal(hist[0].winners[0].tx_signature, SIG);
  assert.equal(await code(seasons.disqualify(ctx, 1, top.id, 'late')), 'paid');
});

test('a limited run stops: no season after the last one, and the view reports the one that ended', async () => {
  const once = { ...ctx, config: { ...ctx.config, seasonCount: 2 } };
  await db.query(`update seasons set ends_at = now() - interval '1 second' where id = 2`);
  await seasons.tickSeasons(once);
  assert.equal(await seasons.currentSeason(db), null, 'no third season');
  const v = await seasons.seasonView(once, null);
  assert.equal(v.season, null);
  assert.equal(v.ended.id, 2);
  await seasons.tickSeasons(once);
  assert.equal((await db.query('select count(*)::int as n from seasons')).rows[0].n, 2);
});

test('Season 1 counts only the original ten skills', async () => {
  const a = await agent('outer_ringer', 'ring@x.io', 5);
  await db.query(`insert into skill_xp (agent_id, skill, xp) values ($1, 'calendar', $2)`, [a.id, XP_TABLE[99]]);
  const row = (await seasons.standings(ctx, db)).find((x) => x.agent_id === a.id)!;
  assert.equal(row.total_level, 5 + (seasons.SEASON_SKILLS.length - 1), 'Calendar 99 adds nothing to the season total');
  assert.equal(seasons.SEASON_SKILLS.length, 10);
});
