// Double-entry ledger. Every movement is one transfer with entries that sum to zero,
// written in one DB transaction under row locks, keyed by an idempotency key.
import { randomUUID } from 'node:crypto';
import type { Db, Q, Tx } from './db.ts';
import { withTx } from './db.ts';
import { ApiError } from './types.ts';

export interface Leg { account: string; amount: number }
export interface TransferResult { id: string; replayed: boolean }

export const agentAccount = (id: string) => `agent:${id}`;
export const escrowAccount = (jobId: string) => `escrow:${jobId}`;

export async function ensureAccount(q: Q, id: string, kind: 'system' | 'agent'): Promise<void> {
  await q.query('insert into accounts (id, kind) values ($1, $2) on conflict do nothing', [id, kind]);
}

/** Post a balanced transfer inside an existing transaction. */
export async function postTransfer(
  tx: Tx, key: string, kind: string, legs: Leg[], memo?: string,
): Promise<TransferResult> {
  if (legs.length < 2) throw new ApiError(400, 'bad_transfer', 'a transfer needs at least two legs');
  for (const l of legs) {
    if (!Number.isSafeInteger(l.amount) || l.amount === 0) {
      throw new ApiError(400, 'bad_amount', 'amounts must be non-zero integers (milli-seeds)');
    }
  }
  if (legs.reduce((s, l) => s + l.amount, 0) !== 0) throw new ApiError(500, 'unbalanced', 'entries must sum to zero');

  const existing = await tx.query('select id from transfers where idempotency_key = $1', [key]);
  if (existing.rowCount) return { id: existing.rows[0].id, replayed: true };

  // Lock every touched account in a fixed order so concurrent transfers cannot deadlock.
  const ids = [...new Set(legs.map((l) => l.account))].sort();
  const locked = await tx.query(
    'select id, balance from accounts where id = any($1) order by id for update', [ids],
  );
  if (locked.rowCount !== ids.length) {
    const have = new Set(locked.rows.map((r) => r.id));
    throw new ApiError(404, 'no_account', `unknown account: ${ids.filter((i) => !have.has(i)).join(', ')}`);
  }
  const bal = new Map<string, number>(locked.rows.map((r) => [r.id, r.balance]));
  for (const l of legs) bal.set(l.account, bal.get(l.account)! + l.amount);
  for (const [id, b] of bal) {
    if (b < 0 && id !== 'treasury') throw new ApiError(402, 'insufficient_funds', `${id} would go negative`);
  }

  const id = randomUUID();
  const ins = await tx.query(
    `insert into transfers (id, idempotency_key, kind, memo) values ($1, $2, $3, $4)
     on conflict (idempotency_key) do nothing returning id`,
    [id, key, kind, memo ?? null],
  );
  if (!ins.rowCount) {
    // Lost a race with the same key: the other writer's transfer stands.
    const row = await tx.query('select id from transfers where idempotency_key = $1', [key]);
    return { id: row.rows[0].id, replayed: true };
  }
  for (const l of legs) {
    await tx.query('insert into entries (transfer_id, account_id, amount) values ($1, $2, $3)', [id, l.account, l.amount]);
  }
  for (const [acct, b] of bal) {
    await tx.query('update accounts set balance = $2 where id = $1', [acct, b]);
  }
  return { id, replayed: false };
}

export async function transfer(db: Db, key: string, kind: string, legs: Leg[], memo?: string) {
  return withTx(db, (tx) => postTransfer(tx, key, kind, legs, memo));
}

export async function balance(q: Q, account: string): Promise<number> {
  const r = await q.query('select balance from accounts where id = $1', [account]);
  if (!r.rowCount) throw new ApiError(404, 'no_account', `unknown account ${account}`);
  return r.rows[0].balance;
}

export async function recentTransfers(q: Q, account: string, limit = 20) {
  const r = await q.query(
    `select t.id, t.kind, t.memo, t.created_at, e.amount,
            (select string_agg(e2.account_id, ',') from entries e2
              where e2.transfer_id = t.id and e2.account_id <> $1) as counterparties
       from entries e join transfers t on t.id = e.transfer_id
      where e.account_id = $1 order by e.id desc limit $2`,
    [account, limit],
  );
  return r.rows;
}

/** Recompute balances from entries; any mismatch or unbalanced transfer is drift. */
export async function reconcile(q: Q) {
  const drift = await q.query(
    `select a.id, a.balance, coalesce(sum(e.amount), 0)::bigint as computed
       from accounts a left join entries e on e.account_id = a.id
      group by a.id, a.balance having a.balance <> coalesce(sum(e.amount), 0)`,
  );
  const unbalanced = await q.query(
    'select transfer_id, sum(amount)::bigint as s from entries group by transfer_id having sum(amount) <> 0',
  );
  const total = await q.query('select coalesce(sum(balance), 0)::bigint as s from accounts');
  return {
    ok: drift.rowCount === 0 && unbalanced.rowCount === 0 && total.rows[0].s === 0,
    drift: drift.rows,
    unbalanced: unbalanced.rows,
    total: total.rows[0].s,
  };
}
