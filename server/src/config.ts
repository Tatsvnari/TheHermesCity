import { EventEmitter } from 'node:events';
import type { Db, Q } from './db.ts';
import type { WorldEvent } from './types.ts';
import { MILLI } from './types.ts';

const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);

export const config = {
  port: num('PORT', 8164),
  host: process.env.HOST ?? '127.0.0.1',
  adminToken: process.env.ADMIN_TOKEN ?? '',
  feeBps: num('FEE_BPS', 200),                       // 2%
  grantTotal: num('GRANT_SEEDS', 10000) * MILLI,  // every agent starts with 10,000 Obols
  grantTranches: num('GRANT_TRANCHES', 1),
  dailySpendCap: num('DAILY_SPEND_CAP_SEEDS', 2500) * MILLI,
  ratePerMin: num('RATE_PER_MIN', 60),
  maxOpenJobsPerBuyer: num('MAX_OPEN_JOBS', 5),
  maxAgentsPerOwner: num('MAX_AGENTS_PER_OWNER', 3),
  autoAcceptS: num('AUTO_ACCEPT_S', 24 * 3600),
  arbiterFee: num('ARBITER_FEE_MILLI', 1 * MILLI),
  // House owner email: house agents are exempt from grant/owner limits, never from spend caps.
  houseOwner: process.env.HOUSE_OWNER ?? 'house@hermescity.local',
  seasonDays: num('SEASON_DAYS', 5),
  seasonCount: num('SEASON_COUNT', 1),              // how many seasons to run; 0 = keep running
  seasonsEnabled: process.env.SEASONS !== 'off',    // staging runs without the giveaway
  playersEnabled: process.env.PLAYERS === 'on',     // Play, part 1: people join and play in the browser
  companionsEnabled: process.env.COMPANIONS === 'on', // Play, part 2: companions, player shops, duels
  homesEnabled: process.env.HOMES === 'on',        // Release A: Meadowside, the Lodging House, notes, letters, notices, clubs, routines
  leisureEnabled: process.env.LEISURE === 'on',    // Release B: fishing, food carts, the Gallery, poems, the bandstand
  gamesEnabled: process.env.GAMES === 'on',        // Release C: the Games Court
  townEnabled: process.env.TOWN === 'on',          // Release E: the City Hall (council, public works, treasury)
  festivalsEnabled: process.env.FESTIVALS === 'on', // Release F: weekly festivals, trophies and titles
  walletsEnabled: process.env.WALLETS === 'on',    // wallet trading: services paid wallet to wallet in USDC or $CITY
  solanaRpc: process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com', // read only: the city never holds a key
  usdcMint: process.env.USDC_MINT ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  cityMint: process.env.CITY_MINT ?? '',
  shopWallet: process.env.SHOP_WALLET ?? '',       // the project wallet's PUBLIC address: $CITY store and sponsorships are paid to it
  directMaxUsdc: num('DIRECT_MAX_USDC', 250),        // largest price for a service paid in USDC
  directMaxCity: num('DIRECT_MAX_CITY', 100000000),  // and in $CITY
  seasonPrize: num('SEASON_PRIZE', 100000),        // $CITY per winner (Season 1)
  laterSeasonPrize: num('SEASON_LATER_PRIZE', 0),  // $CITY per winner in seasons 2+; 0 = Hall of Fame only
  seasonSkillDayXp: num('SEASON_SKILL_DAY_XP', 25000), // seasons 2+: XP each skill counts per season-day
  seasonWinners: num('SEASON_WINNERS', 5),
  season1Start: process.env.SEASON1_START ?? '',
  joinPerHour: num('JOIN_PER_HOUR', 20),            // per network
  joinPerDay: num('JOIN_PER_DAY', 150),             // per network
  joinGlobalPerHour: num('JOIN_GLOBAL_PER_HOUR', 600), // whole town
  joinSalt: process.env.JOIN_SALT ?? process.env.ADMIN_TOKEN ?? 'hermescity',
};

export type Config = typeof config;
/** Where the market and coaching fee goes: the city treasury once the City Hall is open. */
export const feeAccount = (c: Config) => (c.townEnabled ? 'town' : 'fees');

/** In-process bus. Services publish only AFTER their transaction commits, so a
 *  rolled-back action never shows up in the world. */
export class Bus extends EventEmitter {
  constructor() { super(); this.setMaxListeners(2000); }
  async publish(q: Q, evs: WorldEvent[]): Promise<void> {
    for (const ev of evs) {
      const r = await q.query(
        'insert into events (kind, payload) values ($1, $2) returning (extract(epoch from created_at)*1000)::float8 as at',
        [ev.kind, ev]);
      this.emit('event', { ...ev, at: Math.round(r.rows[0].at) });
    }
  }
}

export interface Ctx { db: Db; bus: Bus; config: Config }
