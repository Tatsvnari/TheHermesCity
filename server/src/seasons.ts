// Seasons: fixed windows (SEASON_DAYS), SEASON_COUNT of them (0 = keep running). Season 1 was a one-time giveaway scored
// on total level; when it ends the standings are frozen, the top outside agents with a payout wallet win $CITY, and the
// operator reviews, sends the tokens from the project wallet, and records each signature.
// Seasons 2+ are a fresh race: points are XP earned during the season, each skill counting up to SEASON_SKILL_DAY_XP a
// season-day (from daily marks of everyone's XP), so training every skill every day beats running one skill round the
// clock. They carry a prize only if SEASON_LATER_PRIZE is set; otherwise the top five go to the Hall of Fame.
// One town, same rules: a season without a prize is one race for everyone, agents and people (players) ranked together.
// A season with a prize stays outside agents only, as its posted rules say.
import type { Ctx } from './config.ts';
import type { Q } from './db.ts';
import { withTx } from './db.ts';
import type { AgentRow } from './agents.ts';
import { BASE_SKILL_IDS, SKILL_IDS, levelFor } from './skills/defs.ts';
import { ApiError } from './types.ts';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58bytes(s: string): number {
  let n = 0n;
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) return -1; n = n * 58n + BigInt(i); }
  const lead = (s.match(/^1*/)?.[0].length) ?? 0;
  return lead + (n === 0n ? 0 : Math.ceil(n.toString(16).length / 2));
}
export const isSolanaAddress = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && b58bytes(s) === 32;
export const isSignature = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s) && b58bytes(s) === 64;

/** Season 1 counts the ten inner-ring skills only, so opening new skills mid-season changes nobody's score. */
export const SEASON_SKILLS = BASE_SKILL_IDS;

export const scoringOf = (seasonId: number) => (seasonId <= 1 ? 'level' : 'points') as 'level' | 'points';
const DAY_MS = 86400e3;

export interface Standing {
  agent_id: string; handle: string; role: string; total_level: number; total_xp: number; reached_at: string; score?: number;
  wallet: string | null; eligible: boolean; reason?: string; owner?: string;
}

/** Everyone who could win, best first, with why they can or cannot. */
/** Points in a season after the first: per agent, the sum over skills and season-days of XP gained, capped per day. */
async function seasonPoints(ctx: Ctx, q: Q, season: any) {
  const now = Math.min(Date.now(), new Date(season.ends_at).getTime());
  const liveDay = Math.floor((now - new Date(season.starts_at).getTime()) / DAY_MS) + 1;
  const r = await q.query(
    `with m as (select agent_id, skill, day, xp from season_marks where season_id = $1
                union all select agent_id, skill, $2::int, xp from skill_xp),
          d as (select agent_id, day, xp - coalesce(lag(xp) over w, 0) as gained, day - coalesce(lag(day) over w, day - 1) as span
                  from m window w as (partition by agent_id, skill order by day))
     select agent_id, sum(least(greatest(gained, 0), $3::bigint * span))::bigint as points from d where day > 0 group by agent_id`,
    [season.id, liveDay, ctx.config.seasonSkillDayXp]);
  return new Map<string, number>(r.rows.map((x) => [x.agent_id, Number(x.points)]));
}

export async function standings(ctx: Ctx, q: Q, seasonId?: number): Promise<Standing[]> {
  const season = seasonId ? (await q.query('select * from seasons where id = $1', [seasonId])).rows[0] : null;
  const points = season && scoringOf(season.id) === 'points' ? await seasonPoints(ctx, q, season) : null;
  const needWallet = !season || Number(season.prize_per_winner) > 0;
  const everyone = !!points && !needWallet; // one race: agents and people together
  const r = await q.query(
    `select a.id, a.handle, a.role, a.owner_email, w.address,
            coalesce((select json_agg(json_build_object('s', x.skill, 'xp', x.xp, 'u', x.updated_at)) from skill_xp x where x.agent_id = a.id), '[]') as xs
       from agents a left join payout_wallets w on w.agent_id = a.id
      where not a.revoked and a.role ${everyone ? `in ('agent', 'player')` : `= 'agent'`} and a.owner_email <> $1`, [ctx.config.houseOwner]);
  const dq = seasonId ? new Set((await q.query('select agent_id from season_disqualified where season_id = $1', [seasonId])).rows.map((x) => x.agent_id)) : new Set();
  const rows = r.rows.map((a) => {
    const by = new Map<string, number>(a.xs.map((x: any) => [x.s, Number(x.xp)]));
    const last = a.xs.reduce((m: string, x: any) => (x.u > m ? x.u : m), '1970-01-01');
    return { agent_id: a.id, handle: a.handle, role: a.role, owner: a.owner_email, wallet: a.address ?? null,
      total_level: (points ? SKILL_IDS : SEASON_SKILLS).reduce((s, k) => s + levelFor(by.get(k) ?? 0), 0),
      total_xp: (points ? SKILL_IDS : SEASON_SKILLS).reduce((s, k) => s + (by.get(k) ?? 0), 0), reached_at: last } as Standing;
  }).map((x) => ({ ...x, score: points ? points.get(x.agent_id) ?? 0 : x.total_level }))
    .filter((x) => !points || x.score > 0)
    .sort((x, y) => y.score - x.score || (points ? 0 : y.total_xp - x.total_xp) || x.reached_at.localeCompare(y.reached_at));
  const owners = new Set<string>(), wallets = new Set<string>();
  for (const s of rows) {
    if (dq.has(s.agent_id)) { s.eligible = false; s.reason = 'disqualified'; continue; }
    if (needWallet && !s.wallet) { s.eligible = false; s.reason = 'no payout wallet set'; continue; }
    if (owners.has(s.owner!)) { s.eligible = false; s.reason = needWallet ? 'one prize per person' : 'one place per person'; continue; }
    if (needWallet && wallets.has(s.wallet!)) { s.eligible = false; s.reason = 'one prize per wallet'; continue; }
    s.eligible = true; owners.add(s.owner!); if (s.wallet) wallets.add(s.wallet);
  }
  return rows;
}
const publicRow = ({ owner: _o, ...s }: Standing) => ({ ...s, wallet: s.wallet ? `${s.wallet.slice(0, 4)}…${s.wallet.slice(-4)}` : null });

export async function currentSeason(q: Q) {
  return (await q.query(`select * from seasons where state = 'active' order by id desc limit 1`)).rows[0] ?? null;
}

/** Make sure a season is running; close it (freeze winners) when its time is up and open the next one. */
/** Seasons 2+: once a season-day, mark everyone's XP (day 0 is the start line). */
export async function markDay(ctx: Ctx, season: any) {
  if (scoringOf(season.id) !== 'points') return;
  const day = Math.floor((Date.now() - new Date(season.starts_at).getTime()) / DAY_MS);
  if (day < 0 || new Date(season.ends_at) <= new Date()) return;
  const has = await ctx.db.query('select 1 from season_marks where season_id = $1 and day = $2 limit 1', [season.id, day]);
  if (!has.rowCount) await ctx.db.query('insert into season_marks (season_id, day, agent_id, skill, xp) select $1, $2, agent_id, skill, xp from skill_xp on conflict do nothing', [season.id, day]);
}

export async function tickSeasons(ctx: Ctx) {
  if (!ctx.config.seasonsEnabled) return;
  const days = ctx.config.seasonDays;
  const cur = await currentSeason(ctx.db);
  if (cur) await markDay(ctx, cur);
  if (!cur) {
    const last = (await ctx.db.query('select * from seasons order by id desc limit 1')).rows[0];
    if (last && ctx.config.seasonCount > 0 && last.id >= ctx.config.seasonCount) return; // the giveaway has run its course
    const start = last ? new Date(last.ends_at) : ctx.config.season1Start ? new Date(ctx.config.season1Start) : new Date();
    const id = (last?.id ?? 0) + 1;
    const s = (await ctx.db.query(`insert into seasons (id, starts_at, ends_at, prize_per_winner, winners) values ($1, $2, $2::timestamptz + make_interval(days => $3), $4, $5) returning *`,
      [id, start.toISOString(), days, id === 1 ? ctx.config.seasonPrize : ctx.config.laterSeasonPrize, ctx.config.seasonWinners])).rows[0];
    await markDay(ctx, s);
    return;
  }
  if (new Date(cur.ends_at) <= new Date()) {
    await freeze(ctx, cur.id);
    await tickSeasons(ctx); // opens the next one, if there is one
  }
}

/** Freeze a season: snapshot the full standings, pick the winners (now or again after a disqualification). */
export async function freeze(ctx: Ctx, seasonId: number, useSnapshot = false) {
  const s = (await ctx.db.query('select * from seasons where id = $1', [seasonId])).rows[0];
  if (!s) throw new ApiError(404, 'no_season', 'no such season');
  let rows: Standing[];
  if (useSnapshot && s.snapshot) {
    const dq = new Set((await ctx.db.query('select agent_id from season_disqualified where season_id = $1', [seasonId])).rows.map((x) => x.agent_id));
    const owners = new Set<string>(), wallets = new Set<string>();
    rows = (s.snapshot as Standing[]).map((x) => ({ ...x }));
    for (const x of rows) {
      x.eligible = !dq.has(x.agent_id) && !!x.wallet && !owners.has(x.owner!) && !wallets.has(x.wallet!);
      x.reason = dq.has(x.agent_id) ? 'disqualified' : x.eligible ? undefined : x.reason ?? 'not eligible';
      if (x.eligible) { owners.add(x.owner!); wallets.add(x.wallet!); }
    }
  } else rows = await standings(ctx, ctx.db, seasonId);
  const winners = rows.filter((x) => x.eligible).slice(0, s.winners);
  const prize = Number(s.prize_per_winner) > 0;
  await withTx(ctx.db, async (tx) => {
    await tx.query('update seasons set snapshot = coalesce(snapshot, $2), state = $3, frozen_at = coalesce(frozen_at, now()) where id = $1',
      [seasonId, JSON.stringify(rows), !prize ? 'closed' : s.state === 'paid' ? 'paid' : 'review']);
    await tx.query('delete from season_results where season_id = $1 and tx_signature is null', [seasonId]);
    const paid = new Set((await tx.query('select agent_id from season_results where season_id = $1', [seasonId])).rows.map((x) => x.agent_id));
    let rank = 0;
    for (const w of winners) {
      rank++;
      if (paid.has(w.agent_id)) continue;
      await tx.query(`insert into season_results (season_id, rank, agent_id, handle, total_level, total_xp, wallet, amount, score) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                      on conflict (season_id, rank) do nothing`, [seasonId, rank, w.agent_id, w.handle, w.total_level, w.total_xp, w.wallet ?? '', s.prize_per_winner, w.score ?? w.total_level]);
    }
  });
  if (!useSnapshot) await ctx.bus.publish(ctx.db, [{ kind: 'season_closed', season: seasonId, winners: winners.map((w) => w.handle) } as any]);
  return winners.map(publicRow);
}

export async function setWallet(ctx: Ctx, agent: AgentRow, address: string) {
  const a = String(address ?? '').trim();
  if (!isSolanaAddress(a)) throw new ApiError(400, 'bad_address', 'give a Solana wallet address (base58, 32 bytes)');
  if (agent.role !== 'agent') throw new ApiError(403, 'resident', 'CityRunner residents do not take part in seasons');
  // prizes are never sent to a wallet on a public sanctions list (the list is refreshed daily; see wallets.ts)
  if ((await ctx.db.query('select 1 from sanctioned_addresses where address = $1', [a])).rowCount) throw new ApiError(403, 'sanctioned', 'this wallet cannot receive prizes');
  await ctx.db.query(`insert into payout_wallets (agent_id, address) values ($1, $2)
                      on conflict (agent_id) do update set address = excluded.address, updated_at = now()`, [agent.id, a]);
  return { payout_wallet: a };
}

export async function seasonView(ctx: Ctx, agent: AgentRow | null) {
  const s = await currentSeason(ctx.db);
  const rows = s ? await standings(ctx, ctx.db, s.id) : [];
  const winners = rows.filter((r) => r.eligible).slice(0, s?.winners ?? 5);
  const mine = agent ? rows.find((r) => r.agent_id === agent.id) : undefined;
  const last = s ? null : (await ctx.db.query('select id, ends_at, state from seasons order by id desc limit 1')).rows[0] ?? null;
  const scoring = s ? scoringOf(s.id) : 'level', prize = Number(s?.prize_per_winner ?? 0);
  const cap = ctx.config.seasonSkillDayXp.toLocaleString('en-US');
  return {
    season: s && { id: s.id, starts_at: s.starts_at, ends_at: s.ends_at, prize_per_winner: prize, winners: s.winners, token: '$CITY', scoring },
    ended: last && { id: last.id, ends_at: last.ends_at, state: last.state },
    rules: scoring === 'level'
      ? 'A free, one-time giveaway for playing: no purchase necessary. '
        + `Top ${s?.winners ?? 5} agents by total level across the original ten skills when the season ends each win ${Number(s?.prize_per_winner ?? 100000).toLocaleString('en-US')} $CITY. `
        + 'Outside agents only (not CityRunner residents). One prize per person and per wallet. Set a Solana wallet with set_payout_wallet. '
        + 'Winners are reviewed, then paid from the project wallet; every transaction signature is published. '
        + 'Buying or holding $CITY, USDC or any other token never improves your chances, and Obols are never bought or sold for money. Void where prohibited.'
      : `A fresh race: points are the XP you earn during the season across all ${SKILL_IDS.length} skills, each skill counting up to ${cap} XP a season-day, `
        + 'so training every skill every day beats running one skill round the clock. '
        + (prize > 0 ? `The top ${s!.winners} each win ${prize.toLocaleString('en-US')} $CITY (set a Solana wallet with set_payout_wallet; one prize per person and per wallet). `
          : `The top ${s!.winners} go into the Hall of Fame in the City Hall square with the title Season ${s!.id} champion. No purchase necessary; no prize this season. `)
        + (prize > 0 ? 'Outside agents only (not CityRunner residents); one place per person. ' : 'One race for everyone: agents and people (players) on one board (not CityRunner residents); one place per person. ')
        + 'Buying or holding $CITY, USDC or any other token never improves your chances, and Obols are never bought or sold for money.',
    prize_line: winners.map((w) => w.agent_id),
    standings: rows.slice(0, 15).map(publicRow),
    score_label: scoring === 'level' ? 'total level' : 'points',
    everyone: scoring === 'points' && prize === 0,
    you: mine ? { ...publicRow(mine), rank: rows.indexOf(mine) + 1, winning: winners.includes(mine) } : undefined,
  };
}

export async function history(q: Q) {
  const s = (await q.query(`select * from seasons where state <> 'active' order by id desc limit 20`)).rows;
  const r = (await q.query('select * from season_results where season_id = any($1) order by season_id desc, rank', [s.map((x) => x.id)])).rows;
  return s.map((x) => ({ id: x.id, starts_at: x.starts_at, ends_at: x.ends_at, state: x.state, prize_per_winner: Number(x.prize_per_winner),
    scoring: scoringOf(x.id),
    winners: r.filter((w) => w.season_id === x.id).map((w) => ({ rank: w.rank, handle: w.handle, total_level: w.total_level, score: Number(w.score ?? w.total_level), wallet: w.wallet || null, amount: Number(w.amount), tx_signature: w.tx_signature })) }));
}

export async function markPaid(ctx: Ctx, seasonId: number, rank: number, sig: string) {
  if (!isSignature(String(sig ?? '').trim())) throw new ApiError(400, 'bad_signature', 'give the Solana transaction signature');
  const u = await ctx.db.query('update season_results set tx_signature = $3 where season_id = $1 and rank = $2 returning *', [seasonId, rank, sig.trim()]);
  if (!u.rowCount) throw new ApiError(404, 'no_result', 'no such winner');
  const left = await ctx.db.query('select count(*)::int as n from season_results where season_id = $1 and tx_signature is null', [seasonId]);
  if (left.rows[0].n === 0) await ctx.db.query(`update seasons set state = 'paid', paid_at = now() where id = $1`, [seasonId]);
  return { season: seasonId, rank, tx_signature: sig.trim(), remaining: left.rows[0].n };
}

export async function disqualify(ctx: Ctx, seasonId: number, agentId: string, reason: string) {
  const s = (await ctx.db.query('select state from seasons where id = $1', [seasonId])).rows[0];
  if (!s) throw new ApiError(404, 'no_season', 'no such season');
  if (s.state === 'paid') throw new ApiError(409, 'paid', 'this season is already paid');
  await ctx.db.query('insert into season_disqualified (season_id, agent_id, reason) values ($1, $2, $3) on conflict do nothing', [seasonId, agentId, String(reason ?? '').slice(0, 300)]);
  return s.state === 'review' ? freeze(ctx, seasonId, true) : { disqualified: agentId };
}

export async function payoutFile(q: Q, seasonId: number) {
  // peak: the agent's busiest day of training (XP and tasks passed), to help judge grinding at review
  const r = await q.query(`select r.rank, r.handle, r.wallet, r.amount, r.tx_signature,
      substring(a.owner_email from '^visitor-([0-9a-f]+)') as network,
      (select json_build_object('xp', max(x.xp), 'tasks', max(x.n)) from (select sum(t.xp_awarded) as xp, count(*) as n from training_tasks t
         where t.agent_id = r.agent_id and t.state = 'passed' group by date_trunc('day', t.answered_at)) x) as peak,
      (select count(*)::int from direct_jobs d where (d.buyer_id = r.agent_id or d.seller_id = r.agent_id) and d.state not in ('cancelled', 'expired')) as token_deals,
      exists (select 1 from sanctioned_addresses s where s.address = r.wallet) as sanctioned
      from season_results r join agents a on a.id = r.agent_id where r.season_id = $1 order by r.rank`, [seasonId]);
  const seen = new Map<string, number>();
  for (const x of r.rows) if (x.network) seen.set(x.network, (seen.get(x.network) ?? 0) + 1);
  // same_network: more than one winner joined from one network (could be one person, or a shared chat-app network); review before paying
  return r.rows.map((x) => ({ ...x, amount: Number(x.amount), same_network: !!x.network && (seen.get(x.network) ?? 0) > 1 }));
}
