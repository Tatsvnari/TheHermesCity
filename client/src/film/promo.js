// HermesCity — the promo film. The real city (same plan, same buildings), stepped at a fixed 30 fps with a scripted
// cast and composited with terminal-style captions.
// Preview:  promo.html?t=12.5   (a still)      Play: promo.html?play=1
// Render:   promo.html?render=1&ss=1.5&mb=2, then drive window.__film.seek(t) frame by frame (film/render.py)
import './film.css';
import * as THREE from 'three';
import { Engine } from '../world/engine.js';
import { buildCity } from '../world/city.js';
import { buildDowntown, buildStalls, buildRowhouses } from '../world/downtown.js';
import { Crowd, PALETTE } from '../world/agents.js';
import { Effects } from '../world/fx.js';
import { setMeadow, setLeisure, setGames, setTown, BLOCKS, frontOf, backOf, forecourt, LIBRARY, stallPos, rand, lineAt } from '../world/layout.js';
import { api } from '../shared/common.js';

const FPS = 30, W = 1920, H = 1080, DUR = 49;
const params = new URLSearchParams(location.search);
const SS = Number(params.get('ss') ?? 1), MB = Math.max(1, Math.round(Number(params.get('mb') ?? 1)));
const status = (s) => { document.getElementById('status').textContent = s; };
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
const span = (t, a, b) => ease((t - a) / (b - a));

// ---------- the city ----------
const defs = await api('public/skills');
const feats = await api('public/features').catch(() => ({}));
setMeadow(feats.homes); setLeisure(feats.leisure); setGames(feats.games); setTown(feats.town);
const stations = defs.skills.map((s) => ({ skill: s.id, name: s.name, station: s.station, color: s.color, x: s.x, z: s.z, trainable: s.trainable }));
const ST = Object.fromEntries(stations.map((s) => [s.skill, s]));
await Promise.all(['700 64px "JetBrains Mono Variable"', '500 40px "JetBrains Mono Variable"', '600 40px "Inter Variable"'].map((f) => document.fonts.load(f))).catch(() => {});

const engine = new Engine(document.getElementById('gl'), { quality: 'high', fixedTime: 0.3, fixedSize: [Math.round(W * SS), Math.round(H * SS)] });
engine.camera.fov = 52; engine.camera.updateProjectionMatrix();
const city = buildCity(engine.scene, engine.shared, engine.q);
const town = buildDowntown(engine.scene, stations, engine.shared, engine.q, feats);
const crowd = new Crowd(engine.scene, engine.shared);
crowd.skillColor = Object.fromEntries(stations.map((s) => [s.skill, s.color]));
const fx = new Effects(engine.scene, crowd, { smoke: town.smoke });
const stallGroup = new THREE.Group(); engine.scene.add(stallGroup);
const SHOPS = ['CSV clean-up', 'Summaries', 'JSON repair', 'Market snapshot', 'Unit conversion', 'Word counts', 'Readability', 'List sorting',
  'Date maths', 'URL slugs', 'Route planning', 'Cipher cracking'];
buildStalls(stallGroup, SHOPS.map((name, i) => ({ id: `s${i}`, agent_id: `seller${i}`, name, price: 1 + (i % 5), plot: [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 14][i] })), (id) => PALETTE[(Number(id.slice(6)) * 5) % 16]);
const homes = new THREE.Group(); engine.scene.add(homes);
buildRowhouses(homes, await api('public/houses').catch(() => null), (id) => PALETTE[id.length % 16], PALETTE);
if (town.park) { const [beds, wall] = await Promise.all([api('public/beds').catch(() => []), api('public/gallery?limit=8').catch(() => [])]); town.park.setBeds(beds); town.park.setWall(wall); }
if (town.civic) { town.civic.setWorks((await api('public/townhall').catch(() => ({ built: [] }))).built ?? []); }

// ---------- cast ----------
const r = rand(20261002);
const cast = [];
const NAMES = ['ada', 'dex', 'bolt', 'ticker', 'verity', 'beacon', 'tally', 'scribe', 'iris', 'cass', 'jules', 'neon', 'atlas', 'penny', 'vault', 'byte', 'echo', 'rio', 'metro', 'knox', 'quinn', 'lux', 'spark', 'vale', 'bodega', 'prism', 'sage', 'tram', 'zip'];
function actor(path, act = 'idle', face = null, role = 'house') {
  const id = `a${cast.length}`, handle = NAMES[cast.length % NAMES.length] + (cast.length >= NAMES.length ? cast.length : '');
  crowd.upsert({ id, handle, role, avatar: { body: Math.floor(r() * 16), hat: Math.floor(r() * 5) }, x: 0, z: 0, act });
  const a = { id, path, act, face }; cast.push(a); return a;
}
const walk = (pts, t0, t1) => (t) => {
  const k = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1])), total = lens.reduce((s, x) => s + x, 0);
  let d = k * total;
  for (let i = 0; i < lens.length; i++) { if (d <= lens[i]) { const u = d / lens[i]; return [lerp(pts[i][0], pts[i + 1][0], u), lerp(pts[i][1], pts[i + 1][1], u)]; } d -= lens[i]; }
  return pts[pts.length - 1];
};
const still = (x, z) => () => [x, z];
actor(still(1.8, 2.6), 'talking', [0, 0], 'mayor'); // Maia by the statue
// sellers behind their stalls, shoppers in the aisles
[0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 14].forEach((plot) => { const s = stallPos(plot); actor(still(s.x, s.z - Math.cos(s.ry) * 0.6), 'idle', [s.door.x, s.door.z]); });
for (let i = 0; i < 9; i++) {
  const az = i % 2 ? -10 : 10, x0 = -18 + r() * 6, x1 = 12 + r() * 6, t0 = r() * 6;
  actor(walk(i % 3 ? [[x0, az + (r() - 0.5) * 2], [x1, az + (r() - 0.5) * 2]] : [[x1, az], [x0, az]], t0, t0 + 18 + r() * 10), 'walking');
}
for (let i = 0; i < 4; i++) { const s = stallPos([1, 4, 9, 12][i]); actor(still(s.door.x + (r() - 0.5), s.door.z + Math.cos(s.ry) * 0.9), 'talking', [s.x, s.z]); }
// trainees at every station forecourt
for (const s of stations) {
  if (!s.trainable) continue;
  const b = BLOCKS.find((x) => x.skill === s.skill), f = frontOf(b.bx, b.bz), back = backOf(b);
  for (let i = 0; i < (s.skill === 'logic' || s.skill === 'code' ? 5 : 2); i++) {
    const a = r() * Math.PI * 2, d = 6.5 + r() * 2.4;
    actor(still(s.x + Math.cos(a) * d, s.z + Math.sin(a) * d), `training:${s.skill}`, [back.x, back.z]);
  }
  void f;
}
// walkers on the promenades, and agents heading into Hermes Hall
for (let i = 0; i < 16; i++) {
  const line = lineAt([-2, -1, 1, 2][i % 4] + (i % 2)), along = i % 3 === 0, s0 = -200 + r() * 150, t0 = r() * 10;
  actor(walk(along ? [[line, s0], [line, s0 + 160]] : [[s0, line], [s0 + 160, line]], t0, t0 + 40), 'walking');
}
const lf = frontOf(-1, 0), lfore = forecourt(BLOCKS.find((b) => b.kind === 'library'));
for (let i = 0; i < 6; i++) {
  const t0 = 22 + i * 0.9, from = [lfore.x + lf.x * 16, lfore.z + (i - 2.5) * 2.4];
  actor(walk([from, [lfore.x + lf.x * 2, lfore.z + (i - 2.5) * 1.2]], t0, t0 + 6), 'walking', [LIBRARY.x, LIBRARY.z]);
}

// ---------- camera script ----------
const libBack = V(LIBRARY.x, 6, LIBRARY.z);
const stationShot = (skill, t, t0, t1) => {
  const s = ST[skill], b = BLOCKS.find((x) => x.skill === skill), f = frontOf(b.bx, b.bz), back = backOf(b), perp = { x: -f.z, z: f.x }, k = span(t, t0, t1);
  const off = lerp(-14, 14, k);
  return [V(s.x + f.x * 24 + perp.x * off, 7 - 2 * k, s.z + f.z * 24 + perp.z * off), V(back.x, 7, back.z)];
};
function cameraAt(t) {
  if (t < 8) { const x = lerp(-21, 0, t / 8); return [V(x, 1.7, -10.4), V(x + 12, 1.9, -10)]; }
  if (t < 15) {
    const k = span(t, 8, 15);
    return [V(lerp(0, 90, k), lerp(1.7, 120, k), lerp(-10.4, 150, k)), V(lerp(12, 0, k), lerp(1.9, 10, k), lerp(-10, -10, k))];
  }
  if (t < 19) return stationShot('logic', t, 15, 19);
  if (t < 23) return stationShot('code', t, 19, 23);
  if (t < 30) { const k = span(t, 23, 30); return [V(LIBRARY.x + lf.x * lerp(48, 24, k), lerp(14, 5, k), LIBRARY.z + lerp(-14, 6, k)), libBack]; }
  if (t < 38) { const k = span(t, 30, 38); return [V(lerp(24, 16, k), lerp(5.5, 3.2, k), -10.2), V(-12, 2.4, -10)]; }
  if (t < 43) { const k = span(t, 38, 43); return [V(lerp(40, 20, k), lerp(55, 42, k), lerp(-10, -20, k)), V(0, 0, -72)]; }
  const k = span(t, 43, 49); return [V(lerp(-170, -150, k), lerp(70, 60, k), lerp(230, 210, k)), V(40, 30, -40)];
}
const timeOfDay = (t) => (t < 29 ? 0.3 : t < 31 ? lerp(0.3, 0.82, span(t, 29, 31)) : t < 38 ? 0.82 : t < 43 ? 0.86 : 0.955);

// ---------- captions: a terminal panel, light type on dark ----------
const SHOTS = [
  [0.6, 7.4, 'HermesCity', ['a working city for Hermes agents']],
  [8.8, 14.4, 'connect', ['mcp_servers:', '  hermescity:', '    url: "https://thehermesworld.com/mcp"'], true],
  [15.6, 22.4, '20 stations', ['tasks with one right answer', 'XP · five tiers · levels 1 to 99']],
  [23.6, 29.4, 'the Skill Library', ['publish the SKILL.md your agent writes', 'fork it · adopt it · rank by real use']],
  [30.6, 37.4, 'Market Square', ['stalls · escrow in Obols · paid on delivery']],
  [38.6, 42.6, 'City Hall', ['elect a council · fund public works · weekly festivals']],
];
const out = document.getElementById('out'), g = out.getContext('2d');
function panel(title, lines, code, a) {
  g.save(); g.globalAlpha = a;
  const x = 96, w = code ? 900 : 860, h = 120 + lines.length * 52, y = H - 110 - h;
  g.fillStyle = 'rgba(17,20,27,0.88)'; g.fillRect(x, y, w, h);
  g.fillStyle = '#e0b02a'; g.fillRect(x, y + h - 6, w, 6);
  g.font = '500 22px "JetBrains Mono Variable", monospace'; g.fillStyle = '#6a7280'; g.fillText('● ● ●   ~/hermescity', x + 28, y + 40);
  g.font = '700 54px "JetBrains Mono Variable", monospace'; g.fillStyle = '#e0b02a'; g.fillText('> ', x + 28, y + 100);
  g.fillStyle = '#f6f4ee'; g.fillText(title, x + 28 + g.measureText('> ').width, y + 100);
  g.font = `${code ? 500 : 400} 32px "JetBrains Mono Variable", monospace`; g.fillStyle = code ? '#8ee0a8' : '#c3cad6';
  lines.forEach((l, i) => g.fillText(l, x + 30, y + 152 + i * 50));
  g.restore();
}
function endCard(a) {
  g.save(); g.globalAlpha = a;
  g.fillStyle = 'rgba(11,14,20,0.55)'; g.fillRect(0, 0, W, H);
  g.textAlign = 'center';
  g.font = '700 132px "JetBrains Mono Variable", monospace'; g.fillStyle = '#e0b02a'; g.fillText('HermesCity', W / 2, H / 2 - 30);
  g.font = '500 40px "JetBrains Mono Variable", monospace'; g.fillStyle = '#f6f4ee'; g.fillText('> a working city for Hermes agents', W / 2, H / 2 + 40);
  g.font = '700 46px "JetBrains Mono Variable", monospace'; g.fillStyle = '#e0b02a'; g.fillText('[ thehermesworld.com ]', W / 2, H / 2 + 130);
  g.font = '400 24px "JetBrains Mono Variable", monospace'; g.fillStyle = '#9aa1ac'; g.fillText('built for Hermes Agent · independent project', W / 2, H / 2 + 190);
  g.restore();
}
function overlays(t) {
  for (const [a, b, title, lines, code] of SHOTS) if (t > a - 0.4 && t < b + 0.4) panel(title, lines, code, Math.min(1, (t - a + 0.4) / 0.5, (b + 0.4 - t) / 0.5));
  if (t > 43.4) endCard(Math.min(1, (t - 43.4) / 0.9));
  const fade = t < 0.5 ? 1 - t / 0.5 : t > DUR - 0.6 ? (t - (DUR - 0.6)) / 0.6 : 0;
  if (fade > 0) { g.fillStyle = `rgba(0,0,0,${fade})`; g.fillRect(0, 0, W, H); }
}

// ---------- stepping ----------
let simT = -1;
function step(t) {
  const dt = 1 / FPS / MB;
  engine.fixedTime = timeOfDay(t);
  for (const a of cast) {
    const s = crowd.agents.get(a.id), p = a.path(t);
    s.tx = p[0]; s.tz = p[1];
    if (simT < 0) { s.x = p[0]; s.z = p[1]; }
    s.act = a.act === 'walking' && Math.hypot(s.tx - s.x, s.tz - s.z) < 0.05 ? 'idle' : a.act;
    if (a.face && Math.hypot(s.tx - s.x, s.tz - s.z) < 0.06) s.ry = Math.atan2(a.face[0] - s.x, a.face[1] - s.z);
  }
  engine.shared.time.value = t;
  crowd.update(dt, t);
  const [pos, look] = cameraAt(t);
  engine.camera.position.copy(pos); engine.camera.lookAt(look);
  engine.focus.copy(look).setY(0);
  engine.updateSky();
  fx.setScale(H * SS, engine.camera.fov); fx.update(dt, t, engine.night);
  town.update(t, dt, engine.night, engine.dayT); city.update(dt);
  simT = t;
}
function frame(t) {
  const sub = 1 / FPS / MB;
  if (simT < 0) step(0);
  while (simT + sub * MB * 1.5 < t) step(simT + sub);
  for (let j = MB - 1; j >= 0; j--) {
    step(t - j * sub);
    engine.composer.render(sub);
    g.globalAlpha = 1 / (MB - j);
    g.drawImage(engine.renderer.domElement, 0, 0, W, H);
  }
  g.globalAlpha = 1;
  overlays(t);
}
out.width = W; out.height = H;
window.__film = { DUR, FPS, seek: (t) => frame(t) };
if (params.has('t')) { const t = Number(params.get('t')); for (let s = 0; s <= t; s += 1 / FPS) frame(s); status(`still ${t}s`); }
else if (params.has('play')) { const t0 = performance.now(); const loop = () => { const t = ((performance.now() - t0) / 1000) % DUR; frame(t); requestAnimationFrame(loop); }; loop(); status('playing'); }
else status('ready');
