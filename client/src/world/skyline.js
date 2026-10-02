// The skyline. Every lot gets a building massed from its style (podium, shaft, setbacks, crown); all of them
// share ONE material whose shader draws windows, storefronts, neon sign bands and night lights from each
// face's own coordinates, so thousands of towers cost a handful of draw calls and no textures.
import * as THREE from 'three';
import { EDGE, GROUND_TOP, DISTRICTS } from './cityplan.js';
import { rand } from './layout.js';

const CHUNK = 300; // metres; one merged mesh per chunk so the camera frustum can skip most of the city

/** Geometry writer: quads with world-metre facade coordinates and per-building attributes. */
export class Mass {
  constructor() { this.P = []; this.Nn = []; this.U = []; this.B = []; this.F = []; this.I = []; this.v = 0; }
  vert(x, y, z, n, u, v, B, F) {
    this.P.push(x, y, z); this.Nn.push(n[0], n[1], n[2]); this.U.push(u, v);
    this.B.push(B[0], B[1], B[2], B[3]); this.F.push(F[0], F[1], F[2]);
    return this.v++;
  }
  quad(a, b, c, d, n, u0, v0, u1, v1, B, F) {
    const i = this.vert(a[0], a[1], a[2], n, u0, v0, B, F);
    this.vert(b[0], b[1], b[2], n, u1, v0, B, F);
    this.vert(c[0], c[1], c[2], n, u1, v1, B, F);
    this.vert(d[0], d[1], d[2], n, u0, v1, B, F);
    this.I.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
  /** Axis-aligned box: four walls (u = metres along the face, v = world height) and an optional top. */
  prism(x0, z0, x1, z1, y0, y1, Bs, Bt, G, tier) {
    const w = x1 - x0, d = z1 - z0, t4 = tier * 4;
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], 0, y0, w, y1, Bs, [w, G, t4]);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], 0, y0, w, y1, Bs, [w, G, t4 + 1]);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], 0, y0, d, y1, Bs, [d, G, t4 + 2]);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], 0, y0, d, y1, Bs, [d, G, t4 + 3]);
    if (Bt) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], x0, z1, x1, z0, Bt, [w, G, 0]);
  }
  pyramid(cx, cz, hx, hz, y, h, B, G) {
    const apex = [cx, y + h, cz];
    const c = [[cx - hx, y, cz + hz], [cx + hx, y, cz + hz], [cx + hx, y, cz - hz], [cx - hx, y, cz - hz]];
    for (let k = 0; k < 4; k++) {
      const a = c[k], b = c[(k + 1) % 4];
      const e1 = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), e2 = new THREE.Vector3(apex[0] - a[0], apex[1] - a[1], apex[2] - a[2]);
      const n = e1.cross(e2).normalize().toArray();
      const i = this.vert(a[0], a[1], a[2], n, 0, y, B, [1, G, 0]);
      this.vert(b[0], b[1], b[2], n, 1, y, B, [1, G, 0]);
      this.vert(apex[0], apex[1], apex[2], n, 0.5, y + h, B, [1, G, 0]);
      this.I.push(i, i + 1, i + 2);
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.Nn, 3));
    g.setAttribute('aFac', new THREE.Float32BufferAttribute(this.U, 2));
    g.setAttribute('aB', new THREE.Float32BufferAttribute(this.B, 4));
    g.setAttribute('aF', new THREE.Float32BufferAttribute(this.F, 3));
    g.setIndex(this.v > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// kinds: 0 facade (windows + storefront), 1 roof, 2 trim, 3 blank wall, 4 floodlit crown
let curLot = -1; // the lot being raised, stamped on its roof props so they can be hidden later
function raise(m, lot, props) {
  curLot = lot.id;
  const r = rand(((lot.seed * 4294967296) >>> 0) ^ 0x9e3779b9);
  const { x, z, w, d, h, style, district } = lot;
  const lit = style === 3 ? 0.3 + r() * 0.32 : style === 0 ? 0.18 + r() * 0.36 : 0.22 + r() * 0.34;
  const B = (kind) => [lot.seed, style, kind + 10 * district, lit];
  const G = GROUND_TOP;
  const hx = w / 2 - 0.3, hz = d / 2 - 0.3;
  const cap = (ax, az, y, tier) => m.prism(x - ax - 0.28, z - az - 0.28, x + ax + 0.28, z + az + 0.28, y - 0.75, y + 0.32, B(2), B(1), G, tier);

  if (style === 3 || h < 16 || Math.min(w, d) < 9) {           // walk-up: one mass, cornice, flat roof
    m.prism(x - hx, z - hz, x + hx, z + hz, 0, h, B(0), null, G, 0);
    cap(hx, hz, h, 1);
    const top = h + 0.32;
    roof(props, r, x, z, hx, hz, top, style === 3 && Math.min(w, d) > 10 && r() < 0.5);
    return { lot, podH: h, shaft: { hx, hz, y0: 0, y1: h }, top: { hx, hz, y: top } };
  }

  const podH = h > 60 ? G + 3.7 * (1 + Math.floor(r() * 3)) : G + 3.7 * Math.floor(r() * 2);
  m.prism(x - hx, z - hz, x + hx, z + hz, 0, podH, B(0), null, G, 0);
  cap(hx, hz, podH, 1);
  const ins = style === 0 ? 1.6 + r() * 3.2 : style === 2 ? 1 + r() * 1.5 : 1 + r() * 2.4;
  let sx = Math.max(3.5, hx - ins), sz = Math.max(3.5, hz - ins);
  const tiers = style === 2 ? 2 + (h > 110 ? 1 : 0) + (r() < 0.4 ? 1 : 0) : h > 90 && r() < 0.55 ? 1 : 0;
  let y = podH + 0.32;
  const shaftTop = tiers ? y + (h - y) * (0.55 + r() * 0.15) : h;
  m.prism(x - sx, z - sz, x + sx, z + sz, y, shaftTop, B(0), null, G, 2);
  cap(sx, sz, shaftTop, 3);
  const shaft = { hx: sx, hz: sz, y0: y, y1: shaftTop };
  y = shaftTop + 0.32;
  for (let t = 0; t < tiers; t++) {
    const k = style === 2 ? 0.74 + r() * 0.08 : 0.66 + r() * 0.12;
    sx = Math.max(3, sx * k); sz = Math.max(3, sz * k);
    const yt = t === tiers - 1 ? h : y + (h - y) * (0.42 + r() * 0.2);
    m.prism(x - sx, z - sz, x + sx, z + sz, y, yt, B(0), null, G, 4 + t * 2);
    cap(sx, sz, yt, 5 + t * 2);
    y = yt + 0.32;
  }
  const top = y;

  if (style === 2) {                                          // deco crown: floodlit steps and a pyramid
    const c1x = sx * 0.8, c1z = sz * 0.8, c2x = c1x * 0.68, c2z = c1z * 0.68;
    m.prism(x - c1x, z - c1z, x + c1x, z + c1z, top, top + 3.6, B(4), B(4), G, 20);
    m.prism(x - c2x, z - c2z, x + c2x, z + c2z, top + 3.6, top + 6.8, B(4), null, G, 21);
    const ph = Math.min(c2x, c2z) * (1.2 + r() * 1.4);
    m.pyramid(x, z, c2x, c2z, top + 6.8, ph, B(2), G);
    if (h > 110) mast(props, x, top + 6.8 + ph - 0.5, z, 8 + r() * 18, true);
    return { lot, podH, shaft, top: { hx: sx, hz: sz, y: top } };
  }
  if (style === 0 && h > 140 && r() < 0.55) {                 // glass supertall: a spire
    mast(props, x, top, z, 25 + r() * 45, true);
    roof(props, r, x, z, sx, sz, top, false, 0.5);
  } else {                                                    // plant room and roof clutter
    const px = sx * (0.4 + r() * 0.2), pz = sz * (0.4 + r() * 0.2);
    const ox = (r() - 0.5) * (sx - px), oz = (r() - 0.5) * (sz - pz);
    m.prism(x + ox - px, z + oz - pz, x + ox + px, z + oz + pz, top, top + 4.2, B(3), B(1), G, 22);
    roof(props, r, x, z, sx, sz, top, false);
    if (h > 80 && r() < 0.35) mast(props, x + ox, top + 4.2, z + oz, 6 + r() * 10, h > 100);
  }
  return { lot, podH, shaft, top: { hx: sx, hz: sz, y: top } };
}

function roof(props, r, x, z, hx, hz, y, tank, density = 1) {
  const n = Math.round(Math.min(7, (hx * hz) / 60 + r() * 2) * density);
  for (let i = 0; i < n; i++) {
    props.ac.push([x + (r() * 2 - 1) * Math.max(0, hx - 1.8), y, z + (r() * 2 - 1) * Math.max(0, hz - 1.8), 1.4 + r() * 1.8, 0.9 + r() * 0.8, 1.2 + r() * 1.4, r() < 0.5 ? 0 : Math.PI / 2, curLot]);
  }
  if (tank) props.tanks.push([x + (r() < 0.5 ? -1 : 1) * (hx - 2.6), y, z + (r() < 0.5 ? -1 : 1) * (hz - 2.6), 0.8 + r() * 0.35, curLot]);
}
function mast(props, x, y, z, len, beacon) {
  props.masts.push([x, y, z, len, curLot]);
  if (beacon) props.beacons.push([x, y + len, z, curLot]);
}

export { raise };
const chunkKey = (x, z) => `${Math.floor((x + EDGE) / CHUNK)},${Math.floor((z + EDGE) / CHUNK)}`;

/** The filler skyline. `skip` holds lots that belong to coins: their filler is never raised. */
export function buildBuildings(scene, plan, shared, skip = new Set()) {
  const chunks = new Map(); // key -> { lots, mesh }
  for (const lot of plan.lots) {
    const k = chunkKey(lot.x, lot.z);
    if (!chunks.has(k)) chunks.set(k, { lots: [], mesh: null });
    chunks.get(k).lots.push(lot);
  }
  const props = { ac: [], tanks: [], masts: [], beacons: [] };
  const records = [];
  const material = facadeMaterial(shared);
  const group = new THREE.Group();
  const massOf = (c, into) => { const m = new Mass(); for (const lot of c.lots) if (!skip.has(lot.id)) { const rec = raise(m, lot, into); if (into === props) records[lot.id] = rec; } return m; };
  for (const c of chunks.values()) {
    c.mesh = new THREE.Mesh(massOf(c, props).geometry(), material);
    c.mesh.castShadow = c.mesh.receiveShadow = true;
    group.add(c.mesh);
  }
  scene.add(group);
  /** Clear a lot for a coin: re-mass only its chunk, without it. */
  const clearLot = (lotId) => {
    if (skip.has(lotId)) return;
    skip.add(lotId);
    const lot = plan.lots[lotId], c = chunks.get(chunkKey(lot.x, lot.z));
    const old = c.mesh.geometry;
    c.mesh.geometry = massOf(c, { ac: [], tanks: [], masts: [], beacons: [] }).geometry();
    old.dispose();
    records[lotId] = undefined;
  };
  return { group, records, props, material, clearLot };
}

// ---------- the facade shader ----------

const FACADE = /* glsl */ `
int dpStyle = int(vB.y + 0.5);
int dpK = int(mod(vB.z + 0.5, 10.0));
int dpD = int(floor((vB.z + 0.5) / 10.0));
float dpSeed = vB.x;
vec3 dpAcc = uAccent[dpD];
float dpTone = 0.86 + 0.28 * fract(dpSeed * 91.7);
vec3 dpWall; vec3 dpTrim; float dpWallRough = 0.88;
if (dpStyle == 0) { dpWall = vec3(0.24, 0.28, 0.32); dpTrim = vec3(0.56, 0.59, 0.63); dpWallRough = 0.5; }
else if (dpStyle == 1) { dpWall = vec3(0.5, 0.49, 0.47); dpTrim = vec3(0.52, 0.53, 0.55); }
else if (dpStyle == 2) { dpWall = vec3(0.82, 0.76, 0.64); dpTrim = vec3(0.74, 0.58, 0.3); }
else if (dpStyle == 3) { dpWall = mix(vec3(0.56, 0.3, 0.22), vec3(0.64, 0.41, 0.3), fract(dpSeed * 13.1)); dpTrim = vec3(0.8, 0.75, 0.66); }
else { dpWall = vec3(0.66, 0.64, 0.6); dpTrim = vec3(0.42, 0.44, 0.47); }
float dpG = fract(dpSeed * 7.13);
vec3 dpGlass = dpG < 0.4 ? vec3(0.13, 0.21, 0.29) : dpG < 0.7 ? vec3(0.12, 0.25, 0.26) : dpG < 0.85 ? vec3(0.27, 0.22, 0.16) : vec3(0.15, 0.17, 0.21);
dpWall = pow(dpWall * dpTone, vec3(2.2)); dpGlass = pow(dpGlass, vec3(2.2)); dpTrim = pow(dpTrim, vec3(2.2));

vec3 dpCol = dpWall; float dpRough = dpWallRough; float dpMetal = 0.0; vec3 dpEmit = vec3(0.0);
if (dpK == 0) {
  float y = vFac.y - vF.y;
  if (y < 0.0) {
    // storefronts: glazed bays, a sign band above each, lit shops at night
    float n = max(1.0, floor(vF.x / 5.5));
    float cx = vFac.x / (vF.x / n);
    float fx = fract(cx), bay = floor(cx), gy = vFac.y;
    float wx = fwidth(cx), wy = fwidth(gy);
    float gx = smoothstep(0.08 - wx, 0.08 + wx, fx) - smoothstep(0.92 - wx, 0.92 + wx, fx);
    float glass = gx * (smoothstep(0.35 - wy, 0.35 + wy, gy) - smoothstep(3.55 - wy, 3.55 + wy, gy));
    float band = gx * (smoothstep(3.85 - wy, 3.85 + wy, gy) - smoothstep(4.75 - wy, 4.75 + wy, gy));
    float shopOn = step(dpH(vec3(bay + vF.z * 53.0, 7.0, dpSeed * 1000.0)), 0.8);
    float signOn = step(0.3, dpH(vec3(bay + vF.z * 17.0, 11.0, dpSeed * 800.0)));
    dpCol = mix(dpWall * 0.8, dpGlass * 0.9, glass);
    dpCol = mix(dpCol, vec3(0.015), band);
    dpRough = mix(dpWallRough, 0.1, glass);
    dpMetal = glass * 0.4;
    vec3 shop = mix(vec3(1.0, 0.76, 0.5), vec3(0.95, 0.96, 1.0), dpH(vec3(bay, 3.0, dpSeed * 500.0)));
    dpEmit += shop * glass * shopOn * uLights * 0.8;
    dpEmit += dpAcc * band * signOn * (0.12 + uLights * 1.8);
  } else {
    // windows on a grid fitted to the face; far away they blend to their average so nothing shimmers
    float fh = dpStyle == 3 ? 3.1 : 3.7;
    float tw = dpStyle == 0 ? 1.55 : dpStyle == 3 ? 2.9 : dpStyle == 2 ? 2.2 : 2.5;
    float cw = vF.x / max(1.0, floor(vF.x / tw));
    vec2 cc = vec2(vFac.x / cw, y / fh);
    vec2 f = fract(cc), id = floor(cc), fw = fwidth(cc);
    vec4 wb = dpStyle == 0 ? vec4(0.05, 0.95, 0.12, 0.94)
      : dpStyle == 1 ? vec4(0.16, 0.84, 0.28, 0.86)
      : dpStyle == 2 ? vec4(0.3, 0.7, 0.2, 0.88)
      : dpStyle == 3 ? vec4(0.3, 0.7, 0.26, 0.78)
      : vec4(0.04, 0.96, 0.38, 0.82);
    float ax = smoothstep(wb.x - fw.x, wb.x + fw.x, f.x) - smoothstep(wb.y - fw.x, wb.y + fw.x, f.x);
    float ay = smoothstep(wb.z - fw.y, wb.z + fw.y, f.y) - smoothstep(wb.w - fw.y, wb.w + fw.y, f.y);
    float far = clamp(max(fw.x, fw.y) * 1.6 - 0.35, 0.0, 1.0);
    float win = mix(ax * ay, (wb.y - wb.x) * (wb.w - wb.z), far);
    float cell = dpH(vec3(id.x + vF.z * 131.0, id.y, dpSeed * 1000.0));
    float slot = floor(uTime / 47.0 + cell * 40.0);           // each window re-decides every so often
    float on = step(dpH(vec3(slot, cell * 97.0, 3.0)), vB.w);
    on = mix(on, vB.w, far);
    float tint = dpH(vec3(id.y, id.x, 5.0 + dpSeed));
    vec3 lamp = tint < 0.55 ? vec3(1.0, 0.7, 0.4) : tint < 0.85 ? vec3(0.72, 0.84, 1.0) : vec3(1.0, 0.86, 0.6);
    float dim = mix(0.55 + 0.45 * dpH(vec3(id.x, id.y, 9.0 + dpSeed)), 0.78, far);
    dpCol = mix(dpWall, dpGlass, win);
    dpRough = mix(dpWallRough, 0.07, win);
    dpMetal = win * 0.6;
    dpEmit += lamp * win * on * dim * uLights * 0.95;
  }
} else if (dpK == 1) {
  float rs = fract(dpSeed * 23.7);
  vec3 rc = rs < 0.12 ? vec3(0.36, 0.46, 0.3) : rs < 0.3 ? vec3(0.7, 0.7, 0.68) : rs < 0.62 ? vec3(0.44, 0.44, 0.45) : vec3(0.3, 0.3, 0.32);
  dpCol = pow(rc * dpTone, vec3(2.2)); dpRough = 0.95;
} else if (dpK == 2) {
  dpCol = dpTrim; dpRough = dpStyle == 2 ? 0.35 : 0.6; dpMetal = dpStyle == 2 ? 0.7 : 0.15;
} else if (dpK == 3) {
  dpCol = dpWall * 0.82;
} else {
  dpCol = dpTrim; dpRough = 0.4; dpMetal = dpStyle == 2 ? 0.6 : 0.1;
  dpEmit += dpAcc * uLights * 0.85;
}
dpCol = floor(dpCol * 14.0 + 0.5) / 14.0; dpEmit = floor(dpEmit * 8.0 + 0.5) / 8.0; // posterized: flat, clean colour steps
diffuseColor.rgb = dpCol;
`;

export function facadeMaterial(shared, accentList = null) {
  const accents = (accentList ?? DISTRICTS.map((d) => d.accent)).map((c) => new THREE.Color(c));
  while (accents.length < 9) accents.push(accents[0]);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, envMapIntensity: 1.4 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uLights = shared.lights;
    sh.uniforms.uTime = shared.time;
    sh.uniforms.uAccent = { value: accents };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aB; attribute vec3 aF; attribute vec2 aFac;
varying vec4 vB; varying vec3 vF; varying vec2 vFac;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vB = aB; vF = aF; vFac = aFac;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uLights; uniform float uTime; uniform vec3 uAccent[9];
varying vec4 vB; varying vec3 vF; varying vec2 vFac;
float dpH(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FACADE}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = dpRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = dpMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += dpEmit;');
  };
  mat.customProgramCacheKey = () => 'hermescity-facade-1';
  return mat;
}
