// Ground, roads, plaza paving, station pads and market lots.
import * as THREE from 'three';
import { heightAt, fbm, noise, roads, PLAZA, STATION_PAD, rand } from './layout.js';

function canvasTex(size, draw, repeat = 1) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

/** Warm cobblestones: jittered grid of rounded stones with mortar. */
export function cobbleTexture(base = [196, 184, 164], seed = 7) {
  const r = rand(seed);
  return canvasTex(512, (g, S) => {
    g.fillStyle = `rgb(${base.map((v) => v - 58).join(',')})`; g.fillRect(0, 0, S, S);
    const n = 10, cell = S / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n * 1.4; x++) {
      const w = cell * (0.62 + r() * 0.3), h = cell * (0.7 + r() * 0.2);
      const cx = (x * cell * 0.72 + (y % 2) * cell * 0.36) % S, cy = y * cell + cell / 2 + (r() - 0.5) * 4;
      const k = 0.82 + r() * 0.3;
      g.fillStyle = `rgb(${base.map((v) => Math.min(255, v * k) | 0).join(',')})`;
      for (const ox of [0, -S, S]) {
        g.beginPath(); g.roundRect(cx + ox - w / 2, cy - h / 2, w, h, 9); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.06)'; g.beginPath(); g.roundRect(cx + ox - w / 2 + 3, cy - h / 2 + 2, w - 8, h * 0.35, 6); g.fill();
        g.fillStyle = `rgb(${base.map((v) => Math.min(255, v * k) | 0).join(',')})`;
      }
    }
  });
}

export function buildTerrain(scene, stations, quality) {
  const group = new THREE.Group();

  // ---- ground ----
  const SIZE = 1700, SEG = quality === 'low' ? 120 : 200;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  geo.translate(13, 0, 0);
  const pos = geo.attributes.position, colors = new Float32Array(pos.count * 3);
  const grassA = new THREE.Color('#5f8f45'), grassB = new THREE.Color('#86a957'), dry = new THREE.Color('#9c9a5c'), rock = new THREE.Color('#8a8578'), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), h = heightAt(x, z);
    pos.setY(i, h);
    const n = fbm(x * 0.03, z * 0.03);
    c.copy(grassA).lerp(grassB, n);
    c.lerp(dry, Math.max(0, noise(x * 0.012 + 9, z * 0.012) - 0.55) * 1.4);
    c.lerp(rock, Math.min(1, Math.max(0, (h - 26) / 18)) * 0.8);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 }));
  ground.receiveShadow = true;
  group.add(ground);

  // ---- roads: one merged mesh, UVs in world space so the cobbles line up ----
  const cobble = cobbleTexture();
  const roadMat = new THREE.MeshStandardMaterial({ map: cobble, roughness: 0.88, color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -2 });
  const parts = [];
  const worldUV = (g, scale) => {
    const p = g.attributes.position, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / scale; uv[i * 2 + 1] = p.getZ(i) / scale; }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  };
  for (const s of roads(stations)) {
    const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z, len = Math.hypot(dx, dz);
    const strip = new THREE.PlaneGeometry(len, s.w, Math.max(1, Math.round(len / 2)), 1);
    strip.rotateX(-Math.PI / 2);
    strip.rotateY(-Math.atan2(dz, dx));
    strip.translate((s.a.x + s.b.x) / 2, 0.035, (s.a.z + s.b.z) / 2);
    parts.push(worldUV(strip, 4));
    for (const e of [s.a, s.b]) { const cap = new THREE.CircleGeometry(s.w / 2, 16); cap.rotateX(-Math.PI / 2); cap.translate(e.x, 0.034, e.z); parts.push(worldUV(cap, 4)); }
  }
  // plaza, station pads, market lots
  const disc = (x, z, r, y = 0.04) => { const d = new THREE.CircleGeometry(r, 48); d.rotateX(-Math.PI / 2); d.translate(x, y, z); return worldUV(d, 4); };
  parts.push(disc(PLAZA.x, PLAZA.z, PLAZA.r));
  for (const s of stations) if (s.skill !== 'commerce' && s.skill !== 'pathfinding') parts.push(disc(s.x, s.z, STATION_PAD - 0.5));
  parts.push(disc(stations.find((s) => s.skill === 'pathfinding').x, stations.find((s) => s.skill === 'pathfinding').z + 10.5, 3.2));
  for (const side of [-1, 1]) {
    const lot = new THREE.PlaneGeometry(56, 8); lot.rotateX(-Math.PI / 2); lot.translate(45, 0.036, side * 9); parts.push(worldUV(lot, 4));
  }
  const guild = new THREE.PlaneGeometry(16, 16); guild.rotateX(-Math.PI / 2); guild.translate(86, 0.036, 0); parts.push(worldUV(guild, 4));
  const merged = mergeFlat(parts);
  const roadMesh = new THREE.Mesh(merged, roadMat);
  roadMesh.receiveShadow = true;
  group.add(roadMesh);

  // plaza inlay: a compass rose ring in darker stone
  const ringMat = new THREE.MeshStandardMaterial({ map: cobbleTexture([150, 140, 128], 11), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -3 });
  for (const [r0, r1] of [[10.6, 11.4], [4.6, 5.1]]) {
    const ring = worldUV(new THREE.RingGeometry(r0, r1, 64).rotateX(-Math.PI / 2).translate(0, 0.045, 0), 4);
    const m = new THREE.Mesh(ring, ringMat); m.receiveShadow = true; group.add(m);
  }
  for (let i = 0; i < 8; i++) {
    const ray = new THREE.PlaneGeometry(0.35, 5.4); ray.rotateX(-Math.PI / 2); ray.translate(0, 0.046, 7.9); ray.rotateY((i / 8) * Math.PI * 2);
    const m = new THREE.Mesh(worldUV(ray, 4), ringMat); m.receiveShadow = true; group.add(m);
  }

  scene.add(group);
  return group;
}

/** Merge non-indexed-compatible geometries with position/normal/uv only. */
export function mergeFlat(geos) {
  const list = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0; for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3);
    if (!g.attributes.normal) g.computeVertexNormals();
    nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}
