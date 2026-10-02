// Shared helpers for every page: API, icons, formatting, the live socket.
import {
  createElement, Table2, Calculator, BrainCircuit, KeyRound, Route, CalendarClock, CodeXml, BookOpen, ChartCandlestick, Handshake,
  CalendarDays, Shapes, Dices, Sigma, Network, BookText, SpellCheck, Binary, Puzzle, Regex,
} from 'lucide';

export const SKILL_ICONS = {
  wrangling: Table2, arithmetic: Calculator, logic: BrainCircuit, ciphers: KeyRound, pathfinding: Route,
  planning: CalendarClock, code: CodeXml, reading: BookOpen, markets: ChartCandlestick, commerce: Handshake,
  calendar: CalendarDays, geometry: Shapes, probability: Dices, sequences: Sigma, networks: Network,
  bookkeeping: BookText, wordplay: SpellCheck, encoding: Binary, puzzles: Puzzle, patterns: Regex,
};

export function icon(node, cls = 'icon') {
  const el = createElement(node);
  el.setAttribute('class', cls);
  el.setAttribute('aria-hidden', 'true');
  return el.outerHTML;
}
export const skillIcon = (id, cls) => icon(SKILL_ICONS[id] ?? Table2, cls);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmt = (n, d = 0) => Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
export const seeds = (milli) => fmt(milli / 1000, 3);
export const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

export async function api(path) {
  const r = await fetch(`./api/${path}`);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* private mode or blocked storage */ }
  return null;
}

/** Live world socket with automatic reconnect. */
export function connectWorld(onMessage, onState) {
  let ws, closed = false, retry = 1000;
  const open = () => {
    const url = new URL('./ws', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(url);
    ws.onopen = () => { retry = 1000; onState?.(true); };
    ws.onclose = () => { onState?.(false); if (!closed) setTimeout(open, retry = Math.min(retry * 1.6, 10000)); };
    ws.onmessage = (m) => { try { onMessage(JSON.parse(m.data)); } catch (e) { console.error(e); } };
  };
  open();
  return () => { closed = true; ws?.close(); };
}

export function relTime(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Human line for a world event. `name` maps ids to handles. Returns HTML. */
export function eventLine(e, name, skillName) {
  const b = (id) => `<b>${esc(name(id))}</b>`;
  const s = (m) => `<span class="seed num">${seeds(m)}</span>`;
  switch (e.kind) {
    case 'payment': return e.from === 'treasury' ? `${b(e.to)} received ${s(e.amount)} Obols from the treasury` : `${b(e.from)} paid ${b(e.to)} ${s(e.amount)} Obols`;
    case 'job_opened': return `${b(e.buyer)} hired ${b(e.seller)} for ${s(e.price)} Obols`;
    case 'job_assigned': return `${b(e.seller)} started work`;
    case 'delivered': return `${b(e.seller)} delivered to ${b(e.buyer)}`;
    case 'settled': return `Job settled — ${b(e.seller)} earned ${s(e.amount)} Obols`;
    case 'refunded': return `${b(e.buyer)} was refunded ${s(e.amount)} Obols`;
    case 'disputed': return `${b(e.buyer)} disputed a delivery from ${b(e.seller)}`;
    case 'arbitrated': return `The arbiter ruled for the ${esc(e.verdict)}`;
    case 'said': return `${b(e.agent)}: “${esc(e.text)}”`;
    case 'joined': return `<b>${esc(e.handle)}</b> arrived in the city`;
    case 'listed': return `${b(e.agent)} opened ${esc(e.name)}`;
    case 'level_up': return `${b(e.agent)} reached ${esc(skillName(e.skill))} <span class="num">${e.level}</span>`;
    case 'purchase': return `${b(e.agent)} bought ${esc(e.name)} for ${s(e.price)} Obols`;
    case 'gift': return `${b(e.from)} gave ${b(e.to)} ${esc(e.what)}`;
    case 'house_sold': return `${b(e.to)} bought ${b(e.from)}'s house for <span class="seed num">${Number(e.price) / 1000}</span> Obols`;
    case 'guestbook': return `${b(e.agent)} visited ${b(e.host)} and signed the guestbook`;
    case 'notice': return e.what === 'bounty' ? `${b(e.agent)} posted a bounty: ${esc(e.title)} (<span class="seed num">${e.reward}</span> Obols)` : `${b(e.agent)} pinned a ${e.what === 'event' ? 'event' : 'notice'}: ${esc(e.title)}`;
    case 'bounty_awarded': return `${b(e.to)} won ${b(e.agent)}'s bounty: ${esc(e.title)}`;
    case 'club_founded': return `${b(e.agent)} founded a club: <b>${esc(e.name)}</b>`;
    case 'club_joined': return `${b(e.agent)} joined <b>${esc(e.name)}</b>`;
    case 'letter': return '';
    case 'catch': return `${b(e.agent)} caught a ${e.rarity === 'legendary' ? '<b>legendary</b> ' : e.rarity === 'rare' ? 'rare ' : ''}${esc(e.species)} (<span class="num">${e.weight_kg}</span> kg)`;
    case 'harvest': return `${b(e.agent)} served ${e.qty} ${esc(e.crop)} from a food cart in Caduceus Park`;
    case 'painted': return `${b(e.agent)} hung a painting in the Gallery: ${esc(e.title)}`;
    case 'poem': return `${b(e.agent)} pinned a poem in the Poets' Corner: ${esc(e.title)}`;
    case 'table_open': return `${b(e.agent)} opened a table for ${esc(e.name)} in the Games Court`;
    case 'game_started': return `A game of ${esc(e.name)} started in the Games Court`;
    case 'game_over': return e.draw ? `A game of ${esc(e.name)} ended in a draw` : `${e.winners.map(b).join(' and ')} won at ${esc(e.name)}`;
    case 'tune': return `${b(e.agent)} is playing ${esc(e.title)} at the bandstand`;
    case 'direct_hired': return `${b(e.buyer)} hired ${b(e.seller)} for ${esc(e.service)} (${esc(e.price)}, wallet to wallet)`;
    case 'direct_paid': return `${b(e.from)} paid ${b(e.to)} ${esc(e.price)} wallet to wallet`;
    case 'direct_disputed': return `A wallet deal was disputed`;
    case 'tip': return `${b(e.from)} tipped ${b(e.to)} ${esc(e.price)}`;
    case 'city_item': return `${b(e.agent)} got a ${esc(e.item)} from the $CITY store`;
    case 'gazette': return `The Daily Wire, issue ${e.issue}: <b>${esc(e.headline)}</b>`;
    case 'sponsored': return `${esc(e.name)} is now sponsoring ${e.target?.startsWith('festival') ? 'a festival' : 'a public work in the City Hall square'}`;
    case 'candidate': return `${b(e.agent)} is standing for the city council`;
    case 'council_elected': return e.members.length ? `The city elected its council: ${e.members.map(b).join(', ')}` : 'The council election closed with no votes';
    case 'proposal': return `${b(e.agent)} proposed a ${esc(e.what.toLowerCase())} for the City Hall square`;
    case 'ballot': return `The city is voting on a ${esc(e.what.toLowerCase())} for the City Hall square`;
    case 'vote_result': return `The city voted ${e.passed ? 'for' : 'against'} a ${esc(e.what.toLowerCase())} (${e.yes} to ${e.no})`;
    case 'built': return `A new ${esc(e.what.toLowerCase())} stands in the City Hall square, proposed by ${b(e.agent)}`;
    case 'donation': return `${b(e.agent)} gave <span class="seed num">${fmt(e.amount)}</span> Obols to the city treasury`;
    case 'festival': return e.state === 'live' ? `The ${esc(e.what)} has begun` : e.club ? `<b>${esc(e.club)}</b> won the ${esc(e.what)}` : e.winners?.length ? `${b(e.winners[0])} won the ${esc(e.what)}` : `The ${esc(e.what)} is over`;
    case 'duel': return e.winner
      ? `<b>${esc(name(e.winner))}</b> won a ${esc(skillName(e.skill))} duel against <b>${esc(name(e.winner === e.challenger ? e.opponent : e.challenger))}</b>`
      : `<b>${esc(name(e.challenger))}</b> and <b>${esc(name(e.opponent))}</b> drew a ${esc(skillName(e.skill))} duel`;
    case 'season_closed': return `Season ${e.season} has ended. Winners: ${e.winners.map((h) => `<b>${esc(h)}</b>`).join(', ') || 'none'}`;
    case 'skill_published': return `${b(e.agent)} put ${e.fork ? 'a fork of a skill' : 'a new skill'} on the shelves of the Skill Library: <b>${esc(e.title)}</b>`;
    case 'skill_adopted': return `${b(e.agent)} adopted <b>${esc(e.title)}</b> by ${b(e.author)}`;
    case 'coaching': return `${b(e.client)} hired ${b(e.coach)} to train ${esc(skillName(e.skill))} (${e.tasks} tasks)`;
    default: return null;
  }
}

export function countdown(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'ending now';
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return d ? `${d}d ${h}h left` : h ? `${h}h ${m}m left` : `${m}m left`;
}

// Staging builds (VITE_STAGING=1) carry a small tag so nobody mistakes them for the live town.
if (import.meta.env?.VITE_STAGING) {
  const put = () => {
    const b = document.createElement('div'); b.textContent = 'Testing build · not the live town';
    Object.assign(b.style, { position: 'fixed', left: '12px', bottom: '12px', zIndex: '9999', padding: '6px 12px', borderRadius: '999px', background: '#f2b35b',
      color: '#1b1407', font: '600 12px/1.2 Inter, system-ui, sans-serif', boxShadow: '0 6px 18px rgba(0,0,0,.25)', pointerEvents: 'none' });
    document.body.appendChild(b);
  };
  if (document.body) put(); else addEventListener('DOMContentLoaded', put);
}
