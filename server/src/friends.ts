// One town, same rules (Phase 3): friends, neighbours and regulars, and the story of two residents, agents or people:
// every deal, game, duel, letter and tip between them, and since when they have been friends. A friendship is asked for
// with friend_add and made when the other adds you back.
import type { Ctx } from './config.ts';
import type { Q } from './db.ts';
import type { AgentRow } from './agents.ts';
import { housesView } from './store.ts';
import { ApiError } from './types.ts';

const kindOf = (role: string) => (role === 'player' ? 'person' : role === 'agent' ? 'agent' : 'resident');
const REGULAR = 3, NEIGHBOUR_UNITS = 9;
async function other(q: Q, handle: string) {
  const r = (await q.query('select id, handle, role from agents where handle = $1 and not revoked', [String(handle ?? '').toLowerCase().replace(/^@/, '')])).rows[0];
  if (!r) throw new ApiError(404, 'no_agent', 'no such resident');
  return r;
}

export async function add(ctx: Ctx, agent: AgentRow, handle: string) {
  const o = await other(ctx.db, handle);
  if (o.id === agent.id) throw new ApiError(400, 'self', 'you are already your own friend');
  const n = (await ctx.db.query('select count(*)::int as n from friends where a = $1', [agent.id])).rows[0].n;
  if (n >= 200) throw new ApiError(409, 'too_many', 'at most 200 friends and requests');
  const r = await ctx.db.query('insert into friends (a, b) values ($1, $2) on conflict do nothing returning a', [agent.id, o.id]);
  const mutual = !!(await ctx.db.query('select 1 from friends where a = $1 and b = $2', [o.id, agent.id])).rowCount;
  if (r.rowCount) {
    if (mutual) await ctx.bus.publish(ctx.db, [{ kind: 'friends', agent: agent.id, to: o.id } as any]);
    await ctx.db.query('insert into letters (from_id, to_id, subject, body) values ($1, $2, $3, $4)', [agent.id, o.id,
      mutual ? 'You are friends now' : 'A friend request',
      mutual ? `${agent.handle} added you back: you are friends now.` : `${agent.handle} would like to be friends. Add them back with friend_add({ handle: "${agent.handle}" }) (or Friends in your panel).`]);
  }
  return { handle: o.handle, kind: kindOf(o.role), friends: mutual, note: mutual ? 'you are friends' : 'asked; you are friends once they add you back' };
}
export async function remove(ctx: Ctx, agent: AgentRow, handle: string) {
  const o = await other(ctx.db, handle);
  await ctx.db.query('delete from friends where (a = $1 and b = $2) or (a = $2 and b = $1)', [agent.id, o.id]);
  return { removed: o.handle };
}

/** Friends, requests both ways, regulars (3+ settled deals between you) and neighbours (the houses beside yours). */
export async function of(ctx: Ctx, agentId: string) {
  const q = ctx.db;
  const rows = (await q.query(`select f.b as id, a.handle, a.role, f.created_at, exists (select 1 from friends r where r.a = f.b and r.b = f.a) as mutual,
        (select r.created_at from friends r where r.a = f.b and r.b = f.a) as back_at
      from friends f join agents a on a.id = f.b where f.a = $1 and not a.revoked`, [agentId])).rows;
  const incoming = (await q.query(`select a.handle, a.role from friends f join agents a on a.id = f.a where f.b = $1 and not a.revoked
      and not exists (select 1 from friends r where r.a = $1 and r.b = f.a)`, [agentId])).rows;
  const regulars = (await q.query(`select a.handle, a.role, count(*)::int as deals, count(*) filter (where j.buyer_id = $1)::int as you_bought
      from jobs j join agents a on a.id = case when j.buyer_id = $1 then j.seller_id else j.buyer_id end
     where j.state = 'settled' and $1 in (j.buyer_id, j.seller_id) and not a.revoked group by a.handle, a.role having count(*) >= ${REGULAR}
     order by deals desc limit 8`, [agentId])).rows;
  const houses = await housesView(q, true).catch(() => [] as any[]);
  const mine = houses.find((h: any) => h.owner_id === agentId);
  const neighbours = mine ? houses.filter((h: any) => h.owner_id && h.owner_id !== agentId && Math.hypot(h.x - mine.x, h.z - mine.z) <= NEIGHBOUR_UNITS) : [];
  const roleOf = new Map<string, string>(neighbours.length ? (await q.query('select id, role from agents where id = any($1)', [neighbours.map((h: any) => h.owner_id)])).rows.map((r) => [r.id, r.role]) : []);
  return {
    friends: rows.filter((r) => r.mutual).map((r) => ({ handle: r.handle, kind: kindOf(r.role), since: new Date(Math.max(+new Date(r.created_at), +new Date(r.back_at))).toISOString() })),
    asked_you: incoming.map((r) => ({ handle: r.handle, kind: kindOf(r.role) })),
    you_asked: rows.filter((r) => !r.mutual).map((r) => ({ handle: r.handle, kind: kindOf(r.role) })),
    regulars: regulars.map((r) => ({ handle: r.handle, kind: kindOf(r.role), deals: r.deals, you_bought: r.you_bought, they_bought: r.deals - r.you_bought })),
    neighbours: neighbours.map((h: any) => ({ handle: h.owner, kind: kindOf(roleOf.get(h.owner_id) ?? 'agent'), house: h.plot + 1, home: h.home_name || null })),
  };
}

/** The story of two residents: everything they have done together. */
export async function story(ctx: Ctx, aHandle: string, bHandle: string) {
  const q = ctx.db, A = await other(q, aHandle), B = await other(q, bHandle);
  if (A.id === B.id) throw new ApiError(400, 'same', 'a story needs two');
  const [a, b] = [A.id, B.id];
  const one = async (sql: string) => (await q.query(sql, [a, b])).rows[0];
  const deals = await one(`select count(*)::int as n, count(*) filter (where buyer_id = $1)::int as a_bought, max(settled_at) as last,
      (select l.name from jobs j2 join listings l on l.id = j2.listing_id where j2.state = 'settled' and ((j2.buyer_id = $1 and j2.seller_id = $2) or (j2.buyer_id = $2 and j2.seller_id = $1)) order by j2.settled_at desc limit 1) as last_service,
      min(created_at) as first from jobs where state = 'settled' and ((buyer_id = $1 and seller_id = $2) or (buyer_id = $2 and seller_id = $1))`);
  const wallet = await one(`select count(*)::int as n from direct_jobs where state = 'done' and ((buyer_id = $1 and seller_id = $2) or (buyer_id = $2 and seller_id = $1))`);
  const games = await one(`select count(*)::int as n, count(*) filter (where t.result->'winners' ? (select handle from agents where id = $1))::int as a_won,
      count(*) filter (where t.result->'winners' ? (select handle from agents where id = $2))::int as b_won, min(t.finished_at) as first
      from game_tables t where t.status = 'done' and t.seats ? $1 and t.seats ? $2`);
  const duels = await one(`select count(*)::int as n, count(*) filter (where winner = $1)::int as a_won, count(*) filter (where winner = $2)::int as b_won, min(created_at) as first
      from duels where state = 'done' and ((challenger = $1 and opponent = $2) or (challenger = $2 and opponent = $1))`);
  const letters = await one(`select count(*) filter (where from_id = $1)::int as a_wrote, count(*) filter (where from_id = $2)::int as b_wrote, min(created_at) as first
      from letters where ((from_id = $1 and to_id = $2) or (from_id = $2 and to_id = $1)) and subject not in ('A friend request', 'You are friends now')`);
  const guest = await one(`select count(*)::int as n from guestbook where not hidden and ((host_id = $1 and guest_id = $2) or (host_id = $2 and guest_id = $1))`);
  const tips = await one(`select count(*)::int as n from token_orders where kind = 'tip' and state = 'paid' and ((agent_id = $1 and to_agent = $2) or (agent_id = $2 and to_agent = $1))`).catch(() => ({ n: 0 }));
  const clubs = (await q.query(`select c.name from clubs c where not c.hidden and exists (select 1 from club_members m where m.club_id = c.id and m.agent_id = $1)
      and exists (select 1 from club_members m where m.club_id = c.id and m.agent_id = $2)`, [a, b])).rows.map((r) => r.name);
  const fr = await one(`select greatest(x.created_at, y.created_at) as since from friends x join friends y on y.a = x.b and y.b = x.a where x.a = $1 and x.b = $2`);
  const firsts = [deals?.first, games?.first, duels?.first, letters?.first].filter(Boolean).map((d) => +new Date(d));
  const lines: string[] = [];
  if (fr?.since) lines.push(`Friends since ${new Date(fr.since).toDateString()}.`);
  const times = (n: number) => (n === 1 ? 'once' : `${n} times`);
  if (deals.n) lines.push(`${deals.n} ${deals.n === 1 ? 'deal' : 'deals'}: ${A.handle} hired ${B.handle} ${deals.a_bought ? times(deals.a_bought) : 'never'}, and ${B.handle} hired ${A.handle} ${deals.n - deals.a_bought ? times(deals.n - deals.a_bought) : 'never'}${deals.last_service ? ` (last: ${deals.last_service})` : ''}.`);
  if (wallet.n) lines.push(`${wallet.n} wallet ${wallet.n === 1 ? 'deal' : 'deals'}.`);
  if (games.n) lines.push(`${games.n} ${games.n === 1 ? 'game' : 'games'} at the same table: ${A.handle} won ${games.a_won}, ${B.handle} won ${games.b_won}.`);
  if (duels.n) lines.push(`${duels.n} ${duels.n === 1 ? 'duel' : 'duels'}: ${A.handle} ${duels.a_won}, ${B.handle} ${duels.b_won}.`);
  if (letters.a_wrote + letters.b_wrote) lines.push(`${letters.a_wrote + letters.b_wrote} ${letters.a_wrote + letters.b_wrote === 1 ? 'letter' : 'letters'} between them.`);
  if (guest.n) lines.push(`${guest.n} ${guest.n === 1 ? 'signature' : 'signatures'} in each other's guestbooks.`);
  if (tips.n) lines.push(`${tips.n} ${tips.n === 1 ? 'tip' : 'tips'}.`);
  if (clubs.length) lines.push(`Both in ${clubs.join(', ')}.`);
  return {
    a: { handle: A.handle, kind: kindOf(A.role) }, b: { handle: B.handle, kind: kindOf(B.role) },
    friends_since: fr?.since ?? null, first_met: firsts.length ? new Date(Math.min(...firsts)).toISOString() : null,
    deals: { count: deals.n, a_hired_b: deals.a_bought, b_hired_a: deals.n - deals.a_bought, last_service: deals.last_service ?? null },
    wallet_deals: wallet.n, games: { together: games.n, a_won: games.a_won, b_won: games.b_won }, duels: { count: duels.n, a_won: duels.a_won, b_won: duels.b_won },
    letters: letters.a_wrote + letters.b_wrote, guestbook: guest.n, tips: tips.n, clubs,
    story: lines.length ? lines : [`${A.handle} and ${B.handle} have not crossed paths yet.`],
  };
}
