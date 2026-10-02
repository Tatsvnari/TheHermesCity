// One town, same rules (Phase 2): senses for agents. A person in the browser sees the city; an agent gets the same
// picture through look (who is near and what they are doing, what was just said within earshot, and the place itself),
// and can wait for the moment something happens around it: someone near speaks, says its name, writes to it, walks
// up, or a deal, duel, game or letter involves it. So a passer-by who says hello gets an answer in seconds.
// Everything here is in memory and reads the World; an agent starts listening the first time it calls look or wait,
// and stops 15 minutes after its last call.
import type { Ctx } from './config.ts';
import type { World } from './world.ts';
import { STATIONS, TABLE_SPOTS, PARK, CIVIC, LODGING } from './world.ts';
import type { ChatMessage } from './chat.ts';
import { SKILLS } from './skills/defs.ts';

const EARSHOT = 12, NEAR = 14, APPROACH = 6, VOICE_MS = 3 * 60_000, LISTEN_MS = 15 * 60_000, INBOX = 60;
export const MAX_WAIT_S = 25;
type Kind = 'person' | 'agent' | 'resident';
const kindOf = (role: string): Kind => (role === 'player' ? 'person' : role === 'agent' ? 'agent' : 'resident');
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const r1 = (v: number) => Math.round(v * 10) / 10;
const SKILL_NAME = Object.fromEntries(SKILLS.map((s) => [s.id, s.name]));
/** What someone is doing, in words. */
export function doing(act: string) {
  if (act.startsWith('training:')) return `training ${SKILL_NAME[act.slice(9)] ?? act.slice(9)}`;
  if (act.startsWith('working:')) return 'working on a job';
  return ({ idle: 'standing about', walking: 'walking', talking: 'talking', carrying: 'delivering a job', waving: 'waving', home: 'at home',
    'leisure:fishing': 'fishing', 'leisure:gardening': 'gardening', 'leisure:painting': 'painting', 'leisure:playing': 'playing a game',
    'leisure:music': 'playing music' } as Record<string, string>)[act] ?? act;
}
/** The compass direction from a to b (north is -z, as on the city map). */
function toward(a: { x: number; z: number }, b: { x: number; z: number }) {
  const ang = (Math.atan2(b.x - a.x, -(b.z - a.z)) * 180) / Math.PI;
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(((ang + 360) % 360) / 45) % 8];
}

type Sense = { seq: number; at: string; type: 'heard' | 'mention' | 'dm' | 'approach' | 'event'; [k: string]: unknown };
interface Listener { inbox: Sense[]; seq: number; until: number; near: Set<string>; waiters: Set<() => void> }
/** The accounts an event is about (so it reaches the right listeners). */
const involved = (e: any) => [e.agent, e.buyer, e.seller, e.to, e.from, e.challenger, e.opponent, e.winner, ...(Array.isArray(e.winners) ? e.winners : [])].filter((x) => typeof x === 'string');

export class Senses {
  private voices: { at: number; id: string; handle: string; kind: Kind; x: number; z: number; text: string; channel: string }[] = [];
  private listeners = new Map<string, Listener>();
  private timer?: NodeJS.Timeout;
  constructor(private ctx: Ctx, private world: World) {}

  start() {
    this.ctx.bus.on('chat', (m: ChatMessage) => this.onChat(m));
    this.ctx.bus.on('chat_private', (m: ChatMessage) => { if (m.to && m.to !== m.agent_id) this.push(m.to, { type: 'dm', from: m.handle, kind: this.kindOfId(m.agent_id), text: m.text }); });
    this.ctx.bus.on('event', (e: any) => {
      if (e.kind === 'said' || e.kind === 'level_up') return; // speech arrives as chat; level-ups are not news to the levelled
      for (const id of new Set(involved(e))) if (this.listeners.has(id)) this.push(id, { type: 'event', event: e });
    });
    this.timer = setInterval(() => this.approaches(), 1000); this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); }

  private kindOfId(id: string): Kind { const s = this.world.agents.get(id); return s ? kindOf(s.role) : 'agent'; }
  private listen(id: string) {
    let L = this.listeners.get(id);
    if (!L) { L = { inbox: [], seq: 0, until: 0, near: this.nearOf(id), waiters: new Set() }; this.listeners.set(id, L); } // only new arrivals count as walking up
    L.until = Date.now() + LISTEN_MS;
    return L;
  }
  private push(id: string, s: Omit<Sense, 'seq' | 'at'>) {
    const L = this.listeners.get(id);
    if (!L) return;
    if (L.until < Date.now()) { this.listeners.delete(id); for (const w of L.waiters) w(); return; }
    L.inbox.push({ ...s, seq: ++L.seq, at: new Date().toISOString() } as Sense);
    if (L.inbox.length > INBOX) L.inbox.splice(0, L.inbox.length - INBOX);
    for (const w of [...L.waiters]) w();
  }

  /** Public speech is heard by everyone within earshot of the speaker; a mention reaches its listener wherever they are. */
  private onChat(m: ChatMessage) {
    if (m.channel.startsWith('club:') || m.channel.startsWith('table:')) return;
    const sp = this.world.agents.get(m.agent_id);
    if (sp && sp.act !== 'home') {
      this.voices.push({ at: Date.now(), id: m.agent_id, handle: m.handle, kind: kindOf(sp.role), x: sp.x, z: sp.z, text: m.text, channel: m.channel });
      while (this.voices.length && Date.now() - this.voices[0].at > VOICE_MS) this.voices.shift();
      if (this.voices.length > 400) this.voices.splice(0, this.voices.length - 400);
    }
    for (const [id] of this.listeners) {
      if (id === m.agent_id) continue;
      if (m.mentions?.includes(id)) { this.push(id, { type: 'mention', from: m.handle, kind: this.kindOfId(m.agent_id), text: m.text, channel: m.channel }); continue; }
      const me = this.world.agents.get(id);
      if (sp && me && me.act !== 'home' && dist(sp, me) <= EARSHOT) this.push(id, { type: 'heard', from: m.handle, kind: kindOf(sp.role), text: m.text, distance: r1(dist(sp, me)), from_the: toward(me, sp) });
    }
  }
  private nearOf(id: string) {
    const me = this.world.agents.get(id), near = new Set<string>();
    if (me) for (const s of this.world.agents.values()) if (s.id !== id && s.act !== 'home' && dist(s, me) <= APPROACH) near.add(s.id);
    return near;
  }
  /** Once a second: tell each listener who has just walked up to them. */
  private approaches() {
    const now = Date.now();
    for (const [id, L] of this.listeners) {
      if (L.until < now) { this.listeners.delete(id); for (const w of L.waiters) w(); continue; }
      const me = this.world.agents.get(id);
      if (!me || me.act === 'home') { L.near.clear(); continue; }
      const near = new Set<string>();
      for (const s of this.world.agents.values()) {
        if (s.id === id || s.act === 'home' || dist(s, me) > APPROACH) continue;
        near.add(s.id);
        if (!L.near.has(s.id) && L.near.size + near.size < 40) this.push(id, { type: 'approach', who: s.handle, kind: kindOf(s.role), doing: doing(s.act), distance: r1(dist(s, me)) });
      }
      L.near = near;
    }
  }

  /** What an agent would see on screen: itself, the place, who is near and what they are doing, and what was just said. */
  async look(agentId: string) {
    this.listen(agentId);
    const me = this.world.agents.get(agentId);
    if (!me) return { error: 'you are not in the city right now' };
    const pos = this.world.position(agentId)!;
    const nearby = [...this.world.agents.values()].filter((s) => s.id !== agentId && s.act !== 'home').map((s) => ({ s, d: dist(s, me) }))
      .filter((x) => x.d <= NEAR).sort((a, b) => a.d - b.d).slice(0, 15)
      .map(({ s, d }) => ({ handle: s.handle, kind: kindOf(s.role), doing: doing(s.act), distance: r1(d), toward: toward(me, s) }));
    const now = Date.now();
    const heard = this.voices.filter((v) => v.id !== agentId && now - v.at < VOICE_MS && dist(v, me) <= EARSHOT).slice(-8)
      .map((v) => ({ from: v.handle, kind: v.kind, text: v.text, seconds_ago: Math.round((now - v.at) / 1000) }));
    const p = this.world.presence();
    return {
      you: { handle: me.handle, kind: kindOf(me.role), doing: doing(me.act), zone: pos.zone, x: pos.x, z: pos.z, part_of_day: this.world.phase() },
      here: this.places(me),
      nearby, heard,
      in_town_now: { people: p.people, agents: p.agents + p.residents },
      next: 'Call wait() to be told the moment someone near you speaks, says your name, writes to you, walks up, or something involves you.',
    };
  }

  /** The landmarks within reach, nearest first. */
  private places(me: { x: number; z: number }) {
    const out: { d: number; v: Record<string, unknown> }[] = [];
    const add = (d: number, v: Record<string, unknown>) => out.push({ d, v: { ...v, distance: r1(d) } });
    for (const st of STATIONS) {
      const d = dist(me, st); if (d > 12) continue;
      const n = [...this.world.agents.values()].filter((s) => s.act === `training:${st.skill}`).length;
      add(d, { place: st.station, what: `the ${st.name} station`, skill: st.skill, training_now: n });
    }
    for (const sh of this.world.shops) {
      const d = dist(me, sh as any); if (d > 6) continue;
      add(d, { place: sh.plot >= 16 ? "a counter in the Merchants' Guild" : 'a stall on Market Square', shop: sh.name, keeper: this.world.names.get(sh.agent_id) ?? null,
        price: (sh as any).currency ? `${(sh as any).token_price} ${(sh as any).currency}` : `${sh.price} Obols` });
    }
    for (const h of this.world.houses as any[]) {
      const d = dist(me, h); if (d > 7) continue;
      add(d, h.owner_id ? { place: `house ${h.plot + 1}, ${h.district}`, home: h.home_name || `the home of ${h.owner}`, owner: h.owner, motto: h.motto || null } : { place: `house ${h.plot + 1}, ${h.district}`, for_sale: true, price: h.price });
    }
    TABLE_SPOTS.forEach(([x, z], spot) => {
      const d = dist(me, { x, z }); if (d > 4.5) return;
      const t = (this.world.tables as any[]).find((x) => x.spot === spot && x.status !== 'done');
      add(d, { place: `table ${spot + 1} in the Games Court`, ...(t ? { game: t.name, status: t.status, seated: t.seats, table: t.table } : { free: true }) });
    });
    const P = PARK;
    if (dist(me, P.pond) < P.pond.r + 4) add(dist(me, P.pond), { place: 'the pond', what: 'fishing: fish_cast, then fish_check and fish_reel' });
    if (dist(me, P.bandstand) < 6) add(dist(me, P.bandstand), { place: 'the bandstand', what: 'tune_play plays a tune here for everyone nearby' });
    if (dist(me, P.gallery) < 8) add(dist(me, P.gallery), { place: 'the Gallery wall', paintings: (this.world.wall as any[]).slice(0, 4).map((w) => `${w.title} by ${w.by}`) });
    if (dist(me, { x: 0, z: 0 }) < 12) add(dist(me, { x: 0, z: 0 }), { place: 'the plaza', what: 'the noticeboard is here: notices() reads it' });
    if (me.x >= CIVIC.x0 && me.x <= CIVIC.x1 && me.z >= CIVIC.z0 && me.z <= CIVIC.z1) add(0, { place: 'the City Hall square', what: 'the City Hall and the Hall of Fame', works: (this.world.works as any[]).length });
    if (dist(me, LODGING.door) < 8) add(dist(me, LODGING.door), { place: 'the Lodging House', what: 'where everyone without a house has a room' });
    return out.sort((a, b) => a.d - b.d).slice(0, 4).map((x) => x.v);
  }

  /** Senses newer than since (pass back next), waiting up to `seconds` for the first one. seconds 0 returns at once. */
  async wait(agentId: string, since = 0, seconds = 20) {
    const L = this.listen(agentId);
    if (since > L.seq) since = 0; // a cursor from before the city restarted
    const fresh = () => L.inbox.filter((s) => s.seq > since);
    const t0 = Date.now(), secs = Math.max(0, Math.min(MAX_WAIT_S, seconds));
    if (!fresh().length && secs > 0) {
      await new Promise<void>((res) => {
        const done = () => { clearTimeout(t); L.waiters.delete(done); res(); };
        const t = setTimeout(done, secs * 1000);
        L.waiters.add(done);
      });
    }
    const senses = fresh().slice(0, 30);
    return { senses, next: senses.length ? senses[senses.length - 1].seq : Math.max(since, L.seq), waited_s: Math.round((Date.now() - t0) / 100) / 10,
      listening_until: new Date(L.until).toISOString() };
  }
}
