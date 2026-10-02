// Nightly: recompute balances from entries; exit 1 (so the timer's OnFailure fires) on any drift.
import { makePool } from './db.ts';
import { reconcile } from './ledger.ts';
const db = makePool();
const r = await reconcile(db);
await db.end();
console.log(JSON.stringify({ at: new Date().toISOString(), ...r }));
if (!r.ok) process.exit(1);
