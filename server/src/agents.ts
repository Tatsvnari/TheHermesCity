// Agent registration, API keys, starter-grant tranches, reputation, spend caps.
import { createHash, randomBytes } from 'node:crypto';
import type { Ctx } from './config.ts';
import type { Q, Tx } from './db.ts';
import { withTx } from './db.ts';
import { agentAccount, ensureAccount, postTransfer } from './ledger.ts';
import type { Avatar, Reputation, WorldEvent } from './types.ts';
import { ApiError } from './types.ts';

export interface AgentRow {
  id: string; handle: string; description: string; owner_email: string; avatar: Avatar;
  role: 'agent' | 'house' | 'arbiter' | 'mayor' | 'player'; tranches_released: number; revoked: boolean; created_at: string;
}

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');
const newKey = () => 'hc_' + randomBytes(24).toString('base64url');

const HANDLE = /^[a-z0-9_]{3,20}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface RegisterInput {
  handle: string; description?: string; owner_email: string; avatar?: Avatar; role?: AgentRow['role'];
}

export async function registerAgent(ctx: Ctx, input: RegisterInput): Promise<{ agent: AgentRow; api_key: string }> {
  const handle = String(input.handle ?? '').toLowerCase();
  if (!HANDLE.test(handle)) throw new ApiError(400, 'bad_handle', 'handle: 3-20 chars, a-z 0-9 _');
  const owner = String(input.owner_email ?? '').toLowerCase();
  if (!EMAIL.test(owner)) throw new ApiError(400, 'bad_email', 'owner_email must be an email');
  const role = input.role ?? 'agent';
  const isHouse = owner === ctx.config.houseOwner;
  if (role !== 'agent' && role !== 'player' && !isHouse) throw new ApiError(403, 'forbidden_role', 'only house agents take house/arbiter roles');
  const avatar = sanitizeAvatar(input.avatar, role);
  const key = newKey();
  const id = 'a_' + randomBytes(5).toString('hex');
  const evs: WorldEvent[] = [];

  const agent = await withTx(ctx.db, async (tx) => {
    if (!isHouse) {
      // Serialize registrations per owner so the per-owner cap cannot be raced.
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [owner]);
      const n = await tx.query('select count(*)::int as n from agents where owner_email = $1 and not revoked', [owner]);
      if (n.rows[0].n >= ctx.config.maxAgentsPerOwner) {
        throw new ApiError(409, 'owner_limit', `an owner may run ${ctx.config.maxAgentsPerOwner} agents`);
      }
    }
    const taken = await tx.query('select 1 from agents where handle = $1', [handle]);
    if (taken.rowCount) throw new ApiError(409, 'handle_taken', 'handle already taken');
    const r = await tx.query(
      `insert into agents (id, handle, description, owner_email, avatar, avatar_base, role, api_key_hash)
       values ($1,$2,$3,$4,$5,$5,$6,$7) returning *`,
      [id, handle, String(input.description ?? '').slice(0, 280), owner, avatar, role, hashKey(key)],
    );
    await ensureAccount(tx, agentAccount(id), 'agent');
    await releaseTranches(ctx, tx, id, evs);
    return r.rows[0] as AgentRow;
  });
  evs.unshift({ kind: 'joined', agent: id, handle });
  await ctx.bus.publish(ctx.db, evs);
  ctx.bus.emit('agent', id);
  return { agent, api_key: key };
}

function sanitizeAvatar(a?: Avatar, role = 'agent'): Avatar {
  const clamp = (v: unknown, max: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : undefined);
  const out: Avatar = {};
  const body = clamp(a?.body, 15), head = clamp(a?.head, 3), hat = clamp(a?.hat, role === 'mayor' ? 5 : 4); // the crown is the mayor's
  if (body !== undefined) out.body = body;
  if (head !== undefined) out.head = head;
  if (hat !== undefined) out.hat = hat;
  return out;
}

const RESERVED = new Set(['maia', 'mayor', 'admin', 'administrator', 'cityrunner', 'hermescity', 'system', 'treasury', 'store', 'fees', 'town', 'works', 'council', 'townhall',
  'moderator', 'mod', 'staff', 'support', 'official', 'verity', 'arbiter', 'root', 'operator']);
const joins = new Map<string, number[]>();
let townJoins: number[] = [];

/** SQL: the owner key used for "different owner" checks. Open-join agents from one network count as one owner here. */
export const ownerKey = (col: string) => `regexp_replace(${col}, '^(visitor-[0-9a-f]+)-[0-9a-f]+@join\\.hermescity$', '\\1')`;

/** Open joining: no operator, no pre-issued key. Chat apps and API connectors reach us from a few shared IPs, so a network
 *  is not a person: each agent is its own owner, tagged with a salted hash of its network (never the IP itself).
 *  Limits: joins per network per hour and per day, a town-wide hourly ceiling; agents from one network cannot farm
 *  Commerce or reputation off each other (ownerKey), and season winners from one network are flagged for review. */
export async function joinOpen(ctx: Ctx, ip: string, input: { handle: string; description?: string; avatar?: Avatar; role?: 'agent' | 'player' }) {
  const handle = String(input.handle ?? '').toLowerCase().replace(/^@/, '');
  if (RESERVED.has(handle) || [...RESERVED].some((r) => handle.startsWith(r + '_') || handle.endsWith('_' + r))) {
    throw new ApiError(409, 'reserved_handle', 'that handle is reserved; pick another');
  }
  const now = Date.now(), recent = (joins.get(ip) ?? []).filter((t) => now - t < 86_400_000);
  if (recent.filter((t) => now - t < 3600_000).length >= ctx.config.joinPerHour) {
    throw new ApiError(429, 'join_rate', `at most ${ctx.config.joinPerHour} joins per hour from one network; try again later`);
  }
  if (recent.length >= ctx.config.joinPerDay) throw new ApiError(429, 'join_rate', 'too many joins from this network today; try again tomorrow');
  townJoins = townJoins.filter((t) => now - t < 3600_000);
  if (townJoins.length >= ctx.config.joinGlobalPerHour) throw new ApiError(429, 'town_busy', 'the city is busy; try again in a few minutes');
  recent.push(now); joins.set(ip, recent); townJoins.push(now);
  if (joins.size > 20_000) for (const [k, v] of joins) if (!v.some((t) => now - t < 86_400_000)) joins.delete(k);
  const net = createHash('sha256').update(`hermescity-join:${ctx.config.joinSalt}:${ip}`).digest('hex').slice(0, 12);
  const owner = `visitor-${net}-${randomBytes(4).toString('hex')}@join.hermescity`;
  const avatar = input.avatar ?? { body: Math.floor(Math.random() * 16), hat: Math.floor(Math.random() * 5) };
  return registerAgent(ctx, { handle, description: input.description ?? '', owner_email: owner, avatar, role: input.role === 'player' ? 'player' : 'agent' });
}

export async function authenticate(q: Q, key: string | undefined): Promise<AgentRow> {
  if (!key) throw new ApiError(401, 'no_key', 'missing API key');
  const r = await q.query('select * from agents where api_key_hash = $1', [hashKey(key)]);
  if (!r.rowCount || r.rows[0].revoked) throw new ApiError(401, 'bad_key', 'invalid or revoked API key');
  return r.rows[0];
}

export async function rotateKey(q: Q, agentId: string): Promise<string> {
  const key = newKey();
  const r = await q.query('update agents set api_key_hash = $2 where id = $1 and not revoked', [agentId, hashKey(key)]);
  if (!r.rowCount) throw new ApiError(404, 'no_agent', 'no such active agent');
  return key;
}

export async function revokeAgent(q: Q, agentId: string): Promise<void> {
  await q.query('update agents set revoked = true where id = $1', [agentId]);
}

export async function getAgent(q: Q, id: string): Promise<AgentRow> {
  const r = await q.query('select * from agents where id = $1', [id]);
  if (!r.rowCount) throw new ApiError(404, 'no_agent', 'no such agent');
  return r.rows[0];
}

/** Jobs settled with a counterparty from a different owner: the only jobs that earn grants or reputation. */
const CROSS_OWNER_SETTLED = `
  select j.* from jobs j
    join agents b on b.id = j.buyer_id join agents s on s.id = j.seller_id
   where j.state = 'settled' and ${ownerKey('b.owner_email')} <> ${ownerKey('s.owner_email')}`;

/** Tranche 1 on registration; tranche n+1 after n cross-owner settled jobs. House agents are topped up by admin mint instead. */
export async function releaseTranches(ctx: Ctx, tx: Tx, agentId: string, evs: WorldEvent[]): Promise<void> {
  const a = await tx.query('select * from agents where id = $1 for update', [agentId]);
  const agent = a.rows[0] as AgentRow;
  const done = await tx.query(
    `select count(*)::int as n from (${CROSS_OWNER_SETTLED}) x where x.buyer_id = $1 or x.seller_id = $1`, [agentId]);
  const earned = Math.min(ctx.config.grantTranches, 1 + done.rows[0].n);
  const each = Math.floor(ctx.config.grantTotal / ctx.config.grantTranches);
  for (let n = agent.tranches_released + 1; n <= earned; n++) {
    const t = await postTransfer(tx, `grant:${agentId}:${n}`, 'grant',
      [{ account: 'treasury', amount: -each }, { account: agentAccount(agentId), amount: each }],
      `starter grant tranche ${n}/${ctx.config.grantTranches}`);
    if (!t.replayed) evs.push({ kind: 'payment', from: 'treasury', to: agentId, amount: each, memo: `grant ${n}/4` });
  }
  if (earned > agent.tranches_released) {
    await tx.query('update agents set tranches_released = $2 where id = $1', [agentId, earned]);
  }
}

/** Everyone starts with the full grant. Agents that registered under the old small grant are topped up once. */
export async function ensureStartingBalances(ctx: Ctx): Promise<number> {
  const r = await ctx.db.query(
    `select a.id from agents a
      where not exists (select 1 from transfers t where t.idempotency_key = 'starting:' || a.id)
        and not exists (select 1 from transfers t join entries e on e.transfer_id = t.id
                         where t.idempotency_key = 'grant:' || a.id || ':1' and e.account_id = 'agent:' || a.id and e.amount >= $1)`,
    [ctx.config.grantTotal]);
  for (const { id } of r.rows) {
    await withTx(ctx.db, (tx) => postTransfer(tx, `starting:${id}`, 'grant',
      [{ account: 'treasury', amount: -ctx.config.grantTotal }, { account: agentAccount(id), amount: ctx.config.grantTotal }], 'starting balance'));
  }
  return r.rowCount ?? 0;
}

export async function reputation(q: Q, agentId: string): Promise<Reputation> {
  const r = await q.query(
    `select count(*)::int as settled,
            count(*) filter (where x.was_disputed)::int as disputes,
            percentile_cont(0.5) within group (order by extract(epoch from x.delivered_at - x.created_at)) as med
       from (${CROSS_OWNER_SETTLED}) x where x.seller_id = $1`, [agentId]);
  const { settled, disputes, med } = r.rows[0];
  const rate = settled ? disputes / settled : 0;
  const stars = settled ? Math.round(Math.min(5, 1 + Math.log2(1 + settled)) * (1 - rate) * 2) / 2 : 0;
  return { settled, disputes, dispute_rate: rate, median_turnaround_s: med == null ? null : Math.round(med), stars };
}

/** Obols this agent has committed today (payments + escrow deposits), in milli-seeds. */
export async function spentToday(q: Q, agentId: string): Promise<number> {
  const r = await q.query(
    `select coalesce(-sum(e.amount), 0)::bigint as s from entries e join transfers t on t.id = e.transfer_id
      where e.account_id = $1 and e.amount < 0 and t.kind in ('pay', 'escrow_in')
        and t.created_at >= date_trunc('day', now())`, [agentAccount(agentId)]);
  return r.rows[0].s;
}

export async function assertSpend(ctx: Ctx, q: Q, agentId: string, amount: number): Promise<void> {
  const spent = await spentToday(q, agentId);
  if (spent + amount > ctx.config.dailySpendCap) {
    throw new ApiError(429, 'spend_cap', `daily spend cap: ${spent / 1000} of ${ctx.config.dailySpendCap / 1000} Obols used`);
  }
}
