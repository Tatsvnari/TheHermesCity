// Architecture. Static geometry is merged per material (few draw calls); moving parts stay separate.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PLAZA, WORKSHOP, BANK, STATION_PAD, rand, plotPos, HOUSE_PLOTS, isOuter } from './layout.js';
import { waterMaterial } from './nature.js';

const std = (color, roughness = 0.85, metalness = 0, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

export const MAT = {
  plaster: std('#efe6d6', 0.92), plaster2: std('#e4d6bf', 0.92), plaster3: std('#e9ddd0', 0.92),
  stone: std('#bcb4a6', 0.95), stoneDark: std('#8f897e', 0.95), marble: std('#e8e4dc', 0.6),
  wood: std('#7a5a40', 0.85), woodDark: std('#54402f', 0.85),
  roofRed: std('#b0573a', 0.78), roofSlate: std('#4d5a6e', 0.72), roofSage: std('#6d8a6c', 0.8), roofPlum: std('#76587a', 0.78),
  roofOchre: std('#bf8f3e', 0.78), roofTeal: std('#3e7b78', 0.78), roofCoral: std('#c4694f', 0.78),
  metal: std('#3a3f47', 0.45, 0.6), gold: std('#d7ae4a', 0.32, 0.85), hedge: std('#3f6e3a', 0.95, 0, { flatShading: true }),
  window: new THREE.MeshStandardMaterial({ color: '#27303e', roughness: 0.25, metalness: 0.2, emissive: '#ffb45e', emissiveIntensity: 0 }),
  lamp: new THREE.MeshStandardMaterial({ color: '#fff3d6', roughness: 0.4, emissive: '#ffc778', emissiveIntensity: 0.2 }),
  ember: new THREE.MeshStandardMaterial({ color: '#ff7a2e', emissive: '#ff6a1a', emissiveIntensity: 2.5, roughness: 0.6 }),
};

class Kit {
  constructor() { this.buckets = new Map(); }
  add(mat, geo, m) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.applyMatrix4(m);
    if (!this.buckets.has(mat)) this.buckets.set(mat, []);
    this.buckets.get(mat).push(g);
  }
  build() {
    const group = new THREE.Group();
    for (const [mat, geos] of this.buckets) {
      const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
      mesh.castShadow = mat !== MAT.window && mat !== MAT.lamp;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }
}

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
/** A placement frame: all coordinates are local to (x, z, ry). */
class At {
  constructor(kit, x, z, ry = 0, y = 0) { this.kit = kit; this.base = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(1, 1, 1)); }
  m(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    return this.base.clone().multiply(new THREE.Matrix4().compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz)));
  }
  box(mat, w, h, d, x, y, z, ry = 0) { this.kit.add(mat, new THREE.BoxGeometry(w, h, d), this.m(x, y + h / 2, z, 0, ry)); }
  cyl(mat, rt, rb, h, seg, x, y, z) { this.kit.add(mat, new THREE.CylinderGeometry(rt, rb, h, seg), this.m(x, y + h / 2, z)); }
  cone(mat, r, h, seg, x, y, z, ry = 0) { this.kit.add(mat, new THREE.ConeGeometry(r, h, seg), this.m(x, y + h / 2, z, 0, ry)); }
  sphere(mat, r, x, y, z, half = false, sy = 1) { this.kit.add(mat, new THREE.SphereGeometry(r, 28, 14, 0, Math.PI * 2, 0, half ? Math.PI / 2 : Math.PI), this.m(x, y, z, 0, 0, 0, 1, sy, 1)); }
  torus(mat, r, tube, x, y, z, rx = Math.PI / 2) { this.kit.add(mat, new THREE.TorusGeometry(r, tube, 8, 40), this.m(x, y, z, rx)); }
  geo(mat, g, x, y, z, rx = 0, ry = 0, rz = 0) { this.kit.add(mat, g, this.m(x, y, z, rx, ry, rz)); }
  /** Gable roof along local x. */
  gable(mat, w, d, h, y, overhang = 0.4) {
    const W = w + overhang * 2, D = d + overhang * 2;
    const shape = new THREE.Shape([new THREE.Vector2(-D / 2, 0), new THREE.Vector2(D / 2, 0), new THREE.Vector2(0, h)]);
    const g = new THREE.ExtrudeGeometry(shape, { depth: W, bevelEnabled: false });
    g.translate(0, 0, -W / 2); g.rotateY(Math.PI / 2);
    this.kit.add(mat, g, this.m(0, y, 0));
    // eave boards give the roof some thickness
    this.box(mat, W, 0.16, 0.25, 0, y - 0.1, D / 2 - 0.1); this.box(mat, W, 0.16, 0.25, 0, y - 0.1, -D / 2 + 0.1);
  }
  hip(mat, w, d, h, y, overhang = 0.4) {
    const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1); g.rotateY(Math.PI / 4);
    this.kit.add(mat, g, this.m(0, y + h / 2, 0, 0, 0, 0, w + overhang * 2, h, d + overhang * 2));
  }
  windows(face, w, h, y0, floors, spacing = 2.3, tall = 1.15) {
    // face: 'front' (+z), 'back' (-z), 'left' (-x), 'right' (+x); w = width of that face, h = distance from centre
    const n = Math.max(1, Math.floor((w - 1) / spacing));
    for (let f = 0; f < floors; f++) for (let i = 0; i < n; i++) {
      const o = (i - (n - 1) / 2) * spacing, y = y0 + f * 2.7;
      const place = (dx, dz, ry) => {
        this.geo(MAT.window, new THREE.BoxGeometry(0.85, tall, 0.1), dx, y + tall / 2, dz, 0, ry);
        this.geo(MAT.stone, new THREE.BoxGeometry(1.05, 0.12, 0.26), dx + (ry ? 0 : 0), y - 0.06, dz, 0, ry);
      };
      if (face === 'front') place(o, h + 0.03, 0);
      if (face === 'back') place(o, -h - 0.03, 0);
      if (face === 'left') place(-h - 0.03, o, Math.PI / 2);
      if (face === 'right') place(h + 0.03, o, Math.PI / 2);
    }
  }
  door(w, d, x = 0) {
    this.box(MAT.woodDark, 1.15, 2.05, 0.14, x, 0.4, d / 2 + 0.02);
    this.box(MAT.stone, 1.55, 0.22, 0.3, x, 2.45, d / 2 + 0.05);
    this.box(MAT.stone, 1.7, 0.18, 0.9, x, 0, d / 2 + 0.4);
  }
}

// ---------- building types ----------

function house(kit, x, z, ry, o) {
  const a = new At(kit, x, z, ry);
  const { w, d, h, wall = MAT.plaster, roof = MAT.roofRed, floors = Math.max(1, Math.round((h - 0.4) / 2.7)), timber = false, chimney = true } = o;
  a.box(MAT.stoneDark, w + 0.3, 0.45, d + 0.3, 0, 0, 0);
  a.box(wall, w, h, d, 0, 0.4, 0);
  if (timber) {
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) a.box(MAT.wood, 0.24, h, 0.24, sx * (w / 2), 0.4, sz * (d / 2));
    if (floors > 1) { a.box(MAT.wood, w + 0.1, 0.2, 0.1, 0, 0.4 + h * 0.5, d / 2 + 0.03); a.box(MAT.wood, w + 0.1, 0.2, 0.1, 0, 0.4 + h * 0.5, -d / 2 - 0.03); }
  }
  a.windows('front', w, d / 2, 1.25, floors); a.windows('back', w, d / 2, 1.25, floors);
  if (d > 4.5) { a.windows('left', d, w / 2, 1.25, floors); a.windows('right', d, w / 2, 1.25, floors); }
  a.door(w, d, w > 6 ? -w / 4 : 0);
  a.gable(roof, w, d, Math.min(w, d) * 0.42 + 0.6, h + 0.4);
  if (chimney) a.box(MAT.stone, 0.7, 2.2, 0.7, w * 0.28, h + 0.4, -d * 0.18);
}

function lampPost(kit, x, z) {
  const a = new At(kit, x, z);
  a.cyl(MAT.metal, 0.07, 0.11, 3.4, 8, 0, 0, 0);
  a.cyl(MAT.metal, 0.22, 0.26, 0.3, 8, 0, 0, 0);
  a.box(MAT.lamp, 0.36, 0.5, 0.36, 0, 3.35, 0);
  a.cone(MAT.metal, 0.34, 0.32, 4, 0, 3.85, 0, Math.PI / 4);
}

function bench(kit, x, z, ry) {
  const a = new At(kit, x, z, ry);
  a.box(MAT.wood, 2, 0.1, 0.55, 0, 0.45, 0); a.box(MAT.wood, 2, 0.5, 0.1, 0, 0.55, -0.26);
  for (const sx of [-0.85, 0.85]) a.box(MAT.metal, 0.08, 0.45, 0.5, sx, 0, 0);
}

function crates(kit, x, z, r) {
  const a = new At(kit, x, z, r() * 6);
  a.box(MAT.wood, 0.7, 0.7, 0.7, 0, 0, 0); a.box(MAT.wood, 0.55, 0.55, 0.55, 0.75, 0, 0.1, 0.4); a.box(MAT.woodDark, 0.5, 0.5, 0.5, 0.2, 0.7, 0.05, 0.3);
}

// ---------- signs (canvas text, crisp and plain) ----------
export function signTexture(lines, { w = 1024, h = 256, bg = '#233a32', fg = '#f3ead6', accent = '#d7ae4a' } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (bg === 'gold') { const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#f8de8e'); gr.addColorStop(0.5, '#d8a53a'); gr.addColorStop(1, '#f2cc66'); g.fillStyle = gr; } // the $CITY store's gold sign
  else g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = accent; g.globalAlpha = 0.55; g.lineWidth = 3; g.strokeRect(14, 14, w - 28, h - 28); g.globalAlpha = 1;
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = fg;
  const [a, b] = lines;
  g.font = `600 ${b ? 84 : 96}px "Fraunces Variable", Georgia, serif`;
  let size = b ? 84 : 96; while (g.measureText(a).width > w - 80 && size > 30) { size -= 4; g.font = `600 ${size}px "Fraunces Variable", Georgia, serif`; }
  g.fillText(a, w / 2, b ? h * 0.4 : h / 2);
  if (b) { g.font = '500 44px "Inter Variable", system-ui, sans-serif'; g.fillStyle = accent; g.fillText(b, w / 2, h * 0.76); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
function signMesh(lines, width, opts) {
  const tex = signTexture(lines, opts);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 4), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }));
  m.castShadow = true;
  return m;
}

// ---------- stations ----------

function stationRing(group, s) {
  const mat = new THREE.MeshStandardMaterial({ color: s.color, emissive: s.color, emissiveIntensity: 0.25, roughness: 0.5, transparent: true, opacity: 0.9, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
  const ring = new THREE.Mesh(new THREE.RingGeometry(STATION_PAD - 1.55, STATION_PAD - 1.25, 96).rotateX(-Math.PI / 2), mat);
  ring.position.set(s.x, 0.06, s.z); group.add(ring);
  return mat;
}

function faceToPlaza(s) { return Math.atan2(-s.x, -s.z); }

const STATION_BUILDERS = {
  wrangling(kit, s, anim, group) { // The Data Mill: a windmill
    const ry = faceToPlaza(s), a = new At(kit, s.x, s.z, ry);
    a.cyl(MAT.stoneDark, 3.6, 3.8, 0.6, 16, 0, 0, 0);
    a.cyl(MAT.plaster2, 2.3, 3.2, 8.4, 16, 0, 0.5, 0);
    for (const y of [2.8, 5.6]) a.cyl(MAT.stone, 2.3 + (8.4 - y) * 0.108 + 0.05, 2.3 + (8.4 - y) * 0.108 + 0.08, 0.25, 16, 0, y, 0);
    a.cone(MAT.roofTeal, 2.9, 2.8, 16, 0, 8.9, 0);
    a.door(4, 6.6); a.windows('front', 1.4, 2.75, 4.6, 1); a.windows('back', 1.4, 2.75, 4.6, 1);
    for (let i = 0; i < 4; i++) a.box(MAT.wood, 0.9, 0.8, 0.9, -3 + i * 0.35, 0, 3.2 + (i % 2) * 0.6, i);
    const hub = new THREE.Group();
    hub.position.set(s.x + Math.sin(ry) * 2.75, 8.2, s.z + Math.cos(ry) * 2.75); hub.rotation.y = ry;
    const blades = new THREE.Group(); hub.add(blades);
    const sail = new THREE.MeshStandardMaterial({ color: '#f1e9d8', roughness: 0.9, side: THREE.DoubleSide });
    blades.add(new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.6, 12).rotateX(Math.PI / 2), MAT.woodDark));
    for (let i = 0; i < 4; i++) {
      const arm = new THREE.Group(); arm.rotation.z = (i * Math.PI) / 2;
      const spar = new THREE.Mesh(new THREE.BoxGeometry(0.22, 6.2, 0.14), MAT.wood); spar.position.y = 3.1;
      const cloth = new THREE.Mesh(new THREE.BoxGeometry(1.3, 4.9, 0.04), sail); cloth.position.set(0.72, 3.5, 0.05);
      for (let k = 0; k < 5; k++) { const rib = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.06, 0.08), MAT.wood); rib.position.set(0.72, 1.3 + k * 1.1, 0.08); arm.add(rib); }
      arm.add(spar, cloth); blades.add(arm);
    }
    blades.traverse((o) => { o.castShadow = true; });
    group.add(hub);
    anim.push((t) => { blades.rotation.z = -t * 0.55; });
  },

  arithmetic(kit, s) { // The Counting House: a small temple of numbers
    const a = new At(kit, s.x, s.z, faceToPlaza(s));
    for (let i = 0; i < 3; i++) a.box(MAT.marble, 10.4 - i * 0.6, 0.3, 8.4 - i * 0.6, 0, i * 0.3, 0.3 - i * 0.1);
    a.box(MAT.plaster2, 8, 5, 5, 0, 0.9, -1.2);
    for (let i = 0; i < 6; i++) a.cyl(MAT.marble, 0.3, 0.36, 4.6, 14, -3.5 + i * 1.4, 0.9, 2.4);
    a.box(MAT.marble, 9, 0.7, 7.4, 0, 5.5, 0.2);
    a.gable(MAT.roofSlate, 9, 7.2, 1.9, 6.2, 0.2);
    a.cyl(MAT.gold, 0.75, 0.75, 0.14, 32, 0, 6.8, 3.9);
    a.box(MAT.woodDark, 1.4, 2.6, 0.1, 0, 0.9, 1.35);
    a.windows('left', 5, 4, 2, 1); a.windows('right', 5, 4, 2, 1);
  },

  logic(kit, s, anim, group) { // The Logic Tower and its floating orb
    const a = new At(kit, s.x, s.z, faceToPlaza(s));
    a.cyl(MAT.stoneDark, 3.3, 3.5, 0.8, 8, 0, 0, 0);
    a.cyl(MAT.plaster3, 2.1, 2.7, 14, 8, 0, 0.7, 0);
    for (const y of [4, 8, 12]) a.cyl(MAT.stone, 2.1 + (14.7 - y) * 0.043 + 0.12, 2.1 + (14.7 - y) * 0.043 + 0.15, 0.3, 8, 0, y, 0);
    a.cyl(MAT.stone, 2.7, 2.4, 1, 8, 0, 14.6, 0);
    for (let i = 0; i < 8; i++) { const ang = (i / 8) * Math.PI * 2; a.box(MAT.stone, 0.7, 0.8, 0.5, Math.cos(ang) * 2.45, 15.6, Math.sin(ang) * 2.45, -ang); }
    for (let i = 0; i < 5; i++) { const ang = i * 1.3, y = 2.5 + i * 2.4; a.geo(MAT.window, new THREE.BoxGeometry(0.5, 1.2, 0.1), Math.sin(ang) * (2.62 - y * 0.035), y, Math.cos(ang) * (2.62 - y * 0.035), 0, ang); }
    a.door(4, 5.7);
    const orbMat = new THREE.MeshStandardMaterial({ color: s.color, emissive: s.color, emissiveIntensity: 1.6, roughness: 0.2 });
    const orb = new THREE.Group(); orb.position.set(s.x, 19.6, s.z);
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.05, 3), orbMat);
    const ringMat = new THREE.MeshStandardMaterial({ color: '#e9e2ff', emissive: s.color, emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.4 });
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(1.8, 0.06, 8, 64), ringMat), r2 = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.05, 8, 64), ringMat);
    orb.add(core, r1, r2); group.add(orb);
    anim.push((t, night) => {
      orb.position.y = 19.6 + Math.sin(t * 0.9) * 0.35;
      r1.rotation.set(t * 0.6, t * 0.4, 0); r2.rotation.set(-t * 0.35, 0, t * 0.5);
      orbMat.emissiveIntensity = 1.2 + night * 1.8 + Math.sin(t * 2) * 0.2;
    });
  },

  ciphers(kit, s, anim, group) { // The Cipher Vault and its turning dial
    const ry = faceToPlaza(s), a = new At(kit, s.x, s.z, ry);
    a.cyl(MAT.stoneDark, 4.6, 4.8, 0.6, 24, 0, 0, 0);
    a.cyl(MAT.stone, 4.1, 4.3, 5, 24, 0, 0.5, 0);
    for (let i = 0; i < 12; i++) { const ang = (i / 12) * Math.PI * 2; a.box(MAT.stoneDark, 0.55, 5, 0.35, Math.cos(ang) * 4.25, 0.5, Math.sin(ang) * 4.25, -ang); }
    a.sphere(MAT.roofSlate, 4.2, 0, 5.5, 0, true, 0.62);
    a.cyl(MAT.gold, 0.25, 0.4, 0.8, 8, 0, 8.05, 0);
    a.box(MAT.metal, 2, 3, 0.3, 0, 0.5, 4.36);
    const glow = new THREE.MeshStandardMaterial({ color: s.color, emissive: s.color, emissiveIntensity: 0.8, roughness: 0.4 });
    const band = new THREE.Mesh(new THREE.TorusGeometry(4.18, 0.07, 6, 96).rotateX(Math.PI / 2), glow); band.position.set(s.x, 5.45, s.z); group.add(band);
    const dial = new THREE.Group();
    dial.position.set(s.x + Math.sin(ry) * 4.45, 4.1, s.z + Math.cos(ry) * 4.45); dial.rotation.y = ry;
    const face = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 0.18, 40).rotateX(Math.PI / 2), MAT.gold);
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.24, 6).rotateX(Math.PI / 2), MAT.metal);
    dial.add(face, inner);
    for (let i = 0; i < 26; i++) { const tick = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 0.06), MAT.metal); const ang = (i / 26) * Math.PI * 2; tick.position.set(Math.cos(ang) * 1.05, Math.sin(ang) * 1.05, 0.12); tick.rotation.z = ang; dial.add(tick); }
    group.add(dial);
    anim.push((t, night) => { dial.rotation.z = Math.floor(t * 0.6) * ((2 * Math.PI) / 26) + Math.min(1, (t * 0.6) % 1 * 4) * ((2 * Math.PI) / 26); glow.emissiveIntensity = 0.5 + night * 1.6; });
  },

  pathfinding(kit, s) { // The Hedge Maze
    const N = 7, CELL = 1.8, half = (N * CELL) / 2, a = new At(kit, s.x, s.z, faceToPlaza(s));
    const r = rand(77), walls = [];
    // carve a perfect maze
    const seen = Array.from({ length: N }, () => Array(N).fill(false)), open = new Set();
    const stack = [[0, 0]]; seen[0][0] = true;
    while (stack.length) {
      const [x, y] = stack[stack.length - 1];
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [x + dx, y + dy]).filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < N && ny < N && !seen[ny][nx]);
      if (!nb.length) { stack.pop(); continue; }
      const [nx, ny] = nb[Math.floor(r() * nb.length)]; seen[ny][nx] = true; open.add(`${x},${y}|${nx},${ny}`); open.add(`${nx},${ny}|${x},${y}`); stack.push([nx, ny]);
    }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (x < N - 1 && !open.has(`${x},${y}|${x + 1},${y}`)) walls.push([(x + 1) * CELL - half, (y + 0.5) * CELL - half, 0.5, CELL + 0.5]);
      if (y < N - 1 && !open.has(`${x},${y}|${x},${y + 1}`)) walls.push([(x + 0.5) * CELL - half, (y + 1) * CELL - half, CELL + 0.5, 0.5]);
    }
    for (let i = 0; i < N; i++) {
      if (i !== Math.floor(N / 2)) walls.push([(i + 0.5) * CELL - half, half, CELL + 0.5, 0.6]); // front, with a gap
      walls.push([(i + 0.5) * CELL - half, -half, CELL + 0.5, 0.6]);
      walls.push([-half, (i + 0.5) * CELL - half, 0.6, CELL + 0.5]); walls.push([half, (i + 0.5) * CELL - half, 0.6, CELL + 0.5]);
    }
    const hedgeGeo = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2);
    for (const [x, z, w, d] of walls) a.kit.add(MAT.hedge, hedgeGeo, a.m(x, 0.85, z, 0, 0, 0, w, 1.7, d));
    a.cyl(MAT.stone, 0.6, 0.8, 0.5, 8, 0, 0, 0); a.cyl(MAT.marble, 0.18, 0.32, 3, 4, 0, 0.5, 0); a.cone(MAT.gold, 0.28, 0.6, 4, 0, 3.5, 0);
    // arch at the entrance
    for (const sx of [-1.1, 1.1]) a.box(MAT.wood, 0.25, 2.8, 0.25, sx, 0, half + 0.3);
    a.box(MAT.wood, 2.6, 0.25, 0.4, 0, 2.8, half + 0.3);
  },

  planning(kit, s, anim, group) { // The Planners' Hall and its clock
    const ry = faceToPlaza(s), a = new At(kit, s.x, s.z, ry);
    a.box(MAT.stoneDark, 12.3, 0.45, 6.3, -1, 0, -0.5);
    a.box(MAT.plaster, 12, 4.6, 6, -1, 0.4, -0.5);
    a.windows('front', 12, 2.5, 1.5, 1, 2.2, 1.9); a.windows('back', 12, 3.5, 1.5, 1, 2.2, 1.9);
    a.door(12, 5);
    const hall = new At(kit, s.x, s.z, ry); hall.base.multiply(new THREE.Matrix4().makeTranslation(-1, 0, -0.5));
    hall.gable(MAT.roofCoral, 12, 6, 2.6, 5);
    a.box(MAT.stone, 3, 11, 3, 5.8, 0, -0.5);
    const top = new At(kit, s.x, s.z, ry); top.base.multiply(new THREE.Matrix4().makeTranslation(5.8, 0, -0.5));
    top.hip(MAT.roofCoral, 3, 3, 2.6, 11);
    const clockTex = signTexture([''], { w: 256, h: 256, bg: '#f4ecd9', fg: '#222', accent: '#222' });
    const c = clockTex.image.getContext('2d'); c.clearRect(0, 0, 256, 256); c.fillStyle = '#f4ecd9'; c.beginPath(); c.arc(128, 128, 124, 0, 7); c.fill();
    c.fillStyle = '#28303a'; for (let i = 0; i < 12; i++) { c.save(); c.translate(128, 128); c.rotate((i / 12) * Math.PI * 2); c.fillRect(-4, -116, 8, i % 3 ? 16 : 28); c.restore(); }
    clockTex.needsUpdate = true;
    const hands = [];
    for (const side of [1, -1]) {
      const clock = new THREE.Group();
      const off = new THREE.Vector3(5.8, 9, -0.5 + side * 1.53).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
      clock.position.set(s.x + off.x, off.y, s.z + off.z); clock.rotation.y = ry + (side < 0 ? Math.PI : 0);
      clock.add(new THREE.Mesh(new THREE.CircleGeometry(1.15, 40), new THREE.MeshStandardMaterial({ map: clockTex, roughness: 0.6 })));
      const hr = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.6, 0.04).translate(0, 0.28, 0.03), MAT.metal);
      const mn = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.9, 0.04).translate(0, 0.42, 0.05), MAT.metal);
      clock.add(hr, mn); hands.push([hr, mn]); group.add(clock);
    }
    anim.push((t, night, phase) => { for (const [hr, mn] of hands) { hr.rotation.z = -phase * Math.PI * 4; mn.rotation.z = -phase * Math.PI * 48; } });
  },

  code(kit, s, anim, group) { // The Forge
    const ry = faceToPlaza(s), a = new At(kit, s.x, s.z, ry);
    a.box(MAT.stoneDark, 8.4, 0.45, 6.4, 0, 0, -0.5);
    a.box(MAT.stone, 8, 3.6, 0.5, 0, 0.4, -3.5); a.box(MAT.stone, 0.5, 3.6, 6, -3.8, 0.4, -0.5); a.box(MAT.stone, 0.5, 3.6, 6, 3.8, 0.4, -0.5);
    for (const sx of [-3.8, 3.8]) a.box(MAT.wood, 0.4, 3.6, 0.4, sx, 0.4, 2.4);
    const roof = new At(kit, s.x, s.z, ry); roof.base.multiply(new THREE.Matrix4().makeTranslation(0, 0, -0.5));
    roof.gable(MAT.roofSlate, 8, 6, 2.2, 4, 0.5);
    a.box(MAT.stoneDark, 2.6, 1.3, 2, -1.6, 0.4, -2.2); // hearth
    a.box(MAT.ember, 1.8, 0.35, 1.3, -1.6, 1.7, -2.1);
    a.box(MAT.stone, 1.5, 9.5, 1.5, -1.6, 0.4, -3.3); // chimney
    a.box(MAT.metal, 0.5, 0.8, 0.5, 1.5, 0.4, 0.8); a.box(MAT.metal, 1.4, 0.35, 0.55, 1.5, 1.2, 0.8); // anvil
    a.box(MAT.woodDark, 2.5, 0.9, 1, 2, 0.4, -2.4); // workbench
    const light = new THREE.PointLight('#ff8a3c', 0, 14, 1.6);
    const lp = new THREE.Vector3(-1.6, 2.4, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    light.position.set(s.x + lp.x, lp.y, s.z + lp.z); group.add(light);
    const cp = new THREE.Vector3(-1.6, 10.2, -3.3).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    group.userData.smoke = [...(group.userData.smoke ?? []), { x: s.x + cp.x, y: cp.y, z: s.z + cp.z }];
    anim.push((t, night) => {
      const flick = 0.8 + Math.sin(t * 13) * 0.1 + Math.sin(t * 7.3) * 0.1;
      MAT.ember.emissiveIntensity = 2 * flick + night;
      light.intensity = (6 + night * 20) * flick;
    });
  },

  reading(kit, s) { // The Library
    const a = new At(kit, s.x, s.z, faceToPlaza(s));
    a.box(MAT.stoneDark, 10.5, 0.5, 8.5, 0, 0, 0);
    a.box(MAT.plaster2, 10, 5.5, 8, 0, 0.45, 0);
    a.windows('front', 10, 4, 1.6, 1, 2.3, 2.6); a.windows('left', 8, 5, 1.6, 1, 2.3, 2.6); a.windows('right', 8, 5, 1.6, 1, 2.3, 2.6);
    a.box(MAT.marble, 10.4, 0.5, 8.4, 0, 5.9, 0);
    a.cyl(MAT.plaster3, 3.2, 3.2, 1.6, 24, 0, 6.3, 0);
    a.sphere(MAT.roofPlum, 3.3, 0, 7.9, 0, true);
    a.cyl(MAT.gold, 0.2, 0.35, 1, 8, 0, 11.1, 0);
    for (const sx of [-1.6, 1.6]) a.cyl(MAT.marble, 0.3, 0.34, 5.4, 14, sx, 0.45, 4.6);
    a.box(MAT.marble, 4.2, 0.5, 1.6, 0, 5.85, 4.4);
    a.door(10, 8);
  },

  markets(kit, s, anim, group) { // The Exchange with its ticker board
    const ry = faceToPlaza(s), a = new At(kit, s.x, s.z, ry);
    a.box(MAT.stoneDark, 11.5, 0.5, 7.5, 0, 0, 0);
    a.box(MAT.stone, 11, 6.5, 7, 0, 0.45, 0);
    a.box(MAT.marble, 11.8, 0.6, 7.8, 0, 6.9, 0);
    for (let i = 0; i < 4; i++) a.cyl(MAT.marble, 0.34, 0.38, 5.6, 14, -3.9 + i * 2.6, 0.45, 4.1);
    a.box(MAT.marble, 10.6, 0.5, 1.4, 0, 6.05, 4.1);
    a.windows('left', 7, 5.5, 1.8, 2); a.windows('right', 7, 5.5, 1.8, 2);
    a.door(11, 7);
    const board = document.createElement('canvas'); board.width = 1024; board.height = 256;
    const tex = new THREE.CanvasTexture(board); tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: '#ffffff', emissiveIntensity: 0.55, roughness: 0.4 });
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 2.1), mat);
    const off = new THREE.Vector3(0, 4.6, 3.56).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    panel.position.set(s.x + off.x, off.y, s.z + off.z); panel.rotation.y = ry; group.add(panel);
    const syms = ['SEED', 'LNTN', 'ORCH', 'BRDG', 'CPPR', 'MDOW', 'HRBR', 'QRTZ'];
    const px = syms.map((_, i) => 40 + i * 13.7);
    let last = -1;
    anim.push((t, night) => {
      mat.emissiveIntensity = 0.45 + night * 0.9;
      const step = Math.floor(t * 2); if (step === last) return; last = step;
      const g = board.getContext('2d');
      g.fillStyle = '#0b1418'; g.fillRect(0, 0, 1024, 256);
      g.font = '600 46px "JetBrains Mono Variable", monospace'; g.textBaseline = 'middle';
      const shift = (t * 90) % 1024;
      syms.forEach((sym, i) => {
        px[i] *= 1 + (Math.sin(t * 0.7 + i * 1.7) * 0.0009);
        const ch = Math.sin(t * 0.21 + i) * 3.2;
        const x = ((i * 260 - shift) % 2080 + 2080) % 2080 - 260;
        g.fillStyle = '#e8eef2'; g.fillText(sym, x, 80);
        g.fillStyle = ch >= 0 ? '#5fd08f' : '#f0786a'; g.fillText(`${px[i].toFixed(2)} ${ch >= 0 ? '▲' : '▼'}${Math.abs(ch).toFixed(1)}%`, x, 170);
      });
      tex.needsUpdate = true;
    });
  },

  commerce(kit, s, anim, group) { // The Merchants' Guild at the end of Market Square
    const a = new At(kit, s.x, s.z, -Math.PI / 2);
    a.box(MAT.stoneDark, 13, 0.6, 11, 0, 0, 0);
    a.box(MAT.plaster2, 12, 7, 10, 0, 0.55, 0);
    a.windows('front', 12, 5, 1.8, 2, 2.4, 1.6); a.windows('left', 10, 6, 1.8, 2, 2.4, 1.6); a.windows('right', 10, 6, 1.8, 2, 2.4, 1.6);
    a.box(MAT.woodDark, 2.4, 3.4, 0.15, 0, 0.55, 5.05);
    a.box(MAT.stone, 3.2, 0.4, 0.5, 0, 3.95, 5.1);
    a.hip(MAT.roofOchre, 12, 10, 4.2, 7.55, 0.5);
    for (const sx of [-4.2, 4.2]) { a.box(MAT.metal, 0.08, 3, 0.08, sx, 4.2, 5.4); }
    const vane = new THREE.Group(); vane.position.set(s.x, 12.2, s.z);
    vane.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6), MAT.gold));
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.4, 4).rotateZ(-Math.PI / 2), MAT.gold); arrow.position.y = 0.6; vane.add(arrow);
    group.add(vane);
    const colours = ['#4fb3a9', '#e0a340', '#8f7ae5', '#5b8def', '#58b368', '#d9745b', '#e86a4a', '#c98ad6', '#3fb5d8'];
    colours.forEach((c, i) => { // skill banners along the facade
      const b = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.5), new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, side: THREE.DoubleSide }));
      b.position.set(s.x - 5.08, 6.75, s.z - 4 + i); b.rotation.y = -Math.PI / 2; b.castShadow = true; group.add(b);
    });
    anim.push((t) => { vane.rotation.y = Math.sin(t * 0.15) * 1.2 + Math.sin(t * 0.43) * 0.3; });
  },
};

// ---------- the outer ring (extra skills) ----------
const UP = new THREE.Vector3(0, 1, 0);
/** Put a moving object at a local offset of station s (frame rotated by ry). */
function placeAt(group, s, obj, lx, y, lz, ry) {
  const v = new THREE.Vector3(lx, 0, lz).applyAxisAngle(UP, ry);
  obj.position.set(s.x + v.x, y, s.z + v.z); obj.rotation.y = ry;
  obj.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  group.add(obj); return obj;
}
const glowMat = (color, k = 1.2) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: k, roughness: 0.35 });

Object.assign(STATION_BUILDERS, {
  calendar(kit, s) { // The Sundial Court: a great dial, its gnomon and a colonnade
    const a = new At(kit, s.x, s.z, faceToPlaza(s)), acc = std(s.color, 0.6);
    a.cyl(MAT.stoneDark, 6.4, 6.6, 0.45, 48, 0, 0, 0);
    a.cyl(MAT.marble, 5.2, 5.3, 0.3, 48, 0, 0.45, 0);
    a.torus(acc, 5.25, 0.09, 0, 0.78, 0);
    for (let i = 0; i < 12; i++) { const ang = (i / 12) * Math.PI * 2; a.box(i % 3 ? MAT.stoneDark : MAT.gold, 0.22, 0.08, i % 3 ? 0.7 : 1.1, Math.sin(ang) * 4.4, 0.75, Math.cos(ang) * 4.4, ang); }
    const tri = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(3.6, 0), new THREE.Vector2(0, 3.1)]);
    a.geo(MAT.gold, new THREE.ExtrudeGeometry(tri, { depth: 0.22, bevelEnabled: false }).translate(-1.8, 0, -0.11), 0, 0.75, 0, 0, Math.PI / 2);
    for (let i = 0; i < 7; i++) { // colonnade on the far side
      const ang = Math.PI * 0.72 + (i / 6) * Math.PI * 0.56, x = Math.sin(ang) * 7.4, z = Math.cos(ang) * 7.4;
      a.cyl(MAT.marble, 0.28, 0.32, 3.6, 12, x, 0, z); a.box(MAT.marble, 0.8, 0.25, 0.8, x, 3.6, z);
      if (i < 6) { const b2 = Math.PI * 0.72 + ((i + 0.5) / 6) * Math.PI * 0.56; a.box(MAT.marble, 2.1, 0.45, 0.6, Math.sin(b2) * 7.4, 3.85, Math.cos(b2) * 7.4, b2 + Math.PI / 2); }
    }
  },

  geometry(kit, s, anim, group) { // The Survey Office and its turning octahedron
    const ry = faceToPlaza(s), a = new At(kit, s.x, s.z, ry);
    a.box(MAT.stoneDark, 8.4, 0.4, 6.2, 0, 0, -1.5);
    a.box(MAT.plaster2, 8, 4.6, 5.8, 0, 0.4, -1.5);
    const roof = new At(kit, s.x, s.z, ry); roof.base.multiply(new THREE.Matrix4().makeTranslation(0, 0, -1.5)); roof.hip(MAT.roofSlate, 8, 5.8, 2.4, 5);
    a.windows('front', 8, 1.4, 1.6, 1); a.door(8, 2.9);
    a.box(MAT.stone, 5.6, 0.5, 2.4, 0, 0, 4.2); // plinth of solids
    a.cone(MAT.marble, 0.95, 1.6, 4, -1.8, 0.5, 4.2, Math.PI / 4);
    a.box(MAT.gold, 1.1, 1.1, 1.1, 0, 0.5, 4.2, 0.5);
    a.geo(MAT.marble, new THREE.DodecahedronGeometry(0.72), 1.8, 1.22, 4.2);
    const oct = new THREE.Mesh(new THREE.OctahedronGeometry(1.2), glowMat(s.color, 1.1));
    placeAt(group, s, oct, 0, 9.6, -1.5, ry);
    anim.push((t, night) => { oct.rotation.set(t * 0.5, t * 0.7, 0); oct.position.y = 9.6 + Math.sin(t * 1.1) * 0.3; oct.material.emissiveIntensity = 0.9 + night * 1.6; });
  },

  probability(kit, s, anim, group) { // The Dice Hall and its tumbling die
    const ry = faceToPlaza(s), a = new At(kit, s.x, s.z, ry);
    a.box(MAT.stoneDark, 10.4, 0.45, 7.4, 0, 0, -1);
    a.box(MAT.plaster, 10, 4.8, 7, 0, 0.4, -1);
    const roof = new At(kit, s.x, s.z, ry); roof.base.multiply(new THREE.Matrix4().makeTranslation(0, 0, -1)); roof.gable(MAT.roofRed, 10, 7, 2.6, 5.2);
    a.windows('front', 10, 2.5, 1.7, 1); a.door(10, 5);
    const die = (size, pipMat) => {
      const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BoxGeometry(size, size, size), std('#f6f2ea', 0.5)));
      const P = { 1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]] };
      const faces = [[1, [0, 0, 1]], [6, [0, 0, -1]], [2, [1, 0, 0]], [5, [-1, 0, 0]], [3, [0, 1, 0]], [4, [0, -1, 0]]];
      const pip = new THREE.SphereGeometry(size * 0.085, 10, 8), h = size / 2, o = size * 0.27;
      for (const [n, [nx, ny, nz]] of faces) for (const [u, v] of P[n]) {
        const m = new THREE.Mesh(pip, pipMat);
        if (nz) m.position.set(u * o, v * o, nz * h); else if (nx) m.position.set(nx * h, v * o, u * o); else m.position.set(u * o, ny * h, v * o);
        g.add(m);
      }
      return g;
    };
    const pipMat = std('#1f2430', 0.4), red = glowMat(s.color, 0.3);
    placeAt(group, s, die(2.2, pipMat), -3.2, 1.1, 4.2, ry + 0.4);
    a.box(MAT.stone, 1.9, 1.4, 1.9, 2.6, 0, 4.6); // the tumbler's pedestal
    const tumbler = placeAt(group, s, die(1.8, red), 2.6, 2.3, 4.6, ry);
    anim.push((t) => {
      const k = t % 6, up = k < 1.2 ? Math.sin((k / 1.2) * Math.PI) * 1.6 : 0;
      tumbler.position.y = 2.3 + up;
      tumbler.rotation.x = Math.floor(t / 6) * (Math.PI / 2) + (k < 1.2 ? (k / 1.2) * (Math.PI / 2) : Math.PI / 2);
      tumbler.rotation.z = Math.floor(t / 6) * 0.7;
    });
  },

  sequences(kit, s, anim, group) { // The Observatory: a turning dome with its telescope
    const ry = faceToPlaza(s), a = new At(kit, s.x, s.z, ry);
    a.cyl(MAT.stoneDark, 4.9, 5.1, 0.5, 32, 0, 0, 0);
    a.cyl(MAT.plaster3, 4.2, 4.4, 5.4, 32, 0, 0.5, 0);
    a.cyl(MAT.stone, 4.45, 4.45, 0.3, 32, 0, 5.8, 0);
    a.door(8.6, 8.6); a.windows('left', 4, 4.3, 2.2, 1); a.windows('right', 4, 4.3, 2.2, 1);
    const dome = new THREE.Group();
    dome.add(new THREE.Mesh(new THREE.SphereGeometry(4.3, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), std('#d8dde3', 0.35, 0.6)));
    const slit = new THREE.Mesh(new THREE.BoxGeometry(1.1, 4.6, 0.3), std('#1d2330', 0.5)); slit.position.set(0, 2.1, 3.6); slit.rotation.x = -0.55; dome.add(slit);
    const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 5.2, 16), MAT.metal); scope.position.set(0, 3.4, 2.6); scope.rotation.x = 0.85; dome.add(scope);
    const band = new THREE.Mesh(new THREE.TorusGeometry(4.3, 0.08, 6, 64).rotateX(Math.PI / 2), glowMat(s.color, 0.6)); dome.add(band);
    placeAt(group, s, dome, 0, 6.1, 0, ry);
    anim.push((t, night) => { dome.rotation.y = ry + Math.sin(t * 0.08) * 1.4; band.material.emissiveIntensity = 0.4 + night * 1.5; });
  },

  networks(kit, s, anim, group) { // The Signal Station: a lattice mast and its beacon
    const ry = faceToPlaza(s), a = new At(kit, s.x, s.z, ry);
    a.box(MAT.stoneDark, 5.6, 0.4, 4.6, -3, 0, 1.2); a.box(MAT.plaster2, 5.2, 3.6, 4.2, -3, 0.4, 1.2);
    const hut = new At(kit, s.x, s.z, ry); hut.base.multiply(new THREE.Matrix4().makeTranslation(-3, 0, 1.2)); hut.gable(MAT.roofSlate, 5.2, 4.2, 1.8, 4);
    a.box(MAT.woodDark, 1.1, 2, 0.12, -3, 0.4, 3.33); a.windows('right', 4.2, -0.4, 1.5, 1);
    a.box(MAT.stoneDark, 3.6, 0.6, 3.6, 2.6, 0, -1.5);
    const H = 17;
    for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const leg = new THREE.CylinderGeometry(0.09, 0.14, H, 6).translate(0, H / 2, 0).applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-lz * 0.05, 0, lx * 0.05)));
      a.geo(MAT.metal, leg, 2.6 + lx * 1.3, 0.6, -1.5 + lz * 1.3);
    }
    for (let y = 2; y < H; y += 2.4) {
      const w = 2.6 * (1 - y / (H * 1.25));
      for (const [dx, dz, rot] of [[0, -1, 0], [0, 1, 0], [-1, 0, Math.PI / 2], [1, 0, Math.PI / 2]]) a.box(MAT.metal, w, 0.08, 0.08, 2.6 + (dx * w) / 2, y, -1.5 + (dz * w) / 2, rot);
    }
    a.cyl(MAT.metal, 0.05, 0.05, 1.4, 6, 2.6, H + 0.4, -1.5);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12), glowMat(s.color, 2));
    placeAt(group, s, beacon, 2.6, H + 1.9, -1.5, ry);
    anim.push((t, night) => { beacon.material.emissiveIntensity = (Math.sin(t * 3.2) > 0.2 ? 2.4 : 0.3) + night; });
  },

  bookkeeping(kit, s) { // The Ledger House: a tall counting-house with a coin sign and stacked ledgers
    const ry = faceToPlaza(s), a = new At(kit, s.x, s.z, ry);
    a.box(MAT.stoneDark, 7.4, 0.45, 6.4, 0, 0, -1); a.box(MAT.plaster, 7, 8, 6, 0, 0.4, -1);
    a.box(MAT.woodDark, 7.1, 0.3, 6.1, 0, 3.2, -1);
    for (const x of [-3.5, 3.5]) for (const z of [-4, 2]) a.box(MAT.woodDark, 0.3, 8, 0.3, x, 0.4, z);
    const roof = new At(kit, s.x, s.z, ry); roof.base.multiply(new THREE.Matrix4().makeTranslation(0, 0, -1)); roof.hip(MAT.roofOchre, 7, 6, 3.2, 8.4);
    a.windows('front', 7, 2, 1.4, 2); a.door(7, 4);
    a.box(MAT.metal, 0.1, 0.1, 1.6, 2.4, 4.6, 2.8); a.cyl(MAT.gold, 0.75, 0.75, 0.12, 32, 2.4, 3.6, 3.55); // hanging coin sign
    [s.color, '#6d4c7d', '#3e6b8a', '#a5503a', '#4f7a4a'].forEach((c, i) => a.box(std(c, 0.7), 1.9 - (i % 2) * 0.2, 0.42, 2.6, -2.4 + (i % 2) * 0.15, 0.4 + i * 0.42, 4.2, (i % 3) * 0.12));
  },

  wordplay(kit, s, anim, group) { // The Scriptorium: a long hall with a rose window and a giant quill
    const ry = faceToPlaza(s), a = new At(kit, s.x, s.z, ry);
    a.box(MAT.stoneDark, 6.4, 0.45, 11, 0, 0, -1); a.box(MAT.stone, 6, 5.4, 10.6, 0, 0.4, -1);
    const roof = new At(kit, s.x, s.z, ry + Math.PI / 2); roof.base.multiply(new THREE.Matrix4().makeTranslation(1, 0, 0)); roof.gable(MAT.roofPlum, 10.6, 6, 3.6, 5.8);
    a.door(6, 8.6); a.windows('left', 10.6, 3, 1.8, 1); a.windows('right', 10.6, 3, 1.8, 1);
    const rose = new THREE.Mesh(new THREE.CircleGeometry(1.3, 32), glowMat(s.color, 0.8));
    placeAt(group, s, rose, 0, 7.1, 4.78, ry);
    a.torus(MAT.stone, 1.35, 0.14, 0, 7.1, 4.74, 0);
    for (let i = 0; i < 4; i++) a.geo(MAT.stone, new THREE.BoxGeometry(0.1, 2.6, 0.12), 0, 7.1, 4.82, 0, 0, (i * Math.PI) / 4);
    a.cyl(std('#1d2330', 0.4), 0.7, 0.8, 1, 16, 4.6, 0, 3); // inkwell
    a.geo(std('#f4f1ea', 0.8), new THREE.ConeGeometry(0.45, 3.6, 8).translate(0, 1.8, 0), 4.6, 1, 3, 0.5, 0, 0.35); // the quill
    anim.push((t, night) => { rose.material.emissiveIntensity = 0.6 + night * 1.8; });
  },

  encoding(kit, s, anim, group) { // The Telegraph Office and its semaphore
    const ry = faceToPlaza(s), a = new At(kit, s.x, s.z, ry);
    a.box(MAT.stoneDark, 8.4, 0.45, 6.4, -1, 0, -1); a.box(MAT.plaster2, 8, 4.4, 6, -1, 0.4, -1);
    const roof = new At(kit, s.x, s.z, ry); roof.base.multiply(new THREE.Matrix4().makeTranslation(-1, 0, -1)); roof.gable(MAT.roofTeal, 8, 6, 2.4, 4.8);
    a.windows('front', 8, 2, 1.6, 1); a.door(8, 4, -1);
    a.box(MAT.wood, 0.45, 11, 0.45, 4.6, 0, 2.2); // semaphore post
    const arms = [0, 1].map((i) => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.28, 3.2, 0.14).translate(0, 1.5, 0), std(s.color, 0.6)), new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.1).translate(0, 3.1, 0), MAT.plaster));
      return placeAt(group, s, g, 4.6, i ? 10.6 : 8.2, 2.5, ry);
    });
    anim.push((t) => { const k = Math.floor(t / 1.6); arms[0].rotation.z = ((k * 3) % 8) * (Math.PI / 4); arms[1].rotation.z = -((k * 5) % 8) * (Math.PI / 4); });
    for (let i = 0; i < 3; i++) a.cyl(MAT.wood, 0.12, 0.15, 5.5, 6, -5.5 - i * 0.2, 0, 4 - i * 3.2); // telegraph poles
  },

  puzzles(kit, s) { // The Puzzle Garden: a 3x3 board in hedge and stone, and a gazebo
    const ry = faceToPlaza(s), a = new At(kit, s.x, s.z, ry), acc = std(s.color, 0.6), C = 2.6;
    for (let i = 0; i < 9; i++) {
      const x = ((i % 3) - 1) * C, z = (Math.floor(i / 3) - 1) * C + 1.5;
      a.box(i % 2 ? MAT.stone : MAT.marble, C - 0.4, 0.25, C - 0.4, x, 0, z);
      if ([0, 4, 5, 7].includes(i)) a.box(i === 4 ? acc : MAT.plaster3, 0.9, 0.9, 0.9, x, 0.25, z, i * 0.4);
    }
    const hedgeGeo = new THREE.BoxGeometry(1, 1, 1);
    for (const k of [-1.5, 1.5]) { a.kit.add(MAT.hedge, hedgeGeo, a.m(k * C, 0.35, 1.5, 0, 0, 0, 0.3, 0.7, 3 * C)); a.kit.add(MAT.hedge, hedgeGeo, a.m(0, 0.35, 1.5 + k * C, 0, 0, 0, 3 * C, 0.7, 0.3)); }
    for (const k of [-0.5, 0.5]) { a.kit.add(MAT.hedge, hedgeGeo, a.m(k * C, 0.2, 1.5, 0, 0, 0, 0.18, 0.4, 3 * C)); a.kit.add(MAT.hedge, hedgeGeo, a.m(0, 0.2, 1.5 + k * C, 0, 0, 0, 3 * C, 0.4, 0.18)); }
    for (let i = 0; i < 6; i++) { const ang = (i / 6) * Math.PI * 2; a.cyl(MAT.marble, 0.16, 0.18, 2.8, 10, Math.cos(ang) * 1.9, 0.3, -6 + Math.sin(ang) * 1.9); }
    a.cyl(MAT.stone, 2.3, 2.4, 0.3, 6, 0, 0, -6); a.cone(MAT.roofSage, 2.6, 1.9, 6, 0, 3.1, -6);
  },

  patterns(kit, s, anim, group) { // The Loom House and its running shuttle
    const ry = faceToPlaza(s), a = new At(kit, s.x, s.z, ry);
    a.box(MAT.stoneDark, 9.4, 0.45, 5.4, 0, 0, -2.4); a.box(MAT.plaster3, 9, 4.2, 5, 0, 0.4, -2.4);
    const roof = new At(kit, s.x, s.z, ry); roof.base.multiply(new THREE.Matrix4().makeTranslation(0, 0, -2.4)); roof.gable(MAT.roofSage, 9, 5, 2.2, 4.6);
    a.windows('front', 9, 0.1, 1.6, 1); a.door(9, 0.2, 3);
    for (const x of [-3, 3]) { a.box(MAT.wood, 0.35, 4, 0.35, x, 0, 2.2); a.box(MAT.wood, 0.35, 4, 0.35, x, 0, 4.2); a.box(MAT.wood, 0.35, 0.35, 2.4, x, 3.8, 3.2); }
    a.box(MAT.wood, 6.4, 0.35, 0.35, 0, 3.8, 2.2); a.box(MAT.wood, 6.4, 0.35, 0.35, 0, 0.8, 2.2);
    const threads = [s.color, '#e8d9b8', '#6b87b5', '#c46f5a', s.color, '#e8d9b8'];
    for (let i = 0; i < 24; i++) a.box(std(threads[i % threads.length], 0.8), 0.1, 2.9, 0.04, -2.6 + i * 0.226, 0.95, 2.2);
    a.box(std(s.color, 0.7), 5.4, 1.1, 0.06, 0, 1.2, 2.26); // woven cloth
    const shuttle = placeAt(group, s, new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.18, 0.28), MAT.woodDark), 0, 2.45, 2.32, ry);
    const home = shuttle.position.clone(), dir = new THREE.Vector3(1, 0, 0).applyAxisAngle(UP, ry);
    anim.push((t) => { const k = Math.sin(t * 1.3) * 2.6; shuttle.position.set(home.x + dir.x * k, home.y, home.z + dir.z * k); });
  },
});

// ---------- the whole town ----------

export function buildTown(scene, stations, mask, shared, q) {
  const kit = new Kit(), group = new THREE.Group(), anim = [], ringMats = [];
  const r = rand(4242);

  // plaza: tiered fountain, lamps, benches, notice board
  const p = new At(kit, PLAZA.x, PLAZA.z);
  p.cyl(MAT.stone, 3.9, 4.0, 0.7, 40, 0, 0, 0);
  p.torus(MAT.marble, 3.85, 0.22, 0, 0.72, 0);
  p.cyl(MAT.marble, 0.55, 0.75, 2.3, 16, 0, 0.6, 0);
  p.cyl(MAT.marble, 1.8, 0.6, 0.45, 32, 0, 2.3, 0);
  p.cyl(MAT.marble, 0.3, 0.4, 1.4, 12, 0, 2.7, 0);
  p.sphere(MAT.gold, 0.32, 0, 4.25, 0);
  const water = waterMaterial(shared);
  const pool = new THREE.Mesh(new THREE.CircleGeometry(3.7, 48).rotateX(-Math.PI / 2), water); pool.position.set(0, 0.62, 0); group.add(pool);
  const bowl = new THREE.Mesh(new THREE.CircleGeometry(1.62, 32).rotateX(-Math.PI / 2), water); bowl.position.set(0, 2.72, 0); group.add(bowl);
  const lamps = [];
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 + Math.PI / 8; const x = Math.cos(a) * 11.7, z = Math.sin(a) * 11.7; lampPost(kit, x, z); lamps.push([x, z]); }
  for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + Math.PI / 4; bench(kit, Math.cos(a) * 7.6, Math.sin(a) * 7.6, -a - Math.PI / 2); }
  const nb = new At(kit, -6.2, -7.8, 0.65);
  nb.box(MAT.woodDark, 3.4, 2.1, 0.18, 0, 1.1, 0); nb.box(MAT.roofSlate, 3.8, 0.18, 0.7, 0, 3.25, 0);
  for (const sx of [-1.6, 1.6]) nb.box(MAT.wood, 0.18, 3.3, 0.18, sx, 0, 0);
  for (let i = 0; i < 6; i++) nb.box(MAT.plaster3, 0.8, 0.9, 0.04, -1.1 + (i % 3) * 1.1, 1.4 + Math.floor(i / 3) * 1.0, 0.11);

  // market street lamps + lot edging
  for (let x = 17; x <= 76; x += 11.5) for (const side of [-1, 1]) { lampPost(kit, x, side * 4.2); lamps.push([x, side * 4.2]); }

  // bank
  const bk = new At(kit, BANK.x, BANK.z, Math.atan2(-BANK.x, -BANK.z));
  bk.box(MAT.marble, 11, 0.5, 8, 0, 0, 0);
  bk.box(MAT.plaster, 9.6, 5, 6.4, 0, 0.45, -0.6);
  for (let i = 0; i < 4; i++) bk.cyl(MAT.marble, 0.3, 0.34, 4.4, 14, -3 + i * 2, 0.45, 3.2);
  bk.box(MAT.marble, 9.8, 0.55, 7.6, 0, 4.85, 0);
  const bkr = new At(kit, BANK.x, BANK.z, Math.atan2(-BANK.x, -BANK.z)); bkr.gable(MAT.roofSlate, 9.8, 7.6, 1.8, 5.4, 0.1);
  bk.cyl(MAT.gold, 0.6, 0.6, 0.12, 32, 0, 5.9, 3.75);
  bk.box(MAT.woodDark, 1.6, 2.8, 0.1, 0, 0.45, 2.62);
  bk.windows('left', 6.4, 4.8, 1.6, 1); bk.windows('right', 6.4, 4.8, 1.6, 1);

  // workshop: an open timber hall with the twelve benches the server assigns
  const ws = new At(kit, WORKSHOP.x, WORKSHOP.z);
  ws.box(MAT.stone, 15, 0.3, 11, 0, 0, 0);
  for (const sx of [-7, -2.33, 2.33, 7]) for (const sz of [-5, 5]) ws.box(MAT.wood, 0.4, 4, 0.4, sx, 0.3, sz);
  const wsr = new At(kit, WORKSHOP.x, WORKSHOP.z); wsr.gable(MAT.roofRed, 14.6, 10.6, 2.6, 4.3, 0.4);
  for (let i = 0; i < 12; i++) ws.box(MAT.wood, 2, 0.95, 0.9, -6 + (i % 4) * 4, 0.3, -3 + Math.floor(i / 4) * 3 + 0.9);
  for (let i = 0; i < 5; i++) crates(kit, WORKSHOP.x - 7.5 + r() * 15, WORKSHOP.z + 5.8 + r() * 0.6, r);

  // stations
  for (const s of stations) {
    STATION_BUILDERS[s.skill]?.(kit, s, anim, group);
    if (s.skill !== 'commerce' && s.skill !== 'pathfinding') ringMats.push(stationRing(group, s));
    if (s.skill !== 'commerce') { // lamps flank each station approach
      const d = Math.hypot(s.x, s.z), ux = s.x / d, uz = s.z / d, px = -uz, pz = ux;
      const back = isOuter(s) ? STATION_PAD - 1.4 : STATION_PAD + 0.5; // outer stations: inside the pad, clear of the ring road
      for (const side of [-1, 1]) { const x = s.x - ux * back + px * side * 2.6, z = s.z - uz * back + pz * side * 2.6; if (s.x < 60) { lampPost(kit, x, z); lamps.push([x, z]); } }
    }
  }

  // townhouses fill the gaps between roads, facing the plaza
  const HOUSE_ROOFS = [MAT.roofRed, MAT.roofSlate, MAT.roofSage, MAT.roofRed, MAT.roofOchre, MAT.roofTeal];
  const WALLS = [MAT.plaster, MAT.plaster2, MAT.plaster3];
  let placed = 0;
  for (const ring of [22, 31, 40, 50, 61, 72]) {
    const steps = Math.round((2 * Math.PI * ring) / 10);
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2 + ring;
      const x = Math.cos(a) * ring, z = Math.sin(a) * ring;
      if (x > 12 && Math.abs(z) < 16) continue; // market street keeps its lots
      const w = 5 + r() * 3, d = 4.5 + r() * 2, h = 3.2 + (r() < 0.45 ? 2.7 : 0);
      if (mask.blocked(x, z, Math.max(w, d) / 2 + 1.2)) continue;
      if (r() < 0.25) continue;
      house(kit, x, z, Math.atan2(-x, -z), { w, d, h, wall: WALLS[Math.floor(r() * 3)], roof: HOUSE_ROOFS[Math.floor(r() * HOUSE_ROOFS.length)], timber: r() < 0.4 });
      mask.circle(x, z, Math.max(w, d) / 2 + 0.6);
      placed++;
    }
  }

  // plaza lights at night (a few real lights, the rest glow via bloom)
  const lights = [];
  if (q.bloom) for (let i = 0; i < 4; i++) { const [x, z] = lamps[i * 2]; const l = new THREE.PointLight('#ffc27a', 0, 16, 1.8); l.position.set(x, 3.3, z); group.add(l); lights.push(l); }

  group.add(kit.build());
  scene.add(group);

  return {
    group, lamps, smoke: group.userData.smoke ?? [], placed,
    update(t, dt, night, phase) {
      MAT.window.emissiveIntensity = night * 1.6;
      MAT.lamp.emissiveIntensity = 0.25 + night * 3.2;
      for (const l of lights) l.intensity = night * 14;
      for (const m of ringMats) m.emissiveIntensity = 0.2 + night * 1.2;
      for (const f of anim) f(t, night, phase);
    },
  };
}

// ---------- Market Square shops (rebuilt when listings change) ----------

const shopMatCache = new Map();
const shopMat = (c) => { if (!shopMatCache.has(c)) shopMatCache.set(c, std(c, 0.8)); return shopMatCache.get(c); };
function awningTexture(color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#f3ecdf' : color; g.fillRect(i * 32, 0, 32, 64); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const awningCache = new Map();

export function buildShops(group, shops, colorOf) {
  for (const ch of [...group.children]) { group.remove(ch); ch.traverse?.((o) => { if (o.geometry) o.geometry.dispose(); if (o.material?.map && o.userData.ownMap) o.material.map.dispose(); }); }
  const kit = new Kit(); const taken = new Set(shops.map((s) => s.plot));
  for (const s of shops) {
    if (s.plot >= 16) continue; // a counter in the Merchants' Guild, not a street stall
    const { x, z, side } = plotPos(s.plot), ry = side < 0 ? 0 : Math.PI, color = colorOf(s.agent_id);
    const a = new At(kit, x, z, ry);
    a.box(MAT.stoneDark, 5.3, 0.35, 4.3, 0, 0, 0);
    a.box(MAT.plaster, 5, 3, 4, 0, 0.3, -0.3);
    a.gable(shopMat(color), 5, 4, 1.7, 3.3, 0.3);
    a.box(MAT.wood, 3.8, 1, 0.8, 0, 0.3, 2.25);
    a.windows('back', 5, 2.3, 1.4, 1);
    for (const sx of [-2.3, 2.3]) a.box(MAT.wood, 0.14, 2.6, 0.14, sx, 0.3, 3.05);
    const key = color; if (!awningCache.has(key)) awningCache.set(key, new THREE.MeshStandardMaterial({ map: awningTexture(color), roughness: 0.85, side: THREE.DoubleSide }));
    const awning = new THREE.Mesh(new THREE.PlaneGeometry(5, 1.7), awningCache.get(key));
    const ap = new THREE.Vector3(0, 2.85, 2.45).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    awning.position.set(x + ap.x, ap.y, z + ap.z); awning.rotation.set(0, ry, 0); awning.rotateX(-1.05); awning.castShadow = true;
    const sign = signMesh([s.name, s.currency ? `${s.token_price} ${s.currency === 'CITY' ? '$CITY' : s.currency}` : `${s.price} Obols`], 4.4, s.gold ? { bg: 'gold', fg: '#2b1b04', accent: '#6b4708' } : {});
    sign.userData.ownMap = true;
    const sp = new THREE.Vector3(0, 4.05, 1.72).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    sign.position.set(x + sp.x, sp.y, z + sp.z); sign.rotation.y = ry;
    group.add(awning, sign);
  }
  const rr = rand(99);
  for (let p = 0; p < 16; p++) if (!taken.has(p)) { // empty lots: a planter and a small "available" board
    const { x, z, side } = plotPos(p), a = new At(kit, x, z, side < 0 ? 0 : Math.PI);
    a.box(MAT.stone, 4.6, 0.5, 1.2, 0, 0, -1.2);
    a.box(MAT.hedge, 4.3, 0.55, 0.95, 0, 0.45, -1.2);
    if (rr() < 0.5) crates(kit, x + (rr() - 0.5) * 2, z + side * 0.6, rr);
  }
  const built = kit.build();
  group.add(built);
}

// ---------- homes (rebuilt when a house is bought) ----------

const GLOW = new THREE.MeshStandardMaterial({ color: '#2b2016', emissive: '#ffb45e', emissiveIntensity: 1.6, roughness: 0.6 });
const HOME_PALETTE = ['#d9644a', '#4f7cc9', '#4f9e6b', '#d8a13a', '#8a67c7', '#d6729c', '#3a9ea0', '#e0873d', '#7f9a3a', '#5a5fa8', '#c0506e', '#4aa3d8', '#9a6b45', '#5cc08a', '#a55fd0', '#6d7a8c'];
const FLOWER_MATS = ['#e05a7a', '#f2c94c', '#9b6ad8', '#ffffff', '#f08a3c'].map((c) => std(c, 0.8));
const FLAG_MATS = HOME_PALETTE.map((c) => std(c, 0.8));
const LEAF = std('#4f8a3f', 0.9, 0, { flatShading: true }), APPLE = std('#c9432f', 0.6);
/** The four house styles owners choose from (Release A). Each returns the local positions of its front windows. */
function styledHouse(kit, x, z, ry, style, roof) {
  const a = new At(kit, x, z, ry);
  if (style === 'townhouse') {
    house(kit, x, z, ry, { w: 4.6, d: 5, h: 8.4, wall: MAT.plaster2, roof, floors: 3 });
    return [[0, 4.53, 2.6], [0, 7.23, 2.6]]; // one window per floor, centred (the door takes the ground floor)
  }
  if (style === 'cabin') {
    house(kit, x, z, ry, { w: 6.2, d: 4.8, h: 4.1, wall: MAT.wood, roof, floors: 1 });
    for (const yy of [0.75, 2.75, 3.55]) a.box(MAT.woodDark, 6.3, 0.16, 0.16, 0, yy, 2.42); // log courses, clear of the windows
    return [[-1.15, 1.83, 2.5], [1.15, 1.83, 2.5]];
  }
  if (style === 'tower') {
    a.cyl(MAT.stoneDark, 3, 3.1, 0.45, 16, 0, 0, 0);
    a.cyl(MAT.plaster3, 2.6, 2.75, 9.2, 18, 0, 0.4, 0);
    a.cone(roof, 3.3, 4.2, 18, 0, 9.6, 0);
    for (const yy of [4.2, 7.1]) a.box(MAT.window, 0.95, 1.3, 0.2, 0, yy, 2.62);
    a.box(MAT.woodDark, 1.2, 2.1, 0.25, 0, 0.4, 2.7); // door
    return [[0, 4.85, 2.74], [0, 7.75, 2.74]];
  }
  if (style === 'windmill') { // from the $CITY store
    a.cyl(MAT.stoneDark, 2.7, 2.8, 0.45, 12, 0, 0, 0);
    a.cyl(MAT.plaster2, 2.0, 2.5, 8.2, 12, 0, 0.4, 0);
    a.cone(roof, 2.35, 2.6, 12, 0, 8.6, 0);
    for (const yy of [3.6, 6.1]) a.box(MAT.window, 0.85, 1.1, 0.2, 0, yy, 2.25 - (yy - 0.4) * 0.06);
    a.box(MAT.woodDark, 1.15, 2.05, 0.25, 0, 0.4, 2.52);
    a.box(MAT.wood, 0.5, 0.5, 0.6, 0, 7.6, 2.0); // the sails' hub
    for (let i = 0; i < 4; i++) a.geo(MAT.wood, new THREE.BoxGeometry(0.42, 4.2, 0.07), 0, 7.85, 2.35, 0, 0, i * Math.PI / 2 + 0.35);
    return [[0, 4.15, 2.13], [0, 6.65, 1.98]];
  }
  if (style === 'lighthouse') { // from the $CITY store
    a.cyl(MAT.stoneDark, 2.6, 2.7, 0.45, 16, 0, 0, 0);
    for (let i = 0; i < 4; i++) a.cyl(i % 2 ? MAT.roofRed : MAT.plaster, 1.7 - i * 0.12, 1.8 - i * 0.12, 2.6, 16, 0, 0.4 + i * 2.6, 0);
    a.cyl(MAT.stone, 1.55, 1.55, 0.25, 16, 0, 10.8, 0);
    a.cyl(MAT.lamp, 0.8, 0.8, 1.2, 12, 0, 11.05, 0);
    a.cone(roof, 1.2, 1.3, 12, 0, 12.25, 0);
    for (const yy of [3.5, 6.1]) a.box(MAT.window, 0.8, 1.05, 0.2, 0, yy, 1.62 - (yy > 5 ? 0.12 : 0));
    a.box(MAT.woodDark, 1.1, 2.05, 0.25, 0, 0.4, 1.86);
    return [[0, 4.05, 1.55], [0, 6.65, 1.43]];
  }
  house(kit, x, z, ry, { w: 5.6, d: 4.6, h: 5.9, wall: MAT.plaster3, roof, timber: true, floors: 2 });
  return [[-1.15, 1.83, 2.4], [1.15, 1.83, 2.4], [-1.15, 4.53, 2.4], [1.15, 4.53, 2.4]];
}
/** Yard pieces owners buy and place (up to four, in the corners of the lot). */
function yardPiece(kit, x, z, ry, k, rr) {
  const a = new At(kit, x, z, ry);
  if (k === 'bench') { a.box(MAT.wood, 1.5, 0.12, 0.5, 0, 0.45, 0); a.box(MAT.wood, 1.5, 0.5, 0.1, 0, 0.55, -0.22); for (const sx of [-0.6, 0.6]) a.box(MAT.metal, 0.08, 0.45, 0.45, sx, 0, 0); }
  else if (k === 'lamp') { a.cyl(MAT.metal, 0.06, 0.09, 2.6, 8, 0, 0, 0); a.box(MAT.lamp, 0.32, 0.42, 0.32, 0, 2.55, 0); a.cone(MAT.metal, 0.3, 0.28, 4, 0, 2.97, 0, Math.PI / 4); }
  else if (k === 'flowers') { a.box(MAT.stone, 1.6, 0.3, 0.8, 0, 0, 0); for (let i = 0; i < 7; i++) a.sphere(FLOWER_MATS[Math.floor(rr() * 5)], 0.14, -0.6 + i * 0.2, 0.42 + rr() * 0.12, (rr() - 0.5) * 0.4); }
  else if (k === 'birdbath') { a.cyl(MAT.stone, 0.12, 0.2, 0.8, 10, 0, 0, 0); a.cyl(MAT.stone, 0.55, 0.3, 0.2, 14, 0, 0.8, 0); }
  else if (k === 'statue') { a.box(MAT.stoneDark, 0.8, 0.5, 0.8, 0, 0, 0); a.cyl(MAT.marble, 0.2, 0.26, 1.1, 10, 0, 0.5, 0); a.sphere(MAT.marble, 0.24, 0, 1.85, 0); }
  else if (k === 'flag') { a.cyl(MAT.metal, 0.04, 0.05, 3.6, 6, 0, 0, 0); a.box(FLAG_MATS[Math.floor(rr() * 16)], 0.9, 0.55, 0.03, 0.47, 2.95, 0); }
  else if (k === 'tree') { a.cyl(MAT.woodDark, 0.12, 0.17, 1.5, 7, 0, 0, 0); a.sphere(LEAF, 0.95, 0, 2.1, 0); for (let i = 0; i < 4; i++) a.sphere(APPLE, 0.09, (rr() - 0.5) * 1.2, 1.8 + rr() * 0.6, 0.7); }
  else if (k === 'well') { a.cyl(MAT.stone, 0.62, 0.66, 0.7, 14, 0, 0, 0); for (const sx of [-0.55, 0.55]) a.box(MAT.wood, 0.1, 1.5, 0.1, sx, 0.7, 0); a.gable(MAT.roofRed, 1.5, 1, 0.5, 2.1, 0.1); }
  // from the $CITY store
  else if (k === 'gazebo') { a.cyl(MAT.stone, 1.05, 1.1, 0.18, 8, 0, 0, 0); for (let i = 0; i < 6; i++) { const t = (i / 6) * Math.PI * 2; a.cyl(MAT.marble, 0.05, 0.06, 1.7, 6, Math.cos(t) * 0.9, 0.18, Math.sin(t) * 0.9); } a.cone(MAT.roofTeal, 1.25, 0.8, 6, 0, 1.88, 0); a.cyl(MAT.gold, 0.03, 0.05, 0.3, 6, 0, 2.66, 0); }
  else if (k === 'lanterns') { for (const sx of [-0.8, 0.8]) a.cyl(MAT.woodDark, 0.05, 0.06, 2.2, 6, sx, 0, 0); for (let i = 0; i < 5; i++) a.sphere(MAT.lamp, 0.09, -0.64 + i * 0.32, 1.95 - Math.sin((i / 4) * Math.PI) * 0.22, 0); }
  else if (k === 'topiary') { a.cyl(MAT.stone, 0.32, 0.26, 0.4, 10, 0, 0, 0); a.sphere(MAT.hedge, 0.42, 0, 0.75, 0); a.sphere(MAT.hedge, 0.3, 0, 1.35, 0); a.sphere(MAT.hedge, 0.18, 0, 1.78, 0); }
  else if (k === 'fountain') { a.cyl(MAT.stone, 0.72, 0.78, 0.4, 16, 0, 0, 0); a.cyl(std('#5c9fc4', 0.18, 0.1), 0.62, 0.62, 0.04, 16, 0, 0.37, 0); a.cyl(MAT.marble, 0.09, 0.13, 0.8, 8, 0, 0.4, 0); a.cyl(MAT.marble, 0.3, 0.14, 0.12, 12, 0, 1.2, 0); }
}
const YARD_SPOTS = [[-2.95, 3.05], [2.95, 3.05], [-2.95, -2.95], [2.95, -2.95]];
/** Houses from the server's list (plots, owners, and how owners made them theirs). Returns window glows to light when an owner is home. */
export function buildHouses(group, houses, colorOf) {
  for (const ch of [...group.children]) { group.remove(ch); ch.traverse?.((o) => { if (o.geometry) o.geometry.dispose(); if (o.userData.ownMap) o.material.map.dispose(); }); }
  const kit = new Kit(), glows = [];
  for (const h of houses ?? HOUSE_PLOTS) {
    const a = new At(kit, h.x, h.z, h.ry), rr = rand(h.plot * 131 + 7);
    // garden lot: low hedge on three sides, stone path to the door
    a.box(MAT.hedge, 7.4, 0.7, 0.5, 0, 0, -3.6); a.box(MAT.hedge, 0.5, 0.7, 7.2, -3.7, 0, 0); a.box(MAT.hedge, 0.5, 0.7, 7.2, 3.7, 0, 0);
    a.box(MAT.stone, 1.2, 0.06, 2.4, 0, 0, 3.0);
    let sign;
    if (h.owner_id) {
      const roof = shopMat(Number.isInteger(h.colour) ? HOME_PALETTE[h.colour] : colorOf(h.owner_id, h.owner_avatar));
      const wins = styledHouse(kit, h.x, h.z, h.ry, h.style ?? 'cottage', roof);
      (h.yard ?? []).slice(0, 4).forEach((k, i) => { const [ox, oz] = YARD_SPOTS[i]; const p = new THREE.Vector3(ox, 0, oz).applyAxisAngle(UP, h.ry); yardPiece(kit, h.x + p.x, h.z + p.z, h.ry, k, rr); });
      const g = new THREE.Group();
      for (const [wx, wy, wz] of wins) { const m = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.08), GLOW); m.position.set(wx, wy, wz); g.add(m); }
      g.position.set(h.x, 0, h.z); g.rotation.y = h.ry; g.visible = false; g.userData.owner = h.owner_id; group.add(g); glows.push(g);
      sign = signMesh([h.home_name || h.owner || 'Resident', h.motto || (h.home_name ? `home of ${h.owner}` : 'lives here')], 2.6, { bg: '#26352f' });
    } else {
      sign = signMesh(['For sale', `${(h.price ?? 3000).toLocaleString('en-US')} Obols`], 2.6, { bg: '#5a3d24', accent: '#f2d28a' });
    }
    sign.userData.ownMap = true;
    const off = new THREE.Vector3(2.4, 1.25, 3.9).applyAxisAngle(UP, h.ry);
    sign.position.set(h.x + off.x, off.y, h.z + off.z); sign.rotation.y = h.ry;
    const post = new At(kit, h.x + off.x, h.z + off.z, h.ry); post.box(MAT.wood, 0.12, 0.95, 0.12, 0, 0, -0.05);
    group.add(sign);
  }
  group.add(kit.build());
  group.userData.glows = glows;
  return glows;
}

/** The Lodging House at the far end of Meadow Lane, where every agent without a house has its own room (Release A). */
export function buildLodging(scene, L) {
  const ry = Math.PI, kit = new Kit(), a = new At(kit, L.x, L.z, ry);
  const at = (lx, lz) => { const p = new THREE.Vector3(lx, 0, lz).applyAxisAngle(UP, ry); return [L.x + p.x, L.z + p.z]; };
  house(kit, L.x, L.z, ry, { w: 19, d: 9, h: 9.6, wall: MAT.plaster2, roof: MAT.roofSlate, floors: 3, timber: true });
  const dx = -19 / 4;                                                                   // where house() puts the door
  a.box(MAT.stone, 3.6, 0.25, 2.2, dx, 0, 5.4);                                       // front steps
  for (const sx of [-1.6, 1.6]) a.box(MAT.wood, 0.3, 3.2, 0.3, dx + sx, 0.25, 6.1);   // porch posts
  a.box(MAT.roofRed, 4, 0.25, 2.4, dx, 3.45, 5.5);                                      // porch roof
  for (const sx of [-3, 3]) lampPost(kit, ...at(dx + sx, 6.8));
  for (const sx of [-8.2, 8.2]) { const [bx, bz] = at(sx, 6.4); bench(kit, bx, bz, ry); }
  const group = new THREE.Group(); group.add(kit.build());
  const sign = signMesh(['The Lodging House', 'a room for everyone'], 5.2, { bg: '#26352f' });
  const sp = new THREE.Vector3(2.5, 6.0, 4.62).applyAxisAngle(UP, ry); // on the wall between the first and top floors
  sign.position.set(L.x + sp.x, sp.y, L.z + sp.z); sign.rotation.y = ry; group.add(sign);
  const glows = [];
  for (let f = 0; f < 3; f++) for (let i = -3; i <= 3; i++) {
    if (f === 0 && i === -2) continue; // the door
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.08), GLOW);
    const p = new THREE.Vector3(i * 2.3, 1.83 + f * 2.7, 4.6).applyAxisAngle(UP, ry);
    m.position.set(L.x + p.x, p.y, L.z + p.z); m.rotation.y = ry; m.visible = false; group.add(m); glows.push(m);
  }
  scene.add(group);
  return { group, glows };
}

// ---------- the park by the Garden (Release B): food carts, bandstand, Gallery wall ----------
const PARK_PALETTE = ['#d9644a', '#4f7cc9', '#4f9e6b', '#d8a13a', '#8a67c7', '#d6729c', '#3a9ea0', '#e0873d', '#7f9a3a', '#5a5fa8', '#c0506e', '#4aa3d8', '#9a6b45', '#5cc08a', '#a55fd0', '#6d7a8c'];
const SOIL = std('#5a4030', 0.98), LEAFY = std('#4f8f3a', 0.9, 0, { flatShading: true }), STEM = std('#3f6e2a', 0.9);
const cropMats = new Map();
const cropMat = (c) => { if (!cropMats.has(c)) cropMats.set(c, std(c, 0.7)); return cropMats.get(c); };
/** One plant, drawn for its crop and how far along it is (0 sprout .. 1 ripe). */
function plant(kit, x, z, crop, colour, t) { // a food cart's batch: the umbrella opens as it cooks, a lit sign when it's ready
  const a = new At(kit, x, z);
  const open = 0.35 + 0.65 * Math.min(1, t);
  a.cyl(STEM, 0.04, 0.04, 2.3, 6, 0, 0.9, 0);
  a.cone(cropMat(colour), 1.5 * open, 0.55, 10, 0, 3.0, 0);
  if (t >= 1) a.box(GLOW, 1.2, 0.35, 0.08, 0, 1.95, 0.75);
}
function paintingTexture(pixels) {
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const g = c.getContext('2d');
  for (let i = 0; i < 256; i++) { g.fillStyle = PARK_PALETTE[parseInt(pixels[i], 16)] ?? '#000'; g.fillRect(i % 16, Math.floor(i / 16), 1, 1); }
  const t = new THREE.CanvasTexture(c); t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
export function buildPark(scene, P, bedPos, beds = 24) {
  const kit = new Kit();
  // food cart beds: raised wooden frames of soil
  for (let i = 0; i < beds; i++) {
    const p = bedPos(i), a = new At(kit, p.x, p.z);
    a.box(MAT.metal, 2.2, 0.9, 1.2, 0, 0.35, 0);                         // the cart
    a.box(std('#d9d4c8', 0.6, 0.2), 2.3, 0.08, 1.3, 0, 1.25, 0);          // counter
    for (const sx of [-0.8, 0.8]) for (const sz of [-0.62, 0.62]) a.cyl(MAT.woodDark, 0.2, 0.2, 0.1, 10, sx, 0.15, sz);
  }
  // the bandstand: an eight-sided pavilion with a teal roof
  const B = new At(kit, P.bandstand.x, P.bandstand.z);
  B.cyl(MAT.stone, 3.3, 3.4, 0.55, 8, 0, 0, 0);
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2 + Math.PI / 8, x = Math.cos(ang) * 2.95, z = Math.sin(ang) * 2.95;
    B.cyl(MAT.marble, 0.11, 0.13, 2.9, 8, x, 0.55, z);
    if (i !== 6) B.box(MAT.wood, 2.2, 0.08, 0.08, (x + Math.cos(ang + Math.PI / 4) * 2.95) / 2, 1.35, (z + Math.sin(ang + Math.PI / 4) * 2.95) / 2, -(ang + Math.PI / 8) + Math.PI / 2);
  }
  B.cone(MAT.roofTeal, 3.9, 1.9, 8, 0, 3.45, 0, Math.PI / 8);
  B.cyl(MAT.gold, 0.05, 0.08, 0.9, 6, 0, 5.3, 0);
  // the Gallery wall, facing the park
  const G = new At(kit, P.gallery.x, P.gallery.z, Math.PI);
  G.box(MAT.plaster2, 24, 3.4, 0.5, 0, 0, 0);
  G.box(MAT.stone, 24.6, 0.35, 0.8, 0, 3.4, 0);
  G.box(MAT.stoneDark, 24.4, 0.3, 0.7, 0, 0, 0);
  for (let k = 0; k < 8; k++) G.box(MAT.woodDark, 2.35, 2.35, 0.12, -9.1 + k * 2.6, 0.75, 0.3);
  const group = new THREE.Group(); group.add(kit.build());
  const gallerySign = signMesh(['The Gallery', 'paint · like · hang'], 3.6, { bg: '#26352f' });
  const gp = new THREE.Vector3(0, 3.95, 0.3).applyAxisAngle(UP, Math.PI);
  gallerySign.position.set(P.gallery.x + gp.x, gp.y, P.gallery.z + gp.z); gallerySign.rotation.y = Math.PI; group.add(gallerySign);
  const plants = new THREE.Group(), frames = new THREE.Group();
  group.add(plants, frames); scene.add(group);

  let bedData = [];
  const drawBeds = () => {
    for (const ch of [...plants.children]) { plants.remove(ch); ch.traverse?.((o) => o.geometry?.dispose()); }
    if (!bedData.length) return;
    const pk = new Kit(), now = Date.now();
    for (const b of bedData) {
      const p = bedPos(b.bed), t = now >= b.ready ? 1 : Math.max(0, (now - b.planted) / Math.max(1, b.ready - b.planted));
      plant(pk, Math.round(p.x), p.z, b.crop, b.colour, t);
    }
    plants.add(pk.build());
  };
  return {
    group,
    setBeds(beds) { bedData = beds ?? []; drawBeds(); },
    tick() { drawBeds(); },
    setWall(wall) {
      for (const ch of [...frames.children]) { frames.remove(ch); ch.material?.map?.dispose(); ch.material?.dispose(); ch.geometry?.dispose(); }
      (wall ?? []).slice(0, 8).forEach((w, k) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(2.05, 2.05), new THREE.MeshStandardMaterial({ map: paintingTexture(w.pixels), roughness: 0.85 }));
        const p = new THREE.Vector3(-9.1 + k * 2.6, 1.93, 0.38).applyAxisAngle(UP, Math.PI);
        m.position.set(P.gallery.x + p.x, p.y, P.gallery.z + p.z); m.rotation.y = Math.PI; frames.add(m);
        const label = signMesh([w.title, `${w.by}${w.likes ? ` · ${w.likes} ♥` : ''}`], 2.3, { bg: '#26352f' });
        label.userData.ownMap = true;
        const lp = new THREE.Vector3(-9.1 + k * 2.6, 0.38, 0.4).applyAxisAngle(UP, Math.PI);
        label.position.set(P.gallery.x + lp.x, lp.y, P.gallery.z + lp.z); label.rotation.y = Math.PI; label.scale.setScalar(0.85); frames.add(label);
      });
    },
  };
}

// ---------- the Games Court (Release C): eight stone tables south of the plaza ----------
export function buildGamesGarden(scene, spots) {
  const kit = new Kit();
  for (const [x, z] of spots) {
    const a = new At(kit, x, z);
    a.cyl(MAT.stoneDark, 0.35, 0.45, 0.8, 10, 0, 0, 0);
    a.cyl(MAT.stone, 1.05, 1.05, 0.12, 20, 0, 0.8, 0);
    for (let k = 0; k < 4; k++) { const ang = (k / 4) * Math.PI * 2 + Math.PI / 4; a.cyl(MAT.wood, 0.28, 0.3, 0.45, 10, Math.cos(ang) * 1.75, 0, Math.sin(ang) * 1.75); }
  }
  const cx = spots.reduce((s, p) => s + p[0], 0) / spots.length, cz = spots.reduce((s, p) => s + p[1], 0) / spots.length;
  for (const [dx, dz] of [[-9, 4], [9, 4], [-6, -9], [9, -9]]) lampPost(kit, cx + dx, cz + dz);
  const group = new THREE.Group(); group.add(kit.build());
  const sign = signMesh(['Games Court', 'take a seat · play anyone'], 3.8, { bg: '#26352f' });
  sign.position.set(cx - 2, 1.5, cz + 7); sign.rotation.y = Math.PI * 0.85; group.add(sign);
  const labels = new THREE.Group(); group.add(labels);
  scene.add(group);
  return {
    group,
    /** A floating sign over every table in use: the game, and whether it is waiting for players. */
    setTables(tables) {
      for (const ch of [...labels.children]) { labels.remove(ch); ch.material?.map?.dispose(); ch.material?.dispose(); ch.geometry?.dispose(); }
      for (const t of tables ?? []) {
        if (t.spot === null || t.spot === undefined || t.status === 'done' || !spots[t.spot]) continue;
        const [x, z] = spots[t.spot];
        const m = signMesh([t.name, t.status === 'open' ? `${t.seats.length}/${t.max} seated · join!` : `${t.seats.length} playing`], 2.4, { bg: t.status === 'open' ? '#5a3d24' : '#26352f', accent: '#f2d28a' });
        m.position.set(x, 3.1, z); m.userData.billboard = true; labels.add(m);
      }
    },
    /** Keep the table signs facing the camera. */
    face(camera) { for (const m of labels.children) m.quaternion.copy(camera.quaternion); },
  };
}

// ---------- the City Hall square (Releases E and F): the City Hall, the Hall of Fame, and what the city votes to build ----------
const PAVE = std('#cfc6b6', 0.95), WATER = std('#5c9fc4', 0.18, 0.1), DARKWELL = std('#1e2226', 0.9), ROSE = std('#d04a6a', 0.7);
const HALL_FRONT = 3; // half the City Hall's depth: its front wall
function townHall(kit, x, z) {
  const a = new At(kit, x, z), w = 10.4, d = HALL_FRONT * 2, h = 6.2, front = HALL_FRONT;
  a.box(MAT.stoneDark, w + 0.8, 0.5, d + 0.8, 0, 0, 0);
  a.box(MAT.plaster, w, h, d, 0, 0.5, 0);
  a.box(MAT.stone, w + 0.4, 0.35, d + 0.4, 0, 0.5 + h, 0);
  a.hip(MAT.roofSlate, w, d, 2.2, 0.85 + h, 0.3);
  a.windows('front', w, front, 1.4, 2); a.windows('back', w, front, 1.4, 2); a.windows('left', d, w / 2, 1.4, 2); a.windows('right', d, w / 2, 1.4, 2);
  a.door(w, d, 0);
  // the portico: four columns, a frieze for the name, a pediment
  for (const cx of [-3.3, -1.1, 1.1, 3.3]) { a.cyl(MAT.marble, 0.26, 0.3, 4.1, 14, cx, 0.5, front + 1.5); a.box(MAT.stone, 0.75, 0.2, 0.75, cx, 0.5, front + 1.5); }
  a.box(MAT.stone, 8.6, 1.2, 2.2, 0, 4.6, front + 1.1);
  new At(kit, x, z + front + 1.1, Math.PI / 2).gable(MAT.stone, 2.2, 8.6, 1.5, 5.8, 0.05);
  for (let i = 0; i < 3; i++) a.box(MAT.stone, 7.6 - i * 0.5, 0.17, 1.1, 0, 0.33 - i * 0.17, front + 2.95 + i * 0.3);
  // the clock turret
  a.box(MAT.plaster, 2.4, 2.4, 2.4, 0, 0.85 + h + 1.4, 0);
  a.geo(MAT.marble, new THREE.CylinderGeometry(0.7, 0.7, 0.1, 24), 0, 0.85 + h + 2.6, 1.23, Math.PI / 2, 0, 0); // the clock face, towards the square
  a.cone(MAT.roofTeal, 1.95, 2.2, 4, 0, 0.85 + h + 3.8, 0, Math.PI / 4);
  a.cyl(MAT.gold, 0.05, 0.08, 0.8, 6, 0, 0.85 + h + 6.1, 0);
  for (const sx of [-4.4, 4.4]) lampPost(kit, x + sx, z + front + 3.2);
}
function civicWork(kit, k, x, z, ry, rr) {
  const a = new At(kit, x, z, ry);
  if (k === 'bench') bench(kit, x, z, ry);
  else if (k === 'lamp') lampPost(kit, x, z);
  else if (k === 'signpost') { a.cyl(MAT.woodDark, 0.08, 0.1, 2.6, 8, 0, 0, 0); a.box(MAT.wood, 1.3, 0.28, 0.06, 0.45, 2.1, 0); a.box(MAT.wood, 1.2, 0.26, 0.06, -0.4, 1.7, 0, 0.5); }
  else if (k === 'planters') { for (const sx of [-0.6, 0.6]) { a.cyl(MAT.stone, 0.42, 0.34, 0.55, 12, sx, 0, 0); for (let i = 0; i < 5; i++) a.sphere(FLOWER_MATS[Math.floor(rr() * 5)], 0.13, sx + (rr() - 0.5) * 0.5, 0.65 + rr() * 0.12, (rr() - 0.5) * 0.5); } }
  else if (k === 'flowers') { a.cyl(SOIL, 1.2, 1.25, 0.22, 20, 0, 0, 0); a.torus(MAT.stone, 1.25, 0.09, 0, 0.18, 0); for (let i = 0; i < 26; i++) { const t = rr() * Math.PI * 2, r = Math.sqrt(rr()) * 1.05; a.sphere(FLOWER_MATS[i % 5], 0.12, Math.cos(t) * r, 0.34 + rr() * 0.1, Math.sin(t) * r); } }
  else if (k === 'tree') { a.cyl(MAT.woodDark, 0.16, 0.24, 2, 8, 0, 0, 0); a.sphere(LEAF, 1.35, 0, 2.8, 0); for (let i = 0; i < 7; i++) { const t = rr() * Math.PI * 2; a.sphere(APPLE, 0.11, Math.cos(t) * 1.1, 2.3 + rr() * 1, Math.sin(t) * 1.1); } }
  else if (k === 'birdbath') { a.cyl(MAT.stone, 0.14, 0.24, 0.95, 12, 0, 0, 0); a.cyl(MAT.stone, 0.7, 0.36, 0.24, 18, 0, 0.95, 0); a.cyl(WATER, 0.6, 0.6, 0.04, 18, 0, 1.16, 0); }
  else if (k === 'well') { a.cyl(MAT.stone, 0.85, 0.9, 0.85, 16, 0, 0, 0); a.cyl(DARKWELL, 0.66, 0.66, 0.05, 16, 0, 0.83, 0); for (const sx of [-0.75, 0.75]) a.box(MAT.wood, 0.12, 1.9, 0.12, sx, 0.85, 0); a.box(MAT.wood, 1.6, 0.1, 0.1, 0, 2.3, 0); a.gable(MAT.roofRed, 1.9, 1.3, 0.6, 2.7, 0.12); }
  else if (k === 'pergola') {
    for (const [sx, sz] of [[-1.2, -0.7], [1.2, -0.7], [-1.2, 0.7], [1.2, 0.7]]) a.box(MAT.wood, 0.16, 2.5, 0.16, sx, 0, sz);
    for (const sz of [-0.7, 0.7]) a.box(MAT.woodDark, 2.8, 0.14, 0.16, 0, 2.5, sz);
    for (let i = 0; i < 5; i++) a.box(MAT.woodDark, 0.12, 0.12, 1.8, -1 + i * 0.5, 2.64, 0);
    for (let i = 0; i < 14; i++) a.sphere(i % 3 ? LEAF : ROSE, 0.2, (rr() - 0.5) * 2.6, 2.6 + rr() * 0.3, (rr() - 0.5) * 1.6);
    bench(kit, x, z, ry);
  } else if (k === 'fountain') { a.cyl(MAT.stone, 1.35, 1.45, 0.55, 24, 0, 0, 0); a.cyl(WATER, 1.18, 1.18, 0.05, 24, 0, 0.5, 0); a.cyl(MAT.marble, 0.2, 0.28, 1.3, 12, 0, 0.5, 0); a.cyl(MAT.marble, 0.7, 0.3, 0.2, 18, 0, 1.75, 0); a.cyl(WATER, 0.6, 0.6, 0.04, 18, 0, 1.93, 0); a.cyl(MAT.marble, 0.08, 0.12, 0.5, 8, 0, 1.95, 0); }
  else if (k === 'clock') {
    a.cyl(MAT.metal, 0.1, 0.16, 3.6, 10, 0, 0, 0); a.box(MAT.metal, 0.9, 0.9, 0.9, 0, 3.6, 0);
    for (const [dx, dz, r] of [[0, 0.46, 0], [0, -0.46, 0], [0.46, 0, Math.PI / 2], [-0.46, 0, Math.PI / 2]]) a.geo(MAT.marble, new THREE.CylinderGeometry(0.36, 0.36, 0.04, 20), dx, 4.05, dz, Math.PI / 2, r, 0);
    a.cone(MAT.gold, 0.3, 0.5, 4, 0, 4.5, 0, Math.PI / 4);
  } else if (k === 'statue') { a.box(MAT.stoneDark, 1.3, 1.1, 1.3, 0, 0, 0); a.box(MAT.stone, 1.1, 0.12, 1.1, 0, 1.1, 0); a.cyl(MAT.marble, 0.24, 0.3, 1.1, 12, 0, 1.2, 0); a.cyl(MAT.marble, 0.28, 0.24, 0.8, 12, 0, 2.3, 0); a.sphere(MAT.marble, 0.26, 0, 3.4, 0); a.box(MAT.marble, 0.14, 0.75, 0.14, 0.38, 2.4, 0.05); a.box(MAT.marble, 0.14, 0.8, 0.14, -0.4, 2.75, 0.1, 0.9); }
}
/** A board of lines on canvas, for the Hall of Fame. */
function boardTexture(title, rows, { w = 1024, h = 700, bg = '#26352f', fg = '#f3ead6', accent = '#d7ae4a' } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (bg === 'gold') { const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#f8de8e'); gr.addColorStop(0.5, '#d8a53a'); gr.addColorStop(1, '#f2cc66'); g.fillStyle = gr; } // the $CITY store's gold sign
  else g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = accent; g.globalAlpha = 0.55; g.lineWidth = 4; g.strokeRect(16, 16, w - 32, h - 32); g.globalAlpha = 1;
  g.textAlign = 'center'; g.fillStyle = accent; g.font = '600 88px "Fraunces Variable", Georgia, serif'; g.fillText(title, w / 2, 112);
  let y = 200;
  for (const [left, right] of rows.slice(0, 7)) {
    g.textAlign = 'left'; g.fillStyle = accent; g.font = '600 40px "Inter Variable", system-ui, sans-serif'; g.fillText(left, 56, y);
    const lw = g.measureText(left).width;
    g.textAlign = 'right'; g.fillStyle = fg; g.font = '500 40px "Inter Variable", system-ui, sans-serif';
    let t = right; while (g.measureText(t).width > w - 150 - lw && t.length > 4) t = t.slice(0, -2);
    g.fillText(t === right ? right : `${t}…`, w - 56, y);
    y += 70;
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
const PLAQUE_OFF = { statue: 0.72, fountain: 1.75, flowers: 1.5, well: 1.15 }; // in front of the work, clear of a basin or bed
const WORK_NAMES = { bench: 'Bench', signpost: 'Signpost', lamp: 'Lamp post', planters: 'Planters', flowers: 'Flower bed', tree: 'Apple tree', birdbath: 'Bird bath', well: 'Wishing well', pergola: 'Pergola', fountain: 'Fountain', clock: 'Town clock', statue: 'Statue' };
/** City Hall: paving, the City Hall and the Hall of Fame; setWorks draws what the city has built, setHall fills
 *  the Hall of Fame board. Returns window glows to light at night. */
export function buildCivic(scene, C, T, H, spots) {
  const kit = new Kit(), group = new THREE.Group();
  const a = new At(kit, C.x, C.z);
  a.box(PAVE, C.x1 - C.x0, 0.06, C.z1 - C.z0, 0, 0, 0);
  a.torus(MAT.stoneDark, 2.8, 0.12, 0, 0.08, 4.3);
  townHall(kit, T.x, T.z);
  // the Hall of Fame: a two-sided board, read from the street and from the square
  const hb = new At(kit, H.x, H.z);
  hb.box(MAT.stoneDark, 4.6, 0.5, 1.1, 0, 0, 0);
  for (const sx of [-2.15, 2.15]) hb.box(MAT.stone, 0.36, 3.5, 0.46, sx, 0.5, 0);
  hb.box(MAT.stone, 4.8, 0.3, 0.64, 0, 4, 0);
  hb.torus(MAT.gold, 0.38, 0.065, 0, 4.72, 0, 0);
  hb.box(MAT.woodDark, 4, 2.9, 0.14, 0, 0.9, 0);
  group.add(kit.build());
  const board = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 2.6), new THREE.MeshStandardMaterial({ map: boardTexture('Hall of Fame', [['The first season', 'closes soon']]), roughness: 0.7 }));
  board.position.set(H.x, 2.35, H.z + 0.08); group.add(board);
  const back = new THREE.Mesh(board.geometry, board.material);
  back.position.set(H.x, 2.35, H.z - 0.08); back.rotation.y = Math.PI; group.add(back);
  const sign = signMesh(['City Hall', 'council · proposals · treasury'], 4.2, { bg: '#26352f' });
  sign.position.set(T.x, 5.2, T.z + HALL_FRONT + 2.23); group.add(sign);
  const glows = [];
  for (let f = 0; f < 2; f++) for (const ox of [-3.45, -1.15, 1.15, 3.45]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.1), GLOW);
    m.position.set(T.x + ox, 1.97 + f * 2.7, T.z + HALL_FRONT + 0.1); m.visible = false; group.add(m); glows.push(m);
  }
  const worksG = new THREE.Group(); group.add(worksG);
  scene.add(group);
  return {
    group, glows,
    setWorks(list) {
      for (const ch of [...worksG.children]) { worksG.remove(ch); ch.traverse?.((o) => { o.geometry?.dispose(); if (o.userData.ownMap) { o.material.map?.dispose(); o.material.dispose(); } }); }
      const wk = new Kit();
      for (const w of list ?? []) {
        const p = spots[w.spot]; if (!p) continue;
        const ry = Math.atan2(C.x - p[0], (C.z + 2) - p[1]); // face the middle of the square
        civicWork(wk, w.work, p[0], p[1], ry, rand(w.spot * 7919 + 17));
        if (w.name || w.sponsor || w.work === 'statue' || w.work === 'signpost') {
          const m = signMesh([w.name || WORK_NAMES[w.work] || w.work, w.sponsor ? `sponsored by ${w.sponsor}` : `proposed by ${w.by}`], 1.5, { bg: w.sponsor ? '#3d2f12' : '#26352f' });
          const off = new THREE.Vector3(0, 0, PLAQUE_OFF[w.work] ?? 1.1).applyAxisAngle(UP, ry);
          m.position.set(p[0] + off.x, w.work === 'statue' ? 0.62 : 0.5, p[1] + off.z); m.rotation.y = ry; m.userData.ownMap = true; worksG.add(m);
        }
      }
      if (list?.length) worksG.add(wk.build());
    },
    setHall(h) {
      if (!h) return;
      const rows = [], done = (h.seasons ?? []).filter((x) => x.champions.length);
      for (const s of done.slice(0, 3)) rows.push([`Season ${s.id}`, s.champions.slice(0, 3).map((c) => c.handle).join(', ')]);
      if (h.current && done.length === 0) rows.push([`Season ${h.current.id}`, 'under way']);
      for (const f of (h.festivals ?? []).slice(0, 6)) rows.push([f.name, f.winner.handle]);
      if (h.council?.length) rows.push(['Council', h.council.join(', ')]);
      if (rows.length === 0) rows.push(['The first champions', 'soon']);
      this.setRows(rows);
    },
    /** Any rows on the board (the film uses this to show what can be won). */
    setRows(rows) { board.material.map?.dispose(); board.material.map = boardTexture('Hall of Fame', rows); board.material.needsUpdate = true; },
  };
}

// ---------- town projects (one town, same rules: Phase 3), drawn once the city has built them ----------
/** The finished town projects: the Footbridge over the pond, the Lantern Walk along Meadow Lane, the Amphitheatre by
 *  the bandstand. P: { pond, bandstand, meadow: { x, z0, z1 } }. set(built) redraws them from the list of finished kinds. */
export function buildProjects(scene, P) {
  const group = new THREE.Group(); scene.add(group);
  const lights = [];
  function draw(built) {
    for (const ch of [...group.children]) { group.remove(ch); ch.traverse?.((o) => o.geometry?.dispose()); }
    lights.length = 0;
    const kit = new Kit();
    if (built.includes('footbridge')) { // an arched plank bridge across the pond, west bank to east bank
      const { x, z, r } = P.pond, x0 = x - r - 1.6, x1 = x + r + 1.6, N = 14, a = new At(kit, 0, 0);
      const yAt = (t) => 0.32 + 0.95 * Math.sin(Math.PI * t), xAt = (t) => x0 + (x1 - x0) * t;
      for (let i = 0; i < N; i++) {
        const t0 = i / N, t1 = (i + 1) / N, len = Math.hypot(xAt(t1) - xAt(t0), yAt(t1) - yAt(t0)) + 0.06, ang = Math.atan2(yAt(t1) - yAt(t0), xAt(t1) - xAt(t0));
        a.geo(MAT.wood, new THREE.BoxGeometry(len, 0.14, 1.7), (xAt(t0) + xAt(t1)) / 2, (yAt(t0) + yAt(t1)) / 2, z, 0, 0, ang);
        for (const s of [-0.8, 0.8]) a.geo(MAT.woodDark, new THREE.BoxGeometry(len, 0.08, 0.08), (xAt(t0) + xAt(t1)) / 2, (yAt(t0) + yAt(t1)) / 2 + 0.75, z + s, 0, 0, ang);
      }
      for (let i = 0; i <= N; i += 2) for (const s of [-0.8, 0.8]) a.box(MAT.woodDark, 0.1, 0.8, 0.1, xAt(i / N), yAt(i / N), z + s);
      for (const ex of [x0, x1]) a.box(MAT.stone, 1.4, 0.4, 2.2, ex, 0, z);
    }
    if (built.includes('lanterns')) { // lantern posts both sides of Meadow Lane, lit at night
      const M = P.meadow, a = new At(kit, 0, 0);
      for (let lz = M.z0 + 4; lz <= M.z1 - 2; lz += 8) for (const lx of [M.x - 2.6, M.x + 2.6]) {
        a.cyl(MAT.woodDark, 0.06, 0.08, 2.4, 6, lx, 0, lz);
        a.box(MAT.woodDark, 0.5, 0.06, 0.06, lx + (lx < M.x ? 0.22 : -0.22), 2.36, lz);
        a.box(MAT.lamp, 0.26, 0.34, 0.26, lx + (lx < M.x ? 0.42 : -0.42), 1.96, lz);
        lights.push([lx + (lx < M.x ? 0.42 : -0.42), lz]);
      }
    }
    if (built.includes('amphitheatre')) { // three stone tiers in an arc facing the bandstand
      const B = P.bandstand, a = new At(kit, 0, 0);
      for (let k = 0; k < 3; k++) {
        const rad = 5.4 + k * 1.15, h = 0.32 + k * 0.32, seg = 16;
        for (let i = 0; i < seg; i++) {
          const th = (-30 + (115 * (i + 0.5)) / seg) * (Math.PI / 180); // south-east round to north: clear of the Gallery wall and the houses
          a.geo(MAT.stone, new THREE.BoxGeometry(1.08, h, (2 * Math.PI * rad * (115 / 360)) / seg + 0.05), B.x + Math.cos(th) * rad, h / 2, B.z + Math.sin(th) * rad, 0, -th, 0);
        }
      }
    }
    group.add(kit.build());
  }
  return { group, lights, set(built) { draw(built ?? []); } };
}

export { Kit, At, signMesh, GLOW, shopMat, awningTexture, lampPost, bench, std };
