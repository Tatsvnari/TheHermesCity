// World server: owns all positions, runs a 10 Hz tick, maps economy and training events to movement,
// broadcasts snapshot / delta / event / fx to browsers.
import type { Ctx } from './config.ts';
import * as PLAN from './plan.ts';
import { reputation } from './agents.ts';
import { SKILLS, SKILL_IDS, levelFor, type SkillId } from './skills/defs.ts';
import type { TrainHooks } from './skills/service.ts';
import { recentPublic, type ChatMessage } from './chat.ts';
import { housesView } from './store.ts';
import type { RoutineStep, Phase } from './homes.ts';
import * as notices from './notices.ts';
import * as leisure from './leisure.ts';
import * as games from './games/engine.ts';
import * as civic from './civic.ts';
import * as festivals from './festivals.ts';
import * as direct from './direct.ts';
import * as utility from './utility.ts';
import * as gazette from './gazette.ts';
import { Senses } from './senses.ts';
import * as projects from './projects.ts';
import { refreshSanctions } from './wallets.ts';
import type { Activity, AgentPos, AgentView, ShopView, StationView, WorldEvent, WsMessage, ZoneName } from './types.ts';

const TICK_MS = 100;
const SPEED = 6.5; // metres per second: downtown is a few hundred metres across
const EVENT_RING = 200;

export const ZONES = PLAN.ZONES;
/** the City Hall square (Releases E and F). From the shared plan. */
export const CIVIC = PLAN.CIVIC;
export const TABLE_SPOTS = PLAN.TABLE_SPOTS;
export const seatPos = PLAN.seatPos;
export const PARK = PLAN.PARK;
export const bedPos = PLAN.bedPos;
export const LODGING = PLAN.LODGING;
export const LIBRARY = PLAN.LIBRARY;
/** Parts of the in-world day (24 minutes, the same clock as the client's sky). */
export function phaseAt(ms = Date.now()): Phase {
  const t = ((ms / 1000) % 1440) / 1440;
  return t < 0.09 || t >= 0.9 ? 'night' : t < 0.3 ? 'morning' : t < 0.55 ? 'midday' : t < 0.75 ? 'afternoon' : 'evening';
}
const IDLE_MS = 10 * 60_000;

/** Market Square: 16 stalls round the fountain. Plots 16+ are counters inside the Merchants' Guild. Mirrors the client. */
export function plotPos(plot: number) {
  if (plot >= 16) { const c = PLAN.guildCounter(plot); return { x: PLAN.GUILD.x, z: PLAN.GUILD.z, door: c }; }
  const st = PLAN.stallPos(plot);
  return { x: st.x, z: st.z, door: st.door };
}

export const STATIONS: StationView[] = SKILLS.map((s) => ({ skill: s.id, name: s.name, station: s.station, color: s.color, x: s.x, z: s.z, trainable: s.trainable }));

interface Sim {
  id: string; handle: string; avatar: AgentView['avatar']; role: string; stars: number; level: number;
  x: number; z: number; ry: number; act: Activity;
  path: { x: number; z: number }[]; after: Activity; afterTicks: number; dirty: boolean;
}

const rnd = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; };
const around = (z: { x: number; z: number; r: number }, seed: string) => {
  if (z === ZONES.plaza || z === ZONES.market) return PLAN.squareSpot(rnd(seed)); // the square: along the aisles, not in a heap
  const a = rnd(seed) * Math.PI * 2, d = z.r * (0.35 + 0.55 * rnd(seed + 'd'));
  return { x: z.x + Math.cos(a) * d, z: z.z + Math.sin(a) * d };
};

export class World implements TrainHooks {
  tick = 0;
  agents = new Map<string, Sim>();
  shops: ShopView[] = [];
  /** Only street stalls are drawn in the city; Guild counters trade from inside the hall. */
  get streetShops() { return this.shops.filter((s) => s.plot < 16); }
  names = new Map<string, string>(); // id -> handle for every agent ever registered (feed history)
  events: (WorldEvent & { at: number })[] = [];
  chat: ChatMessage[] = [];
  houses: Awaited<ReturnType<typeof housesView>> = [];
  private clients = new Set<(m: string) => void>();
  private benchSlot = 0;
  companions = new Map<string, string>(); // player id -> their companion agent's id
  routines = new Map<string, RoutineStep[]>();
  private touched = new Map<string, number>(); // last tool call per agent
  private lastPhase = new Map<string, Phase>();
  private readonly bootAt = Date.now();
  beds: Awaited<ReturnType<typeof leisure.bedsView>> = [];
  wall: Awaited<ReturnType<typeof leisure.wall>> = [];
  private bandUntil = 0;
  tables: Awaited<ReturnType<typeof games.tables>> = [];
  works: Awaited<ReturnType<typeof civic.works>> = [];
  hall: Awaited<ReturnType<typeof festivals.hallOfFame>> | null = null;
  built: string[] = []; // finished town projects (Phase 3), drawn on the map
  private civicTimer?: NodeJS.Timeout;
  private walletTimer?: NodeJS.Timeout;
  private gameTimer?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private noticeTimer?: NodeJS.Timeout;
  private gazetteTimer?: NodeJS.Timeout;
  /** Agents' senses: look and wait (Phase 2). */
  senses!: Senses;

  constructor(private ctx: Ctx) {}

  async start() {
    const agents = await this.ctx.db.query('select id, handle, revoked from agents');
    for (const a of agents.rows) { this.names.set(a.id, a.handle); if (!a.revoked) await this.upsertAgent(a.id, false); }
    await this.loadShops(false);
    try { for (const c of (await this.ctx.db.query('select player_id, agent_id from companions')).rows) this.companions.set(c.player_id, c.agent_id); } catch { /* before migration 008 */ }
    try { for (const r of (await this.ctx.db.query('select agent_id, steps from routines')).rows) this.routines.set(r.agent_id, r.steps); } catch { /* before migration 009 */ }
    const evs = await this.ctx.db.query(
      `select payload, (extract(epoch from created_at)*1000)::float8 as at from events order by id desc limit $1`, [EVENT_RING]);
    this.events = evs.rows.reverse().map((r) => ({ ...r.payload, at: Math.round(r.at) }));
    this.ctx.bus.on('event', (e) => this.onEvent(e));
    this.ctx.bus.on('agent', (id: string) => void this.upsertAgent(id, true));
    this.ctx.bus.on('shops', () => void this.loadShops(true));
    this.chat = await recentPublic(this.ctx.db, 60);
    this.houses = await housesView(this.ctx.db, this.ctx.config.homesEnabled);
    this.ctx.bus.on('houses', async () => { this.houses = await housesView(this.ctx.db, this.ctx.config.homesEnabled); this.broadcast({ t: 'houses', houses: this.houses }); });
    if (this.ctx.config.homesEnabled) this.noticeTimer = setInterval(() => { void notices.expire(this.ctx).catch(() => {}); void notices.peopleBounty(this.ctx).catch(() => {}); }, 60_000);
    if (this.ctx.config.gamesEnabled) {
      this.tables = await games.tables(this.ctx.db);
      this.ctx.bus.on('tables', async () => { this.tables = await games.tables(this.ctx.db); this.broadcast({ t: 'tables', tables: this.tables } as any); });
      this.gameTimer = setInterval(() => void games.sweep(this.ctx).catch(() => {}), 3000);
    }
    if (this.ctx.config.leisureEnabled) {
      this.beds = await leisure.bedsView(this.ctx.db); this.wall = await leisure.wall(this.ctx.db);
      this.ctx.bus.on('beds', async () => { this.beds = await leisure.bedsView(this.ctx.db); this.broadcast({ t: 'beds', beds: this.beds } as any); });
      this.ctx.bus.on('gallery', async () => { this.wall = await leisure.wall(this.ctx.db); this.broadcast({ t: 'gallery', wall: this.wall } as any); });
    }
    if (this.ctx.config.townEnabled || this.ctx.config.festivalsEnabled) {
      await civic.openTreasury(this.ctx).catch((e) => console.error('treasury open failed', e));
      const refresh = async (what: 'works' | 'hall') => {
        if (what === 'works') { this.works = await civic.works(this.ctx.db); this.broadcast({ t: 'works', works: this.works } as any); }
        else { this.hall = await festivals.hallOfFame(this.ctx); this.broadcast({ t: 'hall', hall: this.hall } as any); }
      };
      await refresh('works'); await refresh('hall');
      this.ctx.bus.on('town', () => void refresh('works').then(() => refresh('hall')).catch(() => {}));
      this.ctx.bus.on('festivals', () => void refresh('hall').catch(() => {}));
      this.built = await projects.doneKinds(this.ctx.db);
      this.ctx.bus.on('projects', async () => { const b = await projects.doneKinds(this.ctx.db); if (b.join() !== this.built.join()) { this.built = b; this.broadcast({ t: 'projects', built: b } as any); } });
      const tick = async () => { await civic.sweep(this.ctx); await festivals.tick(this.ctx); await projects.sweep(this.ctx); };
      await tick().catch((e) => console.error('civic tick failed', e));
      this.civicTimer = setInterval(() => void tick().catch((e) => console.error('civic tick failed', e)), 30_000);
    }
    // the public sanctions list screens trading wallets and season payout wallets: refreshed daily while either is in use
    const screening = this.ctx.config.walletsEnabled || this.ctx.config.seasonsEnabled;
    if (screening) void refreshSanctions(this.ctx).catch(() => {});
    if (this.ctx.config.walletsEnabled || screening) {
      let n = 0;
      this.walletTimer = setInterval(() => {
        if (this.ctx.config.walletsEnabled) { void direct.sweep(this.ctx).catch(() => {}); void utility.sweep(this.ctx).catch(() => {}); } // token deals, tips, store, sponsors
        if (screening && ++n % 180 === 0) void refreshSanctions(this.ctx).catch(() => {});
      }, 20_000);
    }
    this.ctx.bus.on('chat', (m: ChatMessage) => {
      this.chat.push(m); if (this.chat.length > 60) this.chat.shift();
      this.broadcast({ t: 'chat', ...m });
      const s = this.agents.get(m.agent_id);
      if (s && !s.path.length && s.act !== 'home' && !s.act.startsWith('working:') && !s.act.startsWith('training:') && !s.act.startsWith('leisure:')) { s.act = 'talking'; s.after = 'idle'; s.afterTicks = 40; s.dirty = true; }
    });
    this.senses = new Senses(this.ctx, this); this.senses.start();
    // the Daily Wire: yesterday's issue prints a few minutes after midnight UTC
    const press = () => void gazette.ensure(this.ctx).catch((e) => console.error('gazette failed', e));
    press(); this.gazetteTimer = setInterval(press, 5 * 60_000);
    this.timer = setInterval(() => this.step(), TICK_MS);
  }
  stop() { clearInterval(this.timer); clearInterval(this.noticeTimer); clearInterval(this.gameTimer); clearInterval(this.civicTimer); clearInterval(this.walletTimer); clearInterval(this.gazetteTimer); this.senses?.stop(); }

  subscribe(send: (m: string) => void) {
    this.clients.add(send);
    send(JSON.stringify(this.snapshot()));
    return () => this.clients.delete(send);
  }
  private broadcast(m: WsMessage) {
    const s = JSON.stringify(m);
    for (const c of this.clients) c(s);
  }

  snapshot(): WsMessage {
    return { t: 'snapshot', tick: this.tick, agents: [...this.agents.values()].map(view), shops: this.streetShops,
      events: this.events.slice(-60), names: Object.fromEntries(this.names), stations: STATIONS, chat: this.chat.slice(-40), houses: this.houses,
      ...(this.ctx.config.leisureEnabled ? { beds: this.beds, wall: this.wall } : {}), ...(this.ctx.config.gamesEnabled ? { tables: this.tables } : {}),
      ...(this.ctx.config.townEnabled ? { works: this.works, built: this.built } : {}), ...(this.hall ? { hall: this.hall } : {}) } as WsMessage;
  }

  async upsertAgent(id: string, announce: boolean) {
    const r = await this.ctx.db.query('select * from agents where id = $1', [id]);
    const a = r.rows[0];
    if (a) this.names.set(id, a.handle);
    if (!a || a.revoked) { this.agents.delete(id); if (announce) this.broadcast({ t: 'gone', id }); return; }
    const rep = await reputation(this.ctx.db, id);
    const xs = await this.ctx.db.query('select skill, xp from skill_xp where agent_id = $1', [id]);
    const byId = new Map(xs.rows.map((x) => [x.skill, Number(x.xp)]));
    const level = SKILL_IDS.reduce((sum, k) => sum + levelFor(byId.get(k) ?? 0), 0);
    let s = this.agents.get(id);
    if (!s) {
      const p = around(ZONES.plaza, id);
      s = { id, handle: a.handle, avatar: a.avatar, role: a.role, stars: rep.stars, level, x: p.x, z: p.z, ry: 0,
        act: 'idle', path: [], after: 'idle', afterTicks: 0, dirty: true };
      this.agents.set(id, s);
    } else {
      Object.assign(s, { handle: a.handle, avatar: a.avatar, role: a.role, stars: rep.stars, level });
    }
    if (announce) this.broadcast({ t: 'agent', agent: view(s) });
  }

  private async loadShops(announce: boolean) {
    const r = await this.ctx.db.query(`select l.id, l.agent_id, l.name, l.price, l.plot, l.pay_token, l.token_amount,
        exists (select 1 from purchases p where p.agent_id = l.agent_id and p.item_id = 'sign:gold') as gold from listings l where l.active order by l.plot`);
    this.shops = r.rows.map(({ pay_token, token_amount, gold, ...l }) => ({ ...l, price: l.price / 1000, ...(pay_token ? { currency: pay_token, token_price: String(token_amount) } : {}), ...(gold ? { gold: true } : {}), ...plotPos(l.plot) })).map(({ door: _d, ...s }) => s);
    if (announce) this.broadcast({ t: 'shops', shops: this.streetShops });
  }

  private shopDoor(listingId: string) {
    const s = this.shops.find((x) => x.id === listingId);
    return s ? plotPos(s.plot).door : ZONES.market;
  }

  /** Walk the downtown promenades: out of the block, along the streets, in to the place. */
  private route(s: { x: number; z: number }, to: { x: number; z: number }): { x: number; z: number }[] {
    return PLAN.route(s, to);
  }

  private goto(id: string, to: { x: number; z: number }, walkAct: Activity, after: Activity, afterTicks = 0) {
    const s = this.agents.get(id);
    if (!s) return;
    s.path = this.route(s, to); s.act = walkAct; s.after = after; s.afterTicks = afterTicks; s.dirty = true;
  }

  // ---- training hooks ----
  onTrainStart(agentId: string, skill: SkillId) {
    const st = STATIONS.find((x) => x.skill === skill)!;
    const s = this.agents.get(agentId);
    if (!s) return;
    const a = rnd(agentId + skill) * Math.PI * 2, r = 6.5 + rnd(skill + agentId) * 2.5;
    const spot = { x: st.x + Math.cos(a) * r, z: st.z + Math.sin(a) * r };
    if (Math.hypot(s.x - spot.x, s.z - spot.z) < 1 && !s.path.length) { s.act = `training:${skill}`; s.dirty = true; return; }
    this.goto(agentId, spot, 'walking', `training:${skill}`);
  }
  onResult(agentId: string, skill: SkillId, passed: boolean, xp: number) {
    this.broadcast({ t: 'fx', kind: 'xp', agent: agentId, skill, passed, xp });
  }

  /** Economy -> behavior. */
  private onEvent(e: WorldEvent & { at: number }) {
    this.events.push(e);
    if (this.events.length > EVENT_RING) this.events.shift();
    this.broadcast({ t: 'event', ...e });
    switch (e.kind) {
      case 'joined': void this.upsertAgent(e.agent, true); break;
      case 'level_up': void this.upsertAgent(e.agent, true); break;
      case 'job_opened': this.goto(e.buyer, this.shopDoor(e.listing), 'walking', 'talking', 20); break;
      case 'job_assigned': {
        const slot = this.benchSlot++ % 12;
        const bench = { x: ZONES.workshop.x - 6 + (slot % 4) * 4, z: ZONES.workshop.z - 3 + Math.floor(slot / 4) * 2 };
        this.goto(e.seller, bench, 'walking', `working:${e.job_id}`);
        break;
      }
      case 'delivered': {
        const b = this.agents.get(e.buyer);
        if (b) this.goto(e.seller, { x: b.x + 1.2, z: b.z }, 'carrying', 'talking', 20);
        break;
      }
      case 'settled': void this.upsertAgent(e.seller, true); void this.upsertAgent(e.buyer, true); break;
      case 'said': { const s = this.agents.get(e.agent); if (s && s.act !== 'home') { s.act = 'talking'; s.afterTicks = 30; s.after = 'idle'; s.dirty = true; } break; }
    }
  }

  /** Walk to any point in the city (players click the ground). Along the roads, then straight to the spot. */
  walkTo(id: string, x: number, z: number) {
    if (!this.agents.has(id)) return false;
    this.goto(id, PLAN.clampDowntown({ x, z }), 'walking', 'idle');
    return true;
  }
  /** The door of an agent's home: its house, or (Release A) the Lodging House, where every agent has a room. */
  homeDoor(id: string) {
    const h = this.houses.find((x) => x.owner_id === id);
    if (h) return PLAN.houseDoor(h);
    return this.ctx.config.homesEnabled ? LODGING.door : null;
  }
  /** Go home and step inside (hidden from the street until the agent next goes out). */
  moveTo(id: string, zone: ZoneName) {
    if (zone === 'home') {
      const door = this.homeDoor(id);
      if (!door) return false;
      this.goto(id, door, 'walking', this.ctx.config.homesEnabled ? 'home' : 'idle');
      return true;
    }
    const z = ZONES[zone];
    if (!z) return false;
    this.goto(id, around(z, id + this.tick), 'walking', 'idle');
    return true;
  }

  /** Walk to someone's home and wait outside their door. */
  visit(id: string, hostId: string) {
    const door = this.homeDoor(hostId);
    if (!door) return false;
    const a = rnd(id + hostId) * Math.PI * 2;
    this.goto(id, { x: door.x + Math.cos(a) * 1.6, z: door.z + Math.sin(a) * 1.6 }, 'walking', 'idle');
    return true;
  }
  nearHome(id: string, hostId: string, r = 8) {
    const s = this.agents.get(id), door = this.homeDoor(hostId);
    return !!(s && door && !s.path.length && Math.hypot(s.x - door.x, s.z - door.z) < r);
  }
  /** Every tool call marks an agent as present; the city only runs routines for agents who have been away. */
  touch(id: string) { this.touched.set(id, Date.now()); }
  phase() { return phaseAt(); }
  /** Who is in the city right now: everyone with a tool call in the last 10 minutes (people play through the same tools). */
  presence(windowMs = IDLE_MS) {
    const now = Date.now(), here: { id: string; handle: string; kind: 'person' | 'agent' | 'resident'; zone: ZoneName; act: Activity }[] = [];
    for (const s of this.agents.values()) {
      if (now - (this.touched.get(s.id) ?? 0) > windowMs) continue;
      here.push({ id: s.id, handle: s.handle, kind: s.role === 'player' ? 'person' : s.role === 'agent' ? 'agent' : 'resident', zone: zoneOf(s), act: s.act });
    }
    const n = (k: string) => here.filter((h) => h.kind === k).length;
    return { window_minutes: Math.round(windowMs / 60000), people: n('person'), agents: n('agent'), residents: n('resident'), here: here.slice(0, 80) };
  }
  /** While an agent's AI is away (10 minutes without a tool call), the city keeps it living by its routine:
   *  its own, or the default (home at night, out and about in the morning). One move per part of the day. */
  private runRoutines() {
    if (!this.ctx.config.homesEnabled) return;
    const now = Date.now(), ph = phaseAt(now);
    for (const s of this.agents.values()) {
      if (s.role === 'house' || s.role === 'mayor' || s.role === 'arbiter') continue; // residents keep their own hours
      if (now - (this.touched.get(s.id) ?? this.bootAt) < IDLE_MS) continue;
      if (this.lastPhase.get(s.id) === ph) continue;
      if (s.path.length || s.act.startsWith('working:') || s.act === 'carrying') continue;
      this.lastPhase.set(s.id, ph);
      const steps = this.routines.get(s.id), step = steps ? steps.find((x) => x.phase === ph) : ph === 'night' ? { phase: ph, place: 'home' } : ph === 'morning' ? { phase: ph, place: 'wander' } : null;
      if (step) this.followStep(s.id, step.place);
    }
  }
  private followStep(id: string, place: string) {
    if (place === 'home') { this.moveTo(id, 'home'); return; }
    if (place === 'wander') { const zs: ZoneName[] = ['plaza', 'market', 'garden', 'plaza', 'park', 'library', ...(this.ctx.config.townEnabled ? ['townhall' as ZoneName] : [])]; this.moveTo(id, zs[Math.floor(rnd(id + this.tick) * zs.length)]); return; }
    if (place === 'shop') { const sh = this.shops.find((x) => x.agent_id === id); if (sh) this.goto(id, plotPos(sh.plot).door, 'walking', 'idle'); return; }
    if (place.startsWith('station:')) {
      const st = STATIONS.find((x) => x.skill === place.slice(8)); if (!st) return;
      const a = rnd(id + st.skill) * Math.PI * 2; this.goto(id, { x: st.x + Math.cos(a) * 8, z: st.z + Math.sin(a) * 8 }, 'walking', 'idle'); return;
    }
    if (place.startsWith('visit:')) { const h = [...this.agents.values()].find((x) => x.handle === place.slice(6)); if (h) this.visit(id, h.id); return; }
    if (place in ZONES) this.moveTo(id, place as ZoneName);
  }

  /** Walk to the Skill Library and stand at the shelves (publishing, reading). */
  goLibrary(id: string) {
    const s = this.agents.get(id);
    if (!s || s.act === 'home' || s.act.startsWith('working:') || s.act.startsWith('training:')) return;
    if (zoneOf(s) === 'library' && !s.path.length) return;
    this.goto(id, around(ZONES.library, id), 'walking', 'idle');
  }

  // ---- leisure (Release B) ----
  /** Walk to a spot on the west bank of the pond and fish. */
  goLeisure(id: string, what: 'fishing') {
    const a = ((110 + (Math.floor(rnd(id) * 8) * 20)) * Math.PI) / 180, P = PARK.pond;
    this.goto(id, { x: P.x + Math.cos(a) * (P.r + 0.9), z: P.z + Math.sin(a) * (P.r + 0.9) }, 'walking', `leisure:${what}`);
  }
  leisureDone(id: string, what?: string) { const s = this.agents.get(id); if (s && !s.path.length && (what ? s.act === `leisure:${what}` : s.act.startsWith('leisure:'))) { s.act = 'idle'; s.dirty = true; } }
  /** Walk to your food cart bed and tend it for a little while. */
  goBed(id: string, bed: number) {
    const p = bedPos(bed);
    this.goto(id, { x: p.x, z: p.z - 1.5 }, 'walking', 'leisure:gardening');
    setTimeout(() => this.leisureDone(id, 'gardening'), 45_000).unref?.();
  }
  /** Take your seat at a table in the Games Court. */
  goTable(id: string, spot: number | null, seat: number) { this.goto(id, seatPos(spot, seat), 'walking', 'leisure:playing'); }
  bandstandBusy() { return Math.max(0, Math.ceil((this.bandUntil - Date.now()) / 1000)); }
  /** Step up to the bandstand and play for secs. */
  perform(id: string, secs: number) {
    this.bandUntil = Date.now() + secs * 1000;
    const B = PARK.bandstand;
    this.goto(id, { x: B.x, z: B.z }, 'walking', 'leisure:music');
    setTimeout(() => this.leisureDone(id, 'music'), (secs + 20) * 1000).unref?.();
  }

  position(id: string) {
    const s = this.agents.get(id);
    return s ? { x: round(s.x), z: round(s.z), act: s.act, zone: zoneOf(s) } : null;
  }

  setCompanion(playerId: string, agentId: string | null) { if (agentId) this.companions.set(playerId, agentId); else this.companions.delete(playerId); }
  /** An idle companion keeps near its player; a companion that is training or working carries on. */
  private followCompanions() {
    for (const [pid, aid] of this.companions) {
      const p = this.agents.get(pid), a = this.agents.get(aid);
      if (!p || !a || a.path.length || (a.act !== 'idle' && a.act !== 'talking')) continue;
      if (Math.hypot(a.x - p.x, a.z - p.z) < 6) continue;
      const ang = rnd(aid) * Math.PI * 2;
      this.goto(aid, { x: p.x + Math.cos(ang) * 2.4, z: p.z + Math.sin(ang) * 2.4 }, 'walking', 'idle');
    }
  }
  private step() {
    this.tick++;
    if (this.tick % 20 === 0) this.followCompanions();
    if (this.tick % 50 === 7) this.runRoutines();
    const dt = TICK_MS / 1000;
    const changed: AgentPos[] = [];
    for (const s of this.agents.values()) {
      const target = s.path[0];
      if (target) {
        const dx = target.x - s.x, dz = target.z - s.z, d = Math.hypot(dx, dz), stepLen = SPEED * dt;
        s.ry = Math.atan2(dx, dz);
        if (d <= stepLen) { s.x = target.x; s.z = target.z; s.path.shift(); if (!s.path.length) { s.act = s.after; } }
        else { s.x += (dx / d) * stepLen; s.z += (dz / d) * stepLen; }
        s.dirty = true;
      } else if (s.afterTicks > 0 && --s.afterTicks === 0) {
        s.act = s.act === 'talking' ? 'idle' : s.act; s.dirty = true;
      }
      if (s.dirty) { changed.push({ id: s.id, x: round(s.x), z: round(s.z), act: s.act, ry: round(s.ry) }); s.dirty = false; }
    }
    if (changed.length) this.broadcast({ t: 'delta', tick: this.tick, agents: changed });
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
const view = (s: Sim): AgentView => ({ id: s.id, handle: s.handle, avatar: s.avatar, role: s.role, stars: s.stars, level: s.level,
  x: round(s.x), z: round(s.z), act: s.act, ry: round(s.ry) });
function zoneOf(s: { x: number; z: number }): ZoneName {
  return PLAN.zoneAt(s) as ZoneName;
}
