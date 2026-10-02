import { makePool, migrate } from './db.ts';
const db = makePool();
await migrate(db);
await db.end();
console.log('migrated');
