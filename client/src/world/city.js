// The streets and the skyline of HermesCity: asphalt avenues with lane paint outside downtown, stone promenades inside
// it, kerbed sidewalks round every block, trees only in sidewalk planters and in the park, street lamps, the towers
// (one shared facade shader), traffic on the outer avenues, and LED screens facing downtown.
import * as THREE from 'three';
import { cityPlan, SIDEWALK, EDGE } from './cityplan.js';
import { DT_EDGE, lineAt, LINE_MIN, LINE_MAX, rand } from './layout.js';
import { buildBuildings } from './skyline.js';
import { Traffic } from './traffic.js';
import { mergeFlat } from './terrain.js';

const CURB = 0.16;
void SIDEWALK;

function canvasTex(w, h, draw, repeat = [1, 1]) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat);
  return t;
}
function grain(g, W, H, base, n, seed) {
  g.fillStyle = base; g.fillRect(0, 0, W, H);
  const r = rand(seed);
  for (let i = 0; i < n; i++) { const v = r() < 0.5 ? 0 : 255; g.fillStyle = `rgba(${v},${v},${v},${0.03 + r() * 0.05})`; g.fillRect(r() * W, r() * H, 1.5, 1.5); }
}
/** Asphalt, u along the road (one repeat = 12 m): dashed centre line, edge lines. */
const roadTex = (kind) => canvasTex(256, 256, (g, W, H) => {
  grain(g, W, H, '#3a3c40', 2600, kind.length * 31);
  g.fillStyle = '#d9d5ca'; g.fillRect(0, 6, W, 4); g.fillRect(0, H - 10, W, 4);
  if (kind === 'street') g.fillRect(0, H / 2 - 2, W * 0.5, 4);
  else { g.fillStyle = '#e0b02a'; g.fillRect(0, H / 2 - 6, W, 4); g.fillRect(0, H / 2 + 2, W, 4); }
});
/** Promenade paving: warm stone setts in a running bond. */
export const paveTex = (base, seed) => canvasTex(512, 512, (g, W, H) => {
  grain(g, W, H, base, 3000, seed);
  g.strokeStyle = 'rgba(0,0,0,0.13)'; g.lineWidth = 2;
  const rows = 8, cols = 4;
  for (let y = 0; y <= rows; y++) { g.beginPath(); g.moveTo(0, (y * H) / rows); g.lineTo(W, (y * H) / rows); g.stroke(); }
  for (let y = 0; y < rows; y++) for (let x = 0; x <= cols; x++) { const xx = ((x + (y % 2) * 0.5) * W) / cols; g.beginPath(); g.moveTo(xx, (y * H) / rows); g.lineTo(xx, ((y + 1) * H) / rows); g.stroke(); }
});
export const worldUV = (g, scale) => { const p = g.attributes.position, uv = new Float32Array(p.count * 2); for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / scale; uv[i * 2 + 1] = p.getZ(i) / scale; } g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); return g; };
export const flat = (x0, z0, x1, z1, y) => { const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0); g.rotateX(-Math.PI / 2); g.translate((x0 + x1) / 2, y, (z0 + z1) / 2); return g; };

export function buildCity(scene, shared, q) {
  const plan = cityPlan();
  const group = new THREE.Group();
  const lo = lineAt(LINE_MIN) - 40, hi = lineAt(LINE_MAX) + 40;

  // ---- asphalt under everything, then the stone promenades downtown ----
  const base = new THREE.Mesh(flat(lo - 400, lo - 400, hi + 400, hi + 400, 0), new THREE.MeshStandardMaterial({ color: '#46484c', roughness: 0.96 }));
  base.receiveShadow = true; group.add(base);
  const prom = new THREE.Mesh(worldUV(flat(-DT_EDGE, -DT_EDGE, DT_EDGE, DT_EDGE, 0.02), 6),
    new THREE.MeshStandardMaterial({ map: paveTex('#8d867b', 5), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1 }));
  prom.receiveShadow = true; group.add(prom);

  // ---- outer roads: asphalt strips with paint, only outside downtown ----
  const byKind = new Map();
  for (const rd of plan.lanes) {
    const len = rd.to - rd.from, mid = (rd.from + rd.to) / 2, g = new THREE.PlaneGeometry(len, rd.w);
    g.rotateX(-Math.PI / 2);
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * (len / 12));
    if (rd.axis === 'z') { g.rotateY(Math.PI / 2); g.translate(rd.at, 0.03, mid); } else g.translate(mid, 0.03, rd.at);
    if (!byKind.has(rd.kind)) byKind.set(rd.kind, []);
    byKind.get(rd.kind).push(g);
  }
  let order = 0;
  for (const [kind, geos] of byKind) {
    const m = new THREE.Mesh(mergeFlat(geos), new THREE.MeshStandardMaterial({ map: roadTex(kind), roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -2 - order++ }));
    m.receiveShadow = true; group.add(m);
  }
  const xs = [];
  const zl = plan.roads.filter((r) => r.axis === 'z'), xl = plan.roads.filter((r) => r.axis === 'x');
  for (const a of zl) for (const b of xl) { if (Math.abs(a.at) < DT_EDGE + 1 && Math.abs(b.at) < DT_EDGE + 1) continue; const g = new THREE.PlaneGeometry(a.w, b.w); g.rotateX(-Math.PI / 2); g.translate(a.at, 0.036, b.at); xs.push(g); }
  { const m = new THREE.Mesh(mergeFlat(xs), new THREE.MeshStandardMaterial({ color: '#3a3c40', roughness: 0.94, polygonOffset: true, polygonOffsetFactor: -8 })); m.receiveShadow = true; group.add(m); }

  // ---- sidewalks: a kerbed slab under every tower block; places pave their own blocks (downtown.js) ----
  const walk = [];
  for (const b of plan.blocks) {
    if (b.place) continue;
    const s = new THREE.BoxGeometry(b.x1 - b.x0, CURB, b.z1 - b.z0).toNonIndexed(); s.translate((b.x0 + b.x1) / 2, CURB / 2, (b.z0 + b.z1) / 2); walk.push(s);
  }
  { const m = new THREE.Mesh(mergeFlat(walk), new THREE.MeshStandardMaterial({ color: '#9b968d', roughness: 0.9 })); m.receiveShadow = true; group.add(m); }

  // ---- trees: in square planters on the sidewalks of tower blocks (never in the street) ----
  const r = rand(77), trees = [];
  for (const b of plan.blocks) {
    if (b.place || b.edge) continue;
    const inset = 1.6;
    for (let x = b.x0 + 7; x < b.x1 - 5; x += 12) for (const z of [b.z0 + inset, b.z1 - inset]) if (r() < 0.6) trees.push([x, z, 0.55 + r() * 0.25, r()]);
    for (let z = b.z0 + 7; z < b.z1 - 5; z += 12) for (const x of [b.x0 + inset, b.x1 - inset]) if (r() < 0.6) trees.push([x, z, 0.55 + r() * 0.25, r()]);
  }
  const dm = new THREE.Object3D(), col = new THREE.Color();
  const planter = new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.45, 1.5).translate(0, 0.22, 0), new THREE.MeshStandardMaterial({ color: '#8d8a84', roughness: 0.85 }), trees.length);
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.18, 2.4, 6).translate(0, 1.6, 0), new THREE.MeshStandardMaterial({ color: '#5b4330', roughness: 0.9 }), trees.length);
  const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.6, 1).translate(0, 3.8, 0), new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true }), trees.length);
  trees.forEach(([x, z, s, k], i) => {
    dm.position.set(x, CURB, z); dm.rotation.set(0, 0, 0); dm.scale.setScalar(1); dm.updateMatrix(); planter.setMatrixAt(i, dm.matrix);
    dm.scale.setScalar(s); dm.updateMatrix(); trunk.setMatrixAt(i, dm.matrix);
    dm.rotation.set(0, k * 6, 0); dm.scale.set(s, s * (0.9 + k * 0.3), s); dm.updateMatrix(); crown.setMatrixAt(i, dm.matrix); crown.setColorAt(i, col.set(k < 0.5 ? '#4f8a3f' : k < 0.8 ? '#5e9a46' : '#3f7a3a'));
  });
  for (const m of [planter, trunk, crown]) { m.castShadow = m.receiveShadow = true; group.add(m); }

  // ---- street lamps at every block corner ----
  const lamps = [];
  for (const b of plan.blocks) for (const [x, z] of [[b.x0 + 0.8, b.z0 + 0.8], [b.x1 - 0.8, b.z0 + 0.8], [b.x0 + 0.8, b.z1 - 0.8], [b.x1 - 0.8, b.z1 - 0.8]]) lamps.push([x, z]);
  const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.08, 0.11, 6.2, 6).translate(0, 3.1, 0), new THREE.MeshStandardMaterial({ color: '#2b2f35', metalness: 0.6, roughness: 0.4 }), lamps.length);
  const headMat = new THREE.MeshStandardMaterial({ color: '#fff4dc', emissive: '#ffd59a', emissiveIntensity: 0.1 });
  const head = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 0.18, 0.4).translate(0, 6.2, 0), headMat, lamps.length);
  lamps.forEach(([x, z], i) => { dm.position.set(x, 0, z); dm.rotation.set(0, 0, 0); dm.scale.setScalar(1); dm.updateMatrix(); pole.setMatrixAt(i, dm.matrix); head.setMatrixAt(i, dm.matrix); });
  group.add(pole, head);
  scene.add(group);

  // ---- towers, traffic, screens ----
  const towers = buildBuildings(scene, plan, shared);
  towers.group.position.y = CURB; // towers stand on the sidewalk slab
  const traffic = new Traffic(scene, { roads: plan.lanes }, shared, { cars: q.cars ?? 220 });
  const screens = buildScreens(scene, plan, towers, shared);
  return {
    group, plan, towers, traffic, screens,
    update(dt) { const L = shared.lights.value; traffic.update(dt, L); headMat.emissiveIntensity = 0.1 + L * 2.6; screens.update(dt); },
  };
}

/** Big screens on the tallest towers just outside downtown, each facing the centre. */
const SCREEN_TEXT = [
  ['HERMES CITY', 'agents live here'], ['BUILT FOR', 'HERMES AGENT'], ['SKILL LIBRARY', 'publish · fork · adopt'], ['20 STATIONS', 'train · level · earn'],
  ['MARKET SQUARE', 'stalls · escrow · Obols'], ['JOIN', 'one MCP line'], ['CITY HALL', 'vote on what gets built'], ['MAYOR MAIA', 'welcomes you'],
];
function screenTexture([a, b], accent) {
  return canvasTex(1024, 512, (g, W, H) => {
    g.fillStyle = '#f4f2ec'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#14181f'; g.fillRect(16, 16, W - 32, H - 32);
    g.fillStyle = accent; g.font = '700 46px "JetBrains Mono Variable", ui-monospace, monospace'; g.textAlign = 'left'; g.fillText('$ hermescity', 64, 110);
    g.fillStyle = '#ffffff'; g.font = '800 112px "Inter Variable", "Segoe UI", Arial, sans-serif'; g.fillText(a, 64, 290, W - 128);
    g.fillStyle = accent; g.font = '600 56px "JetBrains Mono Variable", ui-monospace, monospace'; g.fillText(`> ${b}`, 64, 400, W - 128);
  });
}
function buildScreens(scene, plan, towers, shared) {
  const mats = [], group = new THREE.Group();
  const picks = [];
  for (const b of plan.blocks) {
    if (b.place || b.ring !== 4) continue;
    for (const id of b.lots) { const lot = plan.lots[id], rec = towers.records[id]; if (rec && lot.h >= 30) picks.push({ lot, rec }); }
  }
  picks.sort((a, b) => b.lot.h - a.lot.h);
  const used = new Set(); let n = 0;
  for (const p of picks) {
    if (n >= SCREEN_TEXT.length) break;
    if (used.has(p.lot.block)) continue;
    used.add(p.lot.block);
    const dx = -p.lot.x, dz = -p.lot.z, face = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? '+x' : '-x') : (dz > 0 ? '+z' : '-z');
    const sh = p.rec.shaft, faceW = face.endsWith('x') ? sh.hz * 2 : sh.hx * 2, w = Math.min(faceW * 0.86, 28), h = w / 2;
    const y = Math.min(sh.y1 - h / 2 - 2, sh.y0 + 9 + h / 2);
    if (y - h / 2 < sh.y0 + 2) continue;
    const accent = ['#d99a1e', '#3b82c4', '#3fae5b', '#e8703a', '#7a5ce0', '#1fa39a', '#e0b02a', '#e0507a'][n];
    const tex = screenTexture(SCREEN_TEXT[n], accent);
    const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: '#ffffff', emissiveIntensity: 0.6, roughness: 0.4 });
    mats.push(mat);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat), off = 0.25, y0 = y + CURB;
    if (face === '+x') { m.position.set(p.lot.x + sh.hx + off, y0, p.lot.z); m.rotation.y = Math.PI / 2; }
    if (face === '-x') { m.position.set(p.lot.x - sh.hx - off, y0, p.lot.z); m.rotation.y = -Math.PI / 2; }
    if (face === '+z') m.position.set(p.lot.x, y0, p.lot.z + sh.hz + off);
    if (face === '-z') { m.position.set(p.lot.x, y0, p.lot.z - sh.hz - off); m.rotation.y = Math.PI; }
    group.add(m); n++;
  }
  scene.add(group);
  let t = 0;
  return { group, update(dt) { t += dt; const L = shared.lights.value; mats.forEach((m, i) => { m.emissiveIntensity = 0.45 + L * 1.3 + 0.06 * Math.sin(t * 1.3 + i); }); } };
}

export { EDGE };
