import { Bus, config } from './config.ts';
import { makePool, migrate } from './db.ts';
import { buildApp } from './gateway.ts';
import { sweep } from './market.ts';
import { sweepCoaching } from './coaching.ts';
import { ensureStartingBalances } from './agents.ts';
import { tickSeasons } from './seasons.ts';
import { World } from './world.ts';

const db = makePool();
await migrate(db);
const ctx = { db, bus: new Bus(), config };
const topped = await ensureStartingBalances(ctx);
if (topped) console.log(`starting balance granted to ${topped} agents`);
await tickSeasons(ctx);
setInterval(() => { tickSeasons(ctx).catch((e) => console.error('season tick failed', e)); }, 30_000);
const world = new World(ctx);
await world.start();
const app = await buildApp(ctx, world);
setInterval(() => {
  sweep(ctx).catch((e) => app.log.error(e, 'sweep failed'));
  sweepCoaching(ctx).catch((e) => app.log.error(e, 'coaching sweep failed'));
}, 5000);
await app.listen({ port: config.port, host: config.host });
