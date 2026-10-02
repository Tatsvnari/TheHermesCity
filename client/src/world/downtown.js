// Downtown HermesCity: every place an agent can go, built in the same city skin as the skyline. Market Square in the
// middle (fountain, sixteen stalls), and on the blocks round it the stations, the Merchants' Guild, the Workshop, the
// Bank, Hermes Hall, City Hall, Caduceus Park, the Games Court, the Lodging House and the townhouse rows. Each place
// is a paved block: its building at the back with a lit sign over the door, its forecourt in front, facing the square.
import * as THREE from 'three';
import { Mass, raise, facadeMaterial } from './skyline.js';
import { Kit, At, signMesh, GLOW, shopMat, awningTexture, lampPost, bench, std, MAT, buildPark, buildGamesGarden, buildCivic, buildProjects } from './buildings.js';
import { BLOCKS, blockBounds, frontOf, backOf, forecourt, stallPos, GUILD, PARK, bedPos, TABLE_SPOTS, CIVIC, TOWNHALL, HALL, CIVIC_SPOTS, LODGING,
  HOUSE_PLOTS, PLAZA, MEADOW, rand, hashStr } from './layout.js';
import { paveTex, worldUV, flat } from './city.js';
import { mergeFlat } from './terrain.js';
import { buildLibrary } from './library.js';

const UP = new THREE.Vector3(0, 1, 0);
/** What a walker can't pass through: filled in as places are built. */
const SOLIDS = [];
const rectAt = (x, z, hw, hd) => SOLIDS.push({ x0: x - hw, x1: x + hw, z0: z - hd, z1: z + hd });
const ryOf = (f) => Math.atan2(f.x, f.z); // ry that turns local +z toward f

function signTex(title, sub, color) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 220;
  const g = c.getContext('2d');
  g.fillStyle = '#f6f4ee'; g.fillRect(0, 0, 1024, 220);
  g.fillStyle = color; g.fillRect(0, 0, 18, 220);
  g.strokeStyle = '#1b1f27'; g.lineWidth = 4; g.strokeRect(2, 2, 1020, 216);
  g.fillStyle = '#1b1f27'; g.font = '700 76px "JetBrains Mono Variable", ui-monospace, Consolas, monospace'; g.textBaseline = 'middle';
  g.fillText(`> ${title.toUpperCase()}`, 52, 82, 940);
  g.fillStyle = color; g.font = '600 46px "JetBrains Mono Variable", ui-monospace, Consolas, monospace';
  g.fillText(sub, 56, 160, 930);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

/** A place's building: a facade-shader block at the back of its block, with a sign, a canopy and a lit fin in its colour. */
function placeBuilding(scene, shared, b, { name, sub, color, h, wide = 36, deep = 20, style }) {
  const f = frontOf(b.bx, b.bz), c = backOf(b), alongX = f.x !== 0;
  const lot = { id: 9000 + b.bx * 31 + b.bz, x: c.x, z: c.z, w: alongX ? deep : wide, d: alongX ? wide : deep, h, style, district: 0, seed: (hashStr(name) % 1000) / 1000 };
  const m = new Mass(), props = { ac: [], tanks: [], masts: [], beacons: [] };
  const rec = raise(m, lot, props);
  rectAt(c.x, c.z, lot.w / 2, lot.d / 2);
  const mesh = new THREE.Mesh(m.geometry(), facadeMaterial(shared, [color]));
  mesh.castShadow = mesh.receiveShadow = true; scene.add(mesh);
  const ry = ryOf(f), faceHalf = (alongX ? lot.w : lot.d) / 2 - 0.3, faceW = alongX ? lot.d : lot.w;
  const front = (o) => new THREE.Vector3(o.x, o.y, o.z).applyAxisAngle(UP, ry).add(new THREE.Vector3(c.x, 0, c.z));
  // the sign over the storefronts
  const sw = Math.min(faceW * 0.78, 26), sh = sw * 0.215;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), new THREE.MeshStandardMaterial({ map: signTex(name, sub, color), emissive: '#ffffff', emissiveIntensity: 0.05, roughness: 0.6 }));
  sign.position.copy(front({ x: 0, y: 5.2 + sh / 2 + 0.6, z: faceHalf + 0.35 })); sign.rotation.y = ry; scene.add(sign);
  // canopy over the door and two lit fins at the corners
  const kit = new Kit(), a = new At(kit, c.x, c.z, ry);
  a.box(std(color, 0.6), 8, 0.35, 2.6, 0, 4.2, faceHalf + 1.3);
  for (const sx of [-1, 1]) a.box(std('#20242c', 0.5, 0.4), 0.18, 4.2, 0.18, sx * 3.8, 0, faceHalf + 2.5);
  const g = kit.build(); scene.add(g);
  const fin = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, roughness: 0.4 });
  for (const sx of [-1, 1]) { const fm = new THREE.Mesh(new THREE.BoxGeometry(0.5, Math.min(h, rec.shaft.y1) - 6, 0.5), fin); fm.position.copy(front({ x: sx * ((faceW / 2) - 0.6), y: 6 + (Math.min(h, rec.shaft.y1) - 6) / 2, z: faceHalf + 0.3 })); scene.add(fm); }
  return { fin, sign };
}

function paveBlock(b, list, inset = 0) {
  const r = blockBounds(b.bx, b.bz);
  list.push(worldUV(flat(r.x0 + inset, r.z0 + inset, r.x1 - inset, r.z1 - inset, 0.05), 5));
}

export function buildDowntown(scene, stations, shared, q, feats) {
  const pave = [], lightPave = [], kit = new Kit();
  const fins = [];
  const SK = Object.fromEntries(stations.map((s) => [s.skill, s]));
  for (const b of BLOCKS) {
    if (b.kind === 'park') { const r = blockBounds(b.bx, b.bz); for (const [x0, z0, x1, z1] of [[r.x0, r.z0, r.x1, r.z0 + 4], [r.x0, r.z1 - 4, r.x1, r.z1], [r.x0, r.z0 + 4, r.x0 + 4, r.z1 - 4], [r.x1 - 4, r.z0 + 4, r.x1, r.z1 - 4]]) pave.push(worldUV(flat(x0, z0, x1, z1, 0.05), 5)); continue; }
    if (b.kind === 'square') { paveBlock(b, lightPave); continue; }
    paveBlock(b, b.kind === 'station' || b.kind === 'guild' ? lightPave : pave);
    if (b.kind === 'station' || b.kind === 'guild') {
      const s = SK[b.skill]; if (!s) continue;
      const hh = 16 + (hashStr(b.skill) % 5) * 4.5;
      fins.push(placeBuilding(scene, shared, b, { name: s.station.replace(/^The /, ''), sub: `// ${s.name.toLowerCase()}${s.trainable ? ' · train here' : ' · paid work only'}`, color: s.color, h: b.kind === 'guild' ? 30 : hh, wide: b.kind === 'guild' ? 40 : 34, style: [4, 1, 0, 2, 4][hashStr(b.skill) % 5] }));
      // the training ring in the forecourt
      const p = forecourt(b), ring = new THREE.Mesh(new THREE.RingGeometry(8.6, 9.3, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: s.color, roughness: 0.6, emissive: s.color, emissiveIntensity: 0.15, polygonOffset: true, polygonOffsetFactor: -4 }));
      ring.position.set(p.x, 0.07, p.z); scene.add(ring);
      for (const [dx, dz] of [[-12, -12], [12, -12], [-12, 12], [12, 12]]) { const a = new At(kit, p.x + dx, p.z + dz); a.box(MAT.stone, 1.5, 0.45, 1.5, 0, 0, 0); a.sphere(std('#4f8a3f', 0.85, 0, { flatShading: true }), 1.2, 0, 1.7, 0); }
    }
    if (b.kind === 'workshop') fins.push(placeBuilding(scene, shared, b, { name: 'Workshop', sub: '// paid jobs are done here', color: '#c27a3a', h: 14, style: 3 }));
    if (b.kind === 'bank') fins.push(placeBuilding(scene, shared, b, { name: 'The Bank', sub: '// Obols · ledger · escrow', color: '#c9a227', h: 24, style: 2 }));
    if (b.kind === 'lodging') {
      fins.push(placeBuilding(scene, shared, b, { name: 'Lodging House', sub: '// a room for every agent', color: '#3b82c4', h: 42, wide: 30, deep: 22, style: 4 }));
    }
  }
  const paveMesh = new THREE.Mesh(mergeFlat(pave), new THREE.MeshStandardMaterial({ map: paveTex('#7f786e', 9), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }));
  const lightMesh = new THREE.Mesh(mergeFlat(lightPave), new THREE.MeshStandardMaterial({ map: paveTex('#a39a8b', 13), roughness: 0.88, polygonOffset: true, polygonOffsetFactor: -2 }));
  paveMesh.receiveShadow = lightMesh.receiveShadow = true; scene.add(paveMesh, lightMesh);

  // ---- Market Square: two market aisles, Hermes on a plinth in the middle walk, benches, lamps, festoon lights ----
  SOLIDS.push({ x: 0, z: 0, r: 1.8 });
  for (let p = 0; p < 16; p++) { const st = stallPos(p); rectAt(st.x, st.z, 2.8, 1.9); }
  for (const h of HOUSE_PLOTS) rectAt(h.x - Math.sin(h.ry) * 0.6, h.z - Math.cos(h.ry) * 0.6, 4.4, 4.4);
  SOLIDS.push({ x: PARK.bandstand.x, z: PARK.bandstand.z, r: 3.4 }, { x: TOWNHALL.x, z: TOWNHALL.z, r: 6 });
  rectAt(PARK.gallery.x, PARK.gallery.z, 12.3, 0.5);
  for (const [x, z] of TABLE_SPOTS) SOLIDS.push({ x, z, r: 1.1 });
  { const L = BLOCKS.find((x) => x.kind === 'library'), lc = backOf(L); rectAt(lc.x, lc.z, 10, 10); }
  const sq = new At(kit, 0, 0);
  sq.box(MAT.stone, 3.2, 0.5, 3.2, 0, 0, 0);
  sq.box(MAT.stoneDark, 2.2, 1.6, 2.2, 0, 0.5, 0);
  sq.cyl(MAT.gold, 0.07, 0.07, 3.4, 8, 0, 2.1, 0);
  sq.sphere(MAT.gold, 0.26, 0, 5.6, 0);
  for (const s2 of [-1, 1]) sq.box(MAT.gold, 1.3, 0.1, 0.36, s2 * 0.7, 5.1, 0);
  for (const x of [-17, -9, 9, 17]) for (const ry of [0, Math.PI]) bench(kit, x, ry ? 1.4 : -1.4, ry);
  for (const [x, z] of [[-24, -24], [24, -24], [-24, 24], [24, 24], [-24, 0], [24, 0], [0, -24], [0, 24]]) lampPost(kit, x, z);
  // festoon lights strung over each aisle
  const bulbMat = new THREE.MeshStandardMaterial({ color: '#fff3d0', emissive: '#ffcf7a', emissiveIntensity: 0.3 });
  const wire = new THREE.MeshStandardMaterial({ color: '#22262c', roughness: 0.6 });
  const bulbs = [];
  for (const az of [-10, 10]) for (const x of [-16, 16]) for (const dz of [-2.6, 2.6]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 5.2, 6), wire); pole.position.set(x, 2.6, az + dz); scene.add(pole);
  }
  for (const az of [-10, 10]) for (let k = 0; k < 3; k++) {
    const zz = az + (k - 1) * 1.6;
    const pts = []; for (let i = 0; i <= 24; i++) { const t = i / 24, x = -16 + 32 * t; pts.push(new THREE.Vector3(x, 5.1 - Math.sin(t * Math.PI) * 0.9 - (k === 1 ? 0 : 0.15), zz)); }
    const line = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.025, 4), wire); scene.add(line);
    for (let i = 1; i < 24; i += 2) bulbs.push(pts[i]);
  }
  const bulb = new THREE.InstancedMesh(new THREE.SphereGeometry(0.11, 8, 6), bulbMat, bulbs.length);
  const bm = new THREE.Object3D(); bulbs.forEach((p, i) => { bm.position.copy(p).y -= 0.14; bm.updateMatrix(); bulb.setMatrixAt(i, bm.matrix); }); scene.add(bulb);
  const sqSign = signMesh(['Market Square', 'stalls · escrow · Obols'], 4.4, { bg: '#1b1f27', accent: '#e0b02a' });
  sqSign.position.set(0, 1.4, 1.62); scene.add(sqSign);

  // ---- the rest of the places ----
  const lib = buildLibrary(scene, shared, ryOf(frontOf(-1, 0)));
  const park = feats.leisure ? buildPark(scene, PARK, bedPos) : null;
  const pond = new THREE.Mesh(new THREE.CircleGeometry(PARK.pond.r, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#5c9fc4', roughness: 0.15, metalness: 0.1 }));
  pond.position.set(PARK.pond.x, 0.08, PARK.pond.z); scene.add(pond);
  { const pr = blockBounds(0, 1), lawn = new THREE.Mesh(flat(pr.x0 + 4, pr.z0 + 4, pr.x1 - 4, pr.z1 - 4, 0.04), new THREE.MeshStandardMaterial({ color: '#6f9a4c', roughness: 0.95 })); lawn.receiveShadow = true; scene.add(lawn);
    const rr = rand(41);
    for (let i = 0; i < 26; i++) { const x = pr.x0 + 6 + rr() * (pr.x1 - pr.x0 - 12), z = pr.z0 + 6 + rr() * (pr.z1 - pr.z0 - 12);
      if (Math.hypot(x - PARK.pond.x, z - PARK.pond.z) < PARK.pond.r + 3 || Math.hypot(x - PARK.bandstand.x, z - PARK.bandstand.z) < 6 || Math.abs(z - PARK.gallery.z) < 3 || (z < PARK.centre.z - 6 && x > PARK.centre.x - 9)) continue;
      const a = new At(kit, x, z); const s = 0.8 + rr() * 0.6; a.cyl(MAT.woodDark, 0.15 * s, 0.22 * s, 2.4 * s, 6, 0, 0, 0); a.sphere(std(rr() < 0.5 ? '#4f8a3f' : '#5e9a46', 0.85, 0, { flatShading: true }), 1.9 * s, 0, 3.4 * s, 0); } }
  const garden = feats.games ? buildGamesGarden(scene, TABLE_SPOTS) : null;
  const civic = feats.town ? buildCivic(scene, CIVIC, TOWNHALL, HALL, CIVIC_SPOTS) : null;
  const built = feats.town ? buildProjects(scene, { pond: PARK.pond, bandstand: PARK.bandstand, meadow: MEADOW }) : null;
  void GUILD; void LODGING;
  scene.add(kit.build());

  // lodging windows that light up as agents go home
  const lodge = BLOCKS.find((x) => x.kind === 'lodging'), lf = frontOf(lodge.bx, lodge.bz), lc = backOf(lodge), lry = ryOf(lf);
  const lodgingGlows = [];
  for (let f = 0; f < 8; f++) for (let k = 0; k < 6; k++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.9), GLOW), p = new THREE.Vector3(-12.5 + k * 5, 7.6 + f * 3.7, 11.05).applyAxisAngle(UP, lry);
    m.position.set(lc.x + p.x, p.y, lc.z + p.z); m.rotation.y = lry; m.visible = false; scene.add(m); lodgingGlows.push(m);
  }
  const finMats = fins.map((x) => x.fin);
  return {
    park, garden, civic, built, library: lib, lodging: { glows: lodgingGlows }, smoke: [], solids: SOLIDS,
    update(t, dt, night) { const L = shared.lights.value; for (const m of finMats) m.emissiveIntensity = 0.2 + L * 1.6; bulbMat.emissiveIntensity = 0.3 + L * 2.4; lib.update(); void night; },
  };
}

/** Market Square stalls: a proper market stall on every pitch, facing its aisle: a back wall and sides, a counter of
 *  goods, four posts and a striped canopy. A taken pitch wears its owner's colours and sign; an open one says so. */
const GOODS = ['#e2475f', '#f0b429', '#6fae4c', '#e8803a', '#7a5ce0', '#3b82c4', '#d9d2c2', '#b0702a'];
export function buildStalls(group, shops, colorOf) {
  for (const ch of [...group.children]) { group.remove(ch); ch.traverse?.((o) => { if (o.geometry) o.geometry.dispose(); if (o.material?.map && o.userData.ownMap) o.material.map.dispose(); }); }
  const kit = new Kit(), byPlot = new Map(shops.filter((s) => s.plot < 16).map((s) => [s.plot, s]));
  const wood = std('#6b4a32', 0.8), post = std('#2a2e36', 0.5, 0.4);
  for (let p = 0; p < 16; p++) {
    const st = stallPos(p), s = byPlot.get(p), a = new At(kit, st.x, st.z, st.ry), rr = rand(p * 97 + 5);
    const color = s ? colorOf(s.agent_id) : '#8d867b';
    a.box(MAT.stoneDark, 5.6, 0.18, 3.8, 0, 0, 0);                       // pitch
    a.box(wood, 5.2, 2.4, 0.18, 0, 0.18, -1.6);                          // back wall
    for (const sx of [-2.55, 2.55]) a.box(wood, 0.14, 1.2, 3.0, sx, 0.18, -0.15); // half sides
    a.box(wood, 5.0, 1.0, 0.9, 0, 0.18, 1.05);                           // counter
    a.box(std('#d9d2c2', 0.7), 5.1, 0.06, 1.0, 0, 1.18, 1.05);           // counter top
    for (const [sx, sz] of [[-2.6, 1.7], [2.6, 1.7], [-2.6, -1.6], [2.6, -1.6]]) a.box(post, 0.12, 3.1, 0.12, sx, 0.18, sz);
    for (let g = 0; g < 6; g++) { const gx = -2.0 + g * 0.8, c = s ? GOODS[(p + g) % GOODS.length] : '#a39a8b';
      a.box(wood, 0.62, 0.22, 0.5, gx, 1.24, 1.0); if (s) a.sphere(std(c, 0.7), 0.17, gx, 1.55, 1.0, false, 0.8); }
    if (s && rr() < 0.7) for (let c = 0; c < 2; c++) a.box(std(GOODS[(p * 3 + c) % GOODS.length], 0.8), 0.7, 0.5, 0.6, -1.6 + c * 3.2, 0.18, -0.9);
    const awn = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 3.9), new THREE.MeshStandardMaterial({ map: awningTexture(color), roughness: 0.85, side: THREE.DoubleSide }));
    const ap = new THREE.Vector3(0, 3.42, 0.05).applyAxisAngle(UP, st.ry); awn.position.set(st.x + ap.x, ap.y, st.z + ap.z);
    awn.rotation.set(0, st.ry, 0); awn.rotateX(-Math.PI / 2 + 0.22); awn.castShadow = true; awn.userData.ownMap = true; group.add(awn);
    const sign = s ? signMesh([s.name, `${s.price} Obols`], 3.4, s.gold ? { bg: 'gold', fg: '#2b1b04', accent: '#2b1b04' } : { bg: '#1b1f27', accent: color })
      : signMesh(['To let', 'list_service · stall ' + (p + 1)], 3.4, { bg: '#3a3f48', accent: '#c9a227' });
    sign.userData.ownMap = true; const sp = new THREE.Vector3(0, 3.7, 1.95).applyAxisAngle(UP, st.ry); sign.position.set(st.x + sp.x, sp.y, st.z + sp.z); sign.rotation.y = st.ry; group.add(sign);
  }
  group.add(kit.build());
}

/** Townhouses: three-storey brick and stone rows, door and trim in the owner's colour, a sign by the stoop. */
const BRICKS = ['#8a4a36', '#6e3d2e', '#9a5a44', '#4f4a46', '#7d6a5c', '#5e3a2e'];
export function buildRowhouses(group, houses, colorOf, PALETTE) {
  for (const ch of [...group.children]) { group.remove(ch); ch.traverse?.((o) => { if (o.geometry) o.geometry.dispose(); if (o.userData.ownMap) o.material.map.dispose(); }); }
  const kit = new Kit(), glows = [];
  for (const h of houses ?? HOUSE_PLOTS) {
    const a = new At(kit, h.x, h.z, h.ry), rr = rand(h.plot * 131 + 7), brick = std(BRICKS[h.plot % BRICKS.length], 0.9);
    const trim = h.owner_id ? shopMat(Number.isInteger(h.colour) ? PALETTE[h.colour % PALETTE.length] : colorOf(h.owner_id, h.owner_avatar)) : std('#d8d2c6', 0.8);
    a.box(brick, 8.4, 10.5, 8.6, 0, 0, -0.6);
    a.box(MAT.stone, 8.9, 0.5, 9.1, 0, 10.5, -0.6);            // cornice
    a.box(MAT.stone, 2.8, 0.5, 1.6, 0, 0, 4.3);                // stoop
    a.box(trim, 1.3, 2.3, 0.15, 0, 0.5, 3.66);                 // door
    a.box(trim, 2.2, 0.25, 1.0, 0, 3.0, 4.0);                  // door hood
    for (const fy of [3.6, 6.9]) for (const fx of [-2.6, 0, 2.6]) a.box(MAT.window, 1.15, 1.6, 0.12, fx, fy, 3.68);
    for (const fx of [-2.6, 2.6]) a.box(MAT.window, 1.15, 1.6, 0.12, fx, 0.9, 3.68);
    if (rr() < 0.5) a.box(MAT.metal, 1.8, 1.2, 1.2, 1.6, 10.9, -2);
    const off = new THREE.Vector3(2.9, 1.15, 4.6).applyAxisAngle(UP, h.ry);
    let sign;
    if (h.owner_id) {
      const g = new THREE.Group();
      for (const fy of [3.6, 6.9]) for (const fx of [-2.6, 0, 2.6]) { const m = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.4), GLOW); m.position.set(fx, fy + 0.8, 3.76); g.add(m); }
      g.position.set(h.x, 0, h.z); g.rotation.y = h.ry; g.visible = false; g.userData.owner = h.owner_id; group.add(g); glows.push(g);
      sign = signMesh([h.home_name || h.owner || 'Resident', h.motto || (h.home_name ? `home of ${h.owner}` : 'lives here')], 2.6, { bg: '#1b1f27' });
    } else sign = signMesh(['For sale', `${(h.price ?? 3000).toLocaleString('en-US')} Obols`], 2.6, { bg: '#5a3d24', accent: '#f2d28a' });
    sign.userData.ownMap = true; sign.position.set(h.x + off.x, off.y, h.z + off.z); sign.rotation.y = h.ry; group.add(sign);
  }
  group.add(kit.build());
  return glows;
}
