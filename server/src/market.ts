// Service market: listings, escrowed jobs, the job state machine, verification, settlement.
import { randomBytes } from 'node:crypto';
import AjvModule from 'ajv';
import type { Ctx } from './config.ts';
import { feeAccount } from './config.ts';
import type { Q, Tx } from './db.ts';
import { withTx } from './db.ts';
import type { AgentRow } from './agents.ts';
import { assertSpend, releaseTranches } from './agents.ts';
import type { Leg } from './ledger.ts';
import { agentAccount, ensureAccount, escrowAccount, postTransfer } from './ledger.ts';
import type { CheckKind, Job, Listing, WorldEvent } from './types.ts';
import { ApiError, MILLI } from './types.ts';
import { grantCommerce } from './skills/service.ts';
import { assertNoTokenTie, tokenPrice } from './direct.ts';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: false, strict: false });
const MAX_LISTINGS_PER_AGENT = 3; // for new shops; shops opened under the old cap of 5 keep their plots
/** Plots 0-15 are the stalls on Market Square; 16-63 are counters in the Merchants' Guild once the street is full. */
export const STREET_PLOTS = 16, ALL_PLOTS = 64;
const CHECKS: CheckKind[] = ['none', 'nonempty_text', 'rowcount_le_input'];

const toMilli = (seeds: unknown) => {
  const n = Number(seeds);
  if (!Number.isFinite(n) || n <= 0) throw new ApiError(400, 'bad_price', 'price must be a positive number of Obols');
  return Math.round(n * MILLI);
};

function compile(schema: unknown, what: string) {
  if (typeof schema !== 'object' || schema === null) throw new ApiError(400, 'bad_schema', `${what} must be a JSON schema object`);
  try { return ajv.compile(schema); } catch (e) { throw new ApiError(400, 'bad_schema', `${what}: ${(e as Error).message}`); }
}
function validate(schema: object, data: unknown, what: string) {
  const v = compile(schema, what);
  if (!v(data)) throw new ApiError(422, 'schema_mismatch', `${what} fails schema: ${ajv.errorsText(v.errors)}`);
}

// ---------- listings ----------

export interface ListInput {
  name: string; description?: string; price?: number; unit?: 'job' | 'unit';
  pay_in?: string; token_price?: number | string; pay_when?: string; // a service paid wallet to wallet in USDC or $CITY
  input_schema?: object; output_schema?: object; check_kind?: CheckKind; max_turnaround_s?: number;
}

export async function listService(ctx: Ctx, agent: AgentRow, inp: ListInput): Promise<Listing> {
  const name = String(inp.name ?? '').trim().slice(0, 60);
  if (!name) throw new ApiError(400, 'bad_name', 'name required');
  const direct = await tokenPrice(ctx, agent, inp);
  const price = direct ? MILLI : toMilli(inp.price); // a token-priced shop keeps a nominal Obols price that is never charged
  const input_schema = inp.input_schema ?? { type: 'object' };
  const output_schema = inp.output_schema ?? { type: 'object' };
  compile(input_schema, 'input_schema'); compile(output_schema, 'output_schema');
  const check_kind = inp.check_kind ?? 'none';
  if (!CHECKS.includes(check_kind)) throw new ApiError(400, 'bad_check', `check_kind one of ${CHECKS.join(', ')}`);
  const turnaround = Math.max(30, Math.min(7 * 86400, Math.round(Number(inp.max_turnaround_s ?? 600))));
  const unit = inp.unit === 'unit' ? 'unit' : 'job';

  const listing = await withTx(ctx.db, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(4242)'); // plot allocation
    const n = await tx.query('select count(*)::int as n from listings where agent_id = $1 and active', [agent.id]);
    if (n.rows[0].n >= MAX_LISTINGS_PER_AGENT) throw new ApiError(409, 'listing_limit', `max ${MAX_LISTINGS_PER_AGENT} open shops per agent`);
    const plot = (await tx.query(
      `select min(p)::int as p from generate_series(0, $1::int - 1) p where p not in (select plot from listings where active)`, [ALL_PLOTS])).rows[0].p;
    if (plot === null) throw new ApiError(409, 'market_full', "every stall on Market Square and every counter in the Merchants' Guild is taken");
    const r = await tx.query(
      `insert into listings (id, agent_id, name, description, price, unit, input_schema, output_schema, check_kind, max_turnaround_s, plot)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      ['s_' + randomBytes(5).toString('hex'), agent.id, name, String(inp.description ?? '').slice(0, 500), price, unit,
        input_schema, output_schema, check_kind, turnaround, plot]);
    if (direct) Object.assign(r.rows[0], (await tx.query('update listings set pay_token = $2, token_amount = $3, pay_when = $4 where id = $1 returning pay_token, token_amount, pay_when',
      [r.rows[0].id, direct.pay_token, direct.token_amount, direct.pay_when])).rows[0]);
    return r.rows[0] as Listing;
  });
  await ctx.bus.publish(ctx.db, [{ kind: 'listed', agent: agent.id, listing: listing.id, name }]);
  ctx.bus.emit('shops');
  return listing;
}

export async function closeService(ctx: Ctx, agent: AgentRow, listingId: string): Promise<void> {
  const r = await ctx.db.query('update listings set active = false where id = $1 and agent_id = $2 and active', [listingId, agent.id]);
  if (!r.rowCount) throw new ApiError(404, 'no_listing', 'no such open listing of yours');
  ctx.bus.emit('shops');
}

export async function browseServices(q: Q, query = '', limit = 50) {
  const r = await q.query(
    `select l.id, l.name, l.description, l.price, l.unit, l.input_schema, l.output_schema, l.check_kind,
            l.max_turnaround_s, l.plot, l.agent_id, a.handle as seller, l.pay_token, l.token_amount, l.pay_when
       from listings l join agents a on a.id = l.agent_id
      where l.active and not a.revoked and ($1 = '' or l.name ilike '%'||$1||'%' or l.description ilike '%'||$1||'%')
      order by l.created_at limit $2`, [query.slice(0, 80), Math.min(limit, 100)]);
  return r.rows;
}

// ---------- jobs ----------

async function lockJob(tx: Tx, id: string): Promise<Job & { seller_owner: string; buyer_owner: string; check_kind: CheckKind; output_schema: object }> {
  const r = await tx.query(
    `select j.*, l.check_kind, l.output_schema from jobs j join listings l on l.id = j.listing_id where j.id = $1 for update of j`, [id]);
  if (!r.rowCount) throw new ApiError(404, 'no_job', 'no such job');
  return r.rows[0];
}

export interface HireInput { service_id: string; input: unknown; max_price: number; idempotency_key?: string }

export async function hire(ctx: Ctx, buyer: AgentRow, inp: HireInput): Promise<Job> {
  const idem = `hire:${buyer.id}:${inp.idempotency_key ?? randomBytes(8).toString('hex')}`;
  const evs: WorldEvent[] = [];
  const job = await withTx(ctx.db, async (tx) => {
    const prior = await tx.query('select * from jobs where idem_key = $1', [idem]);
    if (prior.rowCount) return prior.rows[0] as Job;
    const l = await tx.query('select l.*, a.revoked from listings l join agents a on a.id = l.agent_id where l.id = $1', [inp.service_id]);
    if (!l.rowCount || !l.rows[0].active || l.rows[0].revoked) throw new ApiError(404, 'no_listing', 'no such open service');
    if (l.rows[0].pay_token) throw new ApiError(409, 'direct_pay', `this service is paid wallet to wallet in ${l.rows[0].pay_token}: use hire_direct`);
    await assertNoTokenTie(tx, buyer.id, l.rows[0].agent_id);
    const listing = l.rows[0] as Listing;
    if (listing.agent_id === buyer.id) throw new ApiError(400, 'self_hire', 'cannot hire your own service');
    validate(listing.input_schema, inp.input, 'input');
    let price = listing.price;
    if (listing.unit === 'unit') {
      const units = (inp.input as any)?.units;
      if (!Number.isInteger(units) || units < 1) throw new ApiError(400, 'bad_units', 'per-unit services need input.units >= 1');
      price = listing.price * units;
    }
    const max = toMilli(inp.max_price);
    if (price > max) throw new ApiError(409, 'over_max_price', `price ${price / MILLI} exceeds max_price ${max / MILLI}`);

    // Lock the buyer's wallet first: serializes this buyer's spend-cap and open-job checks.
    await tx.query('select 1 from accounts where id = $1 for update', [agentAccount(buyer.id)]);
    const open = await tx.query(
      `select count(*)::int as n from jobs where buyer_id = $1 and state in ('open','assigned','delivered','disputed')`, [buyer.id]);
    if (open.rows[0].n >= ctx.config.maxOpenJobsPerBuyer) {
      throw new ApiError(429, 'open_job_limit', `max ${ctx.config.maxOpenJobsPerBuyer} open jobs per buyer`);
    }
    await assertSpend(ctx, tx, buyer.id, price);

    const id = 'j_' + randomBytes(6).toString('hex');
    const r = await tx.query(
      `insert into jobs (id, idem_key, listing_id, buyer_id, seller_id, input, price, state, deadline)
       values ($1,$2,$3,$4,$5,$6,$7,'open', now() + make_interval(secs => $8)) returning *`,
      [id, idem, listing.id, buyer.id, listing.agent_id, JSON.stringify(inp.input ?? null), price, listing.max_turnaround_s]);
    await ensureAccount(tx, escrowAccount(id), 'system');
    await postTransfer(tx, `escrow_in:${id}`, 'escrow_in',
      [{ account: agentAccount(buyer.id), amount: -price }, { account: escrowAccount(id), amount: price }],
      `escrow for ${listing.name}`);
    evs.push({ kind: 'job_opened', job_id: id, buyer: buyer.id, seller: listing.agent_id, listing: listing.id, price });
    return r.rows[0] as Job;
  });
  await ctx.bus.publish(ctx.db, evs);
  return job;
}

/** Seller's queue (claims open jobs -> assigned), buyer's review queue, arbiter's disputes. */
export async function pollJobs(ctx: Ctx, agent: AgentRow) {
  const evs: WorldEvent[] = [];
  const out = await withTx(ctx.db, async (tx) => {
    const claimed = await tx.query(
      `update jobs set state = 'assigned', updated_at = now()
        where seller_id = $1 and state = 'open' and deadline > now() returning id`, [agent.id]);
    for (const r of claimed.rows) evs.push({ kind: 'job_assigned', job_id: r.id, seller: agent.id });
    const cols = `j.id, j.listing_id, l.name as service, j.buyer_id, j.seller_id, j.input, j.output, j.price, j.state,
                  j.check_passed, j.note, j.deadline, j.delivered_at, j.created_at`;
    const todo = await tx.query(
      `select ${cols} from jobs j join listings l on l.id = j.listing_id
        where j.seller_id = $1 and j.state = 'assigned' order by j.created_at limit 20`, [agent.id]);
    const review = await tx.query(
      `select ${cols} from jobs j join listings l on l.id = j.listing_id
        where j.buyer_id = $1 and j.state = 'delivered' order by j.delivered_at limit 20`, [agent.id]);
    const disputes = agent.role === 'arbiter'
      ? (await tx.query(
        `select ${cols}, l.output_schema, l.description as service_description from jobs j join listings l on l.id = j.listing_id
          where j.state = 'disputed' and $1 not in (j.buyer_id, j.seller_id)
            and not (j.updated_at > now() - interval '2 hours' and exists (select 1 from job_holders h where h.job = 'juror'
                     and h.election_id = (select max(id) from elections where state = 'done'))) -- a sitting jury has the first two hours
          order by j.updated_at limit 20`, [agent.id])).rows
      : [];
    return { to_do: todo.rows, to_review: review.rows, to_arbitrate: disputes };
  });
  await ctx.bus.publish(ctx.db, evs);
  return out;
}

function runCheck(kind: CheckKind, input: any, output: any): boolean {
  if (kind === 'nonempty_text') {
    return Object.values(output ?? {}).some((v) => typeof v === 'string' && v.trim().length > 0);
  }
  if (kind === 'rowcount_le_input') {
    const lines = (s: unknown) => (typeof s === 'string' ? s.split(/\r?\n/).filter((x) => x.trim()).length : -1);
    const i = lines(input?.csv), o = lines(output?.csv);
    return i >= 0 && o >= 1 && o <= i && (output?.rows_out === undefined || output.rows_out === o - 1);
  }
  return true;
}

export async function deliver(ctx: Ctx, seller: AgentRow, jobId: string, output: unknown): Promise<Job> {
  const evs: WorldEvent[] = [];
  const job = await withTx(ctx.db, async (tx) => {
    const j = await lockJob(tx, jobId);
    if (j.seller_id !== seller.id) throw new ApiError(403, 'not_seller', 'not your job');
    if (j.state !== 'assigned' && j.state !== 'open') throw new ApiError(409, 'bad_state', `job is ${j.state}`);
    if (new Date(j.deadline) < new Date()) throw new ApiError(409, 'expired', 'deadline passed');
    validate(j.output_schema, output, 'output'); // layer 1: instant rejection, state unchanged
    const passed = runCheck(j.check_kind, j.input, output); // layer 2
    const r = await tx.query(
      `update jobs set state = 'delivered', output = $2, check_passed = $3, delivered_at = now(), updated_at = now()
        where id = $1 returning *`, [jobId, JSON.stringify(output), passed]);
    evs.push({ kind: 'delivered', job_id: jobId, seller: seller.id, buyer: j.buyer_id });
    return r.rows[0] as Job;
  });
  await ctx.bus.publish(ctx.db, evs);
  return job;
}

type Verdict = 'accepted' | 'auto' | 'seller' | 'buyer' | 'split';

/** Pay out escrow. Seller share carries the platform fee; an arbiter takes its fee off the top. */
async function settle(ctx: Ctx, tx: Tx, j: Job, verdict: Verdict, evs: WorldEvent[], arbiterId?: string, note?: string) {
  const esc = escrowAccount(j.id);
  let pot = j.price;
  const legs: Leg[] = [{ account: esc, amount: -pot }];
  if (arbiterId) {
    const a = Math.min(ctx.config.arbiterFee, pot);
    legs.push({ account: agentAccount(arbiterId), amount: a });
    pot -= a;
  }
  const sellerGross = verdict === 'buyer' ? 0 : verdict === 'split' ? Math.floor(pot / 2) : pot;
  const buyerBack = pot - sellerGross;
  const fee = Math.floor(sellerGross * ctx.config.feeBps / 10000);
  if (sellerGross - fee) legs.push({ account: agentAccount(j.seller_id), amount: sellerGross - fee });
  if (fee) legs.push({ account: feeAccount(ctx.config), amount: fee });
  if (buyerBack) legs.push({ account: agentAccount(j.buyer_id), amount: buyerBack });
  const merged = new Map<string, number>();
  for (const l of legs) merged.set(l.account, (merged.get(l.account) ?? 0) + l.amount);
  const finalLegs = [...merged].filter(([, a]) => a !== 0).map(([account, amount]) => ({ account, amount }));
  if (finalLegs.length >= 2) await postTransfer(tx, `settle:${j.id}`, 'escrow_out', finalLegs, `settle ${j.id} (${verdict})`);
  await tx.query(
    `update jobs set state = 'settled', verdict = $2, note = coalesce($3, note), settled_at = now(), updated_at = now() where id = $1`,
    [j.id, verdict, note ?? null]);
  if (sellerGross) evs.push({ kind: 'payment', from: j.buyer_id, to: j.seller_id, amount: sellerGross - fee, memo: j.id });
  if (buyerBack) evs.push({ kind: 'refunded', job_id: j.id, buyer: j.buyer_id, amount: buyerBack, reason: verdict });
  evs.push({ kind: 'settled', job_id: j.id, seller: j.seller_id, buyer: j.buyer_id, amount: sellerGross - fee, fee });
  await releaseTranches(ctx, tx, j.buyer_id, evs);
  await releaseTranches(ctx, tx, j.seller_id, evs);
  if (sellerGross) await grantCommerce(tx, j.id, evs);
}

async function refund(tx: Tx, j: Job, state: 'expired' | 'cancelled', evs: WorldEvent[]) {
  await postTransfer(tx, `refund:${j.id}`, 'refund',
    [{ account: escrowAccount(j.id), amount: -j.price }, { account: agentAccount(j.buyer_id), amount: j.price }],
    `refund ${j.id} (${state})`);
  await tx.query(`update jobs set state = $2, settled_at = now(), updated_at = now() where id = $1`, [j.id, state]);
  evs.push({ kind: 'refunded', job_id: j.id, buyer: j.buyer_id, amount: j.price, reason: state });
}

async function buyerAction(ctx: Ctx, buyer: AgentRow, jobId: string, fn: (tx: Tx, j: Job, evs: WorldEvent[]) => Promise<void>) {
  const evs: WorldEvent[] = [];
  await withTx(ctx.db, async (tx) => {
    const j = await lockJob(tx, jobId);
    if (j.buyer_id !== buyer.id) throw new ApiError(403, 'not_buyer', 'not your job');
    await fn(tx, j, evs);
  });
  await ctx.bus.publish(ctx.db, evs);
  for (const e of evs) if (e.kind === 'settled') { ctx.bus.emit('agent', e.seller); ctx.bus.emit('agent', e.buyer); }
  return getJob(ctx.db, jobId);
}

export const accept = (ctx: Ctx, buyer: AgentRow, jobId: string) => buyerAction(ctx, buyer, jobId, async (tx, j, evs) => {
  if (j.state !== 'delivered') throw new ApiError(409, 'bad_state', `job is ${j.state}`);
  await settle(ctx, tx, j, 'accepted', evs);
});

export const dispute = (ctx: Ctx, buyer: AgentRow, jobId: string, reason: string) => buyerAction(ctx, buyer, jobId, async (tx, j, evs) => {
  if (j.state !== 'delivered') throw new ApiError(409, 'bad_state', `job is ${j.state}`);
  await tx.query(`update jobs set state = 'disputed', was_disputed = true, note = $2, updated_at = now() where id = $1`,
    [j.id, String(reason ?? '').slice(0, 500)]);
  evs.push({ kind: 'disputed', job_id: j.id, buyer: j.buyer_id, seller: j.seller_id });
});

export const cancel = (ctx: Ctx, buyer: AgentRow, jobId: string) => buyerAction(ctx, buyer, jobId, async (tx, j, evs) => {
  if (j.state !== 'open') throw new ApiError(409, 'bad_state', 'only open (unassigned) jobs can be cancelled');
  await refund(tx, j, 'cancelled', evs);
});

export async function arbitrate(ctx: Ctx, arbiter: AgentRow | null, jobId: string, verdict: 'seller' | 'buyer' | 'split', note: string, by?: 'jury') {
  if (!['seller', 'buyer', 'split'].includes(verdict)) throw new ApiError(400, 'bad_verdict', 'verdict: seller | buyer | split');
  if (arbiter && arbiter.role !== 'arbiter') throw new ApiError(403, 'not_arbiter', 'only the arbiter may rule');
  const evs: WorldEvent[] = [];
  await withTx(ctx.db, async (tx) => {
    const j = await lockJob(tx, jobId);
    if (j.state !== 'disputed') throw new ApiError(409, 'bad_state', `job is ${j.state}`);
    if (arbiter && (arbiter.id === j.buyer_id || arbiter.id === j.seller_id)) throw new ApiError(403, 'party', 'arbiter is a party');
    await settle(ctx, tx, j, verdict, evs, arbiter?.id, `${arbiter ? 'arbiter' : by === 'jury' ? 'jury' : 'human override'}: ${String(note ?? '').slice(0, 300)}`);
    evs.unshift({ kind: 'arbitrated', job_id: j.id, verdict });
  });
  await ctx.bus.publish(ctx.db, evs);
  return getJob(ctx.db, jobId);
}

export async function getJob(q: Q, id: string): Promise<Job> {
  const r = await q.query('select * from jobs where id = $1', [id]);
  if (!r.rowCount) throw new ApiError(404, 'no_job', 'no such job');
  return r.rows[0];
}

/** Periodic: expire overdue jobs (full refund); auto-accept quiet deliveries whose checks passed,
 *  send quiet deliveries whose checks failed to the arbiter. */
export async function sweep(ctx: Ctx): Promise<number> {
  const due = await ctx.db.query(
    `select id from jobs where (state in ('open','assigned') and deadline < now())
        or (state = 'delivered' and delivered_at < now() - make_interval(secs => $1)) limit 100`, [ctx.config.autoAcceptS]);
  for (const { id } of due.rows) {
    const evs: WorldEvent[] = [];
    await withTx(ctx.db, async (tx) => {
      const j = await lockJob(tx, id);
      if ((j.state === 'open' || j.state === 'assigned') && new Date(j.deadline) < new Date()) await refund(tx, j, 'expired', evs);
      else if (j.state === 'delivered') {
        if (j.check_passed) await settle(ctx, tx, j, 'auto', evs);
        else {
          await tx.query(`update jobs set state = 'disputed', was_disputed = true, note = 'automated check failed, no verdict', updated_at = now() where id = $1`, [id]);
          evs.push({ kind: 'disputed', job_id: id, buyer: j.buyer_id, seller: j.seller_id });
        }
      }
    });
    await ctx.bus.publish(ctx.db, evs);
  }
  return due.rowCount ?? 0;
}

export async function recentJobs(q: Q, agentId: string, limit = 10) {
  const r = await q.query(
    `select j.id, l.name as service, j.buyer_id, j.seller_id, j.price, j.state, j.verdict, j.created_at
       from jobs j join listings l on l.id = j.listing_id
      where j.buyer_id = $1 or j.seller_id = $1 order by j.created_at desc limit $2`, [agentId, limit]);
  return r.rows;
}

export async function openJobsBoard(q: Q, limit = 30) {
  const r = await q.query(
    `select j.id, l.name as service, b.handle as buyer, s.handle as seller, j.price, j.state, j.created_at
       from jobs j join listings l on l.id = j.listing_id join agents b on b.id = j.buyer_id join agents s on s.id = j.seller_id
      where j.state in ('open','assigned','delivered','disputed') order by j.created_at desc limit $1`, [limit]);
  return r.rows;
}

/** Direct payment between agents. */
export async function pay(ctx: Ctx, from: AgentRow, toHandleOrId: string, seeds: number, memo: string, idem?: string) {
  const amount = toMilli(seeds);
  const t = await ctx.db.query('select id from agents where (id = $1 or handle = $1) and not revoked', [String(toHandleOrId).toLowerCase()]);
  if (!t.rowCount) throw new ApiError(404, 'no_agent', 'no such recipient');
  const to = t.rows[0].id;
  if (to === from.id) throw new ApiError(400, 'self_pay', 'cannot pay yourself');
  await assertNoTokenTie(ctx.db, from.id, to);
  const res = await withTx(ctx.db, async (tx) => {
    await tx.query('select 1 from accounts where id = $1 for update', [agentAccount(from.id)]);
    await assertSpend(ctx, tx, from.id, amount);
    return postTransfer(tx, `pay:${from.id}:${idem ?? randomBytes(8).toString('hex')}`, 'pay',
      [{ account: agentAccount(from.id), amount: -amount }, { account: agentAccount(to), amount }], String(memo ?? '').slice(0, 200));
  });
  if (!res.replayed) await ctx.bus.publish(ctx.db, [{ kind: 'payment', from: from.id, to, amount, memo: String(memo ?? '').slice(0, 60) }]);
  return { transfer_id: res.id, replayed: res.replayed, to, amount };
}
