// Characters: every body part is one InstancedMesh; limbs are posed per frame from the agent's activity.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hashStr } from './layout.js';

export const PALETTE = ['#d9644a', '#4f7cc9', '#4f9e6b', '#d8a13a', '#8a67c7', '#d6729c', '#3a9ea0', '#e0873d',
  '#7f9a3a', '#5a5fa8', '#c0506e', '#4aa3d8', '#9a6b45', '#5cc08a', '#a55fd0', '#6d7a8c'];
const SKIN = ['#f1cfb2', '#e2b08a', '#b98361', '#8a5a3f', '#5f3d2a'];
const MAX = 600;

const m4 = new THREE.Matrix4(), root = new THREE.Matrix4(), part = new THREE.Matrix4(), tmp = new THREE.Matrix4();
const q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), sc = new THREE.Vector3(1, 1, 1), col = new THREE.Color();

function capsule(r, len, drop) { const g = new THREE.CapsuleGeometry(r, len, 6, 12); g.translate(0, drop, 0); return g; }

export class Crowd {
  constructor(scene, shared) {
    this.scene = scene; this.shared = shared;
    this.agents = new Map();
    this.byIndex = [];
    const mk = (geo, mat, n = MAX, shadow = true) => {
      const m = new THREE.InstancedMesh(geo, mat, n); m.count = 0; m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.castShadow = shadow; m.receiveShadow = true; scene.add(m); return m;
    };
    const cloth = new THREE.MeshStandardMaterial({ roughness: 0.62 });
    const skin = new THREE.MeshStandardMaterial({ roughness: 0.5 });
    const torsoGeo = capsule(0.3, 0.36, 0); torsoGeo.scale(1.06, 1, 0.84);
    this.torso = mk(torsoGeo, cloth);
    this.head = mk(new THREE.SphereGeometry(0.29, 24, 16), skin);
    this.eyes = mk(new THREE.SphereGeometry(0.042, 8, 6), new THREE.MeshStandardMaterial({ color: '#1b1d22', roughness: 0.2 }), MAX * 2, false);
    this.arms = mk(capsule(0.085, 0.44, -0.3), cloth, MAX * 2);
    this.hands = mk(new THREE.SphereGeometry(0.085, 10, 8).translate(0, -0.6, 0), skin, MAX * 2, false);
    this.legs = mk(capsule(0.115, 0.4, -0.32), new THREE.MeshStandardMaterial({ roughness: 0.7 }), MAX * 2);
    const beanie = mergeGeometries([new THREE.SphereGeometry(0.31, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 1.92, 0), new THREE.SphereGeometry(0.08, 10, 8).translate(0, 2.25, 0)]);
    const top = mergeGeometries([new THREE.CylinderGeometry(0.2, 0.21, 0.42, 20).translate(0, 2.27, 0), new THREE.CylinderGeometry(0.36, 0.36, 0.04, 24).translate(0, 2.07, 0)]);
    const wizard = mergeGeometries([new THREE.ConeGeometry(0.29, 0.78, 20).translate(0, 2.42, 0), new THREE.CylinderGeometry(0.42, 0.42, 0.03, 24).translate(0, 2.05, 0)]);
    const cap = mergeGeometries([new THREE.SphereGeometry(0.305, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 1.9, 0), new THREE.BoxGeometry(0.34, 0.03, 0.22).translate(0, 1.93, 0.3)]);
    const hatMat = new THREE.MeshStandardMaterial({ roughness: 0.7 });
    const crownParts = [new THREE.CylinderGeometry(0.27, 0.25, 0.16, 24, 1, true).translate(0, 2.08, 0), new THREE.TorusGeometry(0.26, 0.03, 6, 24).rotateX(Math.PI / 2).translate(0, 2.0, 0)];
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; crownParts.push(new THREE.ConeGeometry(0.055, 0.17, 6).translate(Math.cos(a) * 0.25, 2.24, Math.sin(a) * 0.25), new THREE.SphereGeometry(0.035, 8, 6).translate(Math.cos(a) * 0.25, 2.33, Math.sin(a) * 0.25)); }
    const crown = mergeGeometries(crownParts.map((g) => (g.index ? g.toNonIndexed() : g)));
    const straw = mergeGeometries([new THREE.CylinderGeometry(0.52, 0.52, 0.03, 28).translate(0, 2.0, 0), new THREE.CylinderGeometry(0.25, 0.29, 0.22, 20).translate(0, 2.12, 0)]);
    const beret = new THREE.SphereGeometry(0.33, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2); beret.scale(1.05, 0.42, 1.05); beret.rotateZ(0.18); beret.translate(0.04, 2.02, 0);
    // the $CITY store's hats: 8 halo, 9 antlers, 10 laurel crown
    const halo = new THREE.TorusGeometry(0.23, 0.045, 10, 36); halo.rotateX(Math.PI / 2 - 0.3); halo.translate(0, 2.3, -0.04);
    const antlerParts = [];
    for (const s of [-1, 1]) {
      const beam = new THREE.CylinderGeometry(0.026, 0.04, 0.46, 6); beam.rotateZ(-s * 0.55); beam.translate(s * 0.2, 2.24, 0); antlerParts.push(beam);
      for (const [dy, dx, r] of [[0.08, 0.1, 0.9], [0.2, 0.2, 0.2]]) { const t = new THREE.CylinderGeometry(0.016, 0.024, 0.2, 5); t.rotateZ(-s * r); t.translate(s * (0.2 + dx), 2.24 + dy, 0); antlerParts.push(t); }
    }
    const antlers = mergeGeometries(antlerParts.map((g) => (g.index ? g.toNonIndexed() : g)));
    const laurelParts = [];
    for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2; const leaf = new THREE.SphereGeometry(0.07, 8, 6); leaf.scale(1, 0.45, 0.55); leaf.rotateY(-a); leaf.translate(Math.cos(a) * 0.27, 2.06 + (i % 2) * 0.03, Math.sin(a) * 0.27); laurelParts.push(leaf); }
    const laurel = mergeGeometries(laurelParts.map((g) => (g.index ? g.toNonIndexed() : g)));
    for (const g of [beanie, top, wizard, cap, crown, straw, beret, halo, antlers, laurel]) g.translate(0, -1.86, 0); // pivot hats on the head centre
    const crownMat = new THREE.MeshStandardMaterial({ color: '#e2b84f', metalness: 0.85, roughness: 0.28, emissive: '#5a3d00', emissiveIntensity: 0.35 });
    this.hats = [null, mk(beanie, hatMat), mk(top, hatMat), mk(wizard, hatMat), mk(cap, hatMat), mk(crown, crownMat), mk(straw, new THREE.MeshStandardMaterial({ color: '#e8cf8a', roughness: 0.85 })), mk(beret, hatMat),
      mk(halo, new THREE.MeshStandardMaterial({ color: '#ffc629', emissive: '#e89a00', emissiveIntensity: 0.55, metalness: 0.3, roughness: 0.35 })), mk(antlers, new THREE.MeshStandardMaterial({ color: '#8a6a4a', roughness: 0.8 })), mk(laurel, crownMat)];
    // accessories: 1 scarf, 2 round glasses, 3 backpack (all pivot on the torso)
    const scarf = new THREE.TorusGeometry(0.27, 0.075, 8, 24); scarf.rotateX(Math.PI / 2); scarf.translate(0, 1.56, 0);
    const lens = (x) => new THREE.TorusGeometry(0.065, 0.013, 6, 18).translate(x, 1.9, 0.285);
    const glasses = mergeGeometries([lens(-0.1), lens(0.1), new THREE.BoxGeometry(0.07, 0.012, 0.012).translate(0, 1.9, 0.29)].map((g) => (g.index ? g.toNonIndexed() : g)));
    const pack = mergeGeometries([new THREE.BoxGeometry(0.46, 0.52, 0.22).translate(0, 1.2, -0.33), new THREE.BoxGeometry(0.36, 0.16, 0.1).translate(0, 1.02, -0.47)].map((g) => (g.index ? g.toNonIndexed() : g)));
    this.accs = [null, mk(scarf, new THREE.MeshStandardMaterial({ roughness: 0.8 })), mk(glasses, new THREE.MeshStandardMaterial({ color: '#1b1d22', roughness: 0.3, metalness: 0.5 }), MAX, false), mk(pack, new THREE.MeshStandardMaterial({ roughness: 0.75 }))];
    this.parcels = mk(new THREE.BoxGeometry(0.5, 0.38, 0.4), new THREE.MeshStandardMaterial({ color: '#c49058', roughness: 0.8 }));
    // soft contact shadow keeps feet grounded even where the shadow map is coarse
    const blobTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32); gr.addColorStop(0, 'rgba(0,0,0,0.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
    this.blobs = mk(new THREE.PlaneGeometry(1.3, 1.3).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }), MAX, false);
    this.blobs.receiveShadow = false; this.blobs.renderOrder = 1;
    // training aura: a glowing ring in the skill's colour
    this.auras = mk(new THREE.RingGeometry(0.62, 0.78, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }), MAX, false);
    // selection marker
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.85, 0.97, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }));
    this.marker.visible = false; scene.add(this.marker);
    this.selected = null;
    this.skillColor = {};
  }

  look(a) {
    const h = hashStr(a.id);
    const body = new THREE.Color(PALETTE[a.avatar?.body ?? h % 16]);
    return {
      body, legs: body.clone().multiplyScalar(0.55).lerp(new THREE.Color('#2a2f3a'), 0.45),
      skin: new THREE.Color(SKIN[(h >>> 5) % SKIN.length]),
      hat: a.avatar?.hat ?? (h >>> 9) % 5, acc: a.avatar?.acc ?? 0, accColor: new THREE.Color(PALETTE[(h >>> 17) % 16]), hatColor: [5, 8, 9, 10].includes(a.avatar?.hat) ? new THREE.Color('#ffffff') : new THREE.Color(PALETTE[(h >>> 13) % 16]).multiplyScalar(0.9), scale: a.role === 'mayor' ? 1.1 : 1,
    };
  }

  upsert(a) {
    let s = this.agents.get(a.id);
    if (!s) {
      s = { id: a.id, x: a.x ?? 0, z: a.z ?? 0, tx: a.x ?? 0, tz: a.z ?? 0, ry: a.ry ?? 0, act: a.act ?? 'idle', phase: hashStr(a.id) % 100, walk: 0, head: new THREE.Vector3(), speed: 0 };
      this.agents.set(a.id, s);
    }
    Object.assign(s, { handle: a.handle, role: a.role, stars: a.stars, level: a.level, lookData: this.look(a) });
    if (a.x !== undefined) { s.tx = a.x; s.tz = a.z; if (a.act) s.act = a.act; }
    return s;
  }
  remove(id) { this.agents.delete(id); if (this.selected === id) this.selected = null; }
  move(d) { const s = this.agents.get(d.id); if (!s) return null; s.tx = d.x; s.tz = d.z; const changed = s.act !== d.act; s.act = d.act; return changed ? s : null; }

  update(dt, t) {
    let i = 0, hatN = this.hats.map(() => 0), accN = [0, 0, 0, 0], p = 0, au = 0;
    const k = 1 - Math.exp(-dt * 9);
    for (const s of this.agents.values()) {
      if (i >= MAX) break;
      const dx = s.tx - s.x, dz = s.tz - s.z, d = Math.hypot(dx, dz);
      if (d > 14) { s.x = s.tx; s.z = s.tz; } else { s.x += dx * k; s.z += dz * k; }
      const moving = d > 0.06;
      if (moving) { const want = Math.atan2(dx, dz); let diff = want - s.ry; diff = Math.atan2(Math.sin(diff), Math.cos(diff)); s.ry += diff * Math.min(1, dt * 10); }
      s.walk += ((moving ? 1 : 0) - s.walk) * Math.min(1, dt * 6);
      s.phase += dt * (6 + 3 * s.walk);
      const L = s.lookData, act = s.act ?? 'idle';
      if (act === 'home' && !moving) continue; // indoors
      const working = act.startsWith('working:') || act === 'leisure:gardening' || act === 'leisure:painting', training = act.startsWith('training:'), carrying = act === 'carrying', talking = act === 'talking';
      const sw = Math.sin(s.phase * 1.25);
      const bob = s.walk * Math.abs(Math.cos(s.phase * 1.25)) * 0.07 + (1 - s.walk) * Math.sin(t * 1.8 + s.phase) * 0.012;

      root.compose(v.set(s.x, bob, s.z), q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.ry), sc.set(L.scale ?? 1, L.scale ?? 1, L.scale ?? 1));
      const put = (mesh, idx, px, py, pz, rx = 0, rz = 0, color) => {
        part.compose(v.set(px, py, pz), q.setFromEuler(e.set(rx, 0, rz)), one);
        tmp.multiplyMatrices(root, part); mesh.setMatrixAt(idx, tmp); if (color) mesh.setColorAt(idx, color);
      };
      // torso leans a little into the walk; head tilts while studying
      put(this.torso, i, 0, 1.16, 0, s.walk * 0.06 + (working ? 0.12 : 0), 0, L.body);
      const headTilt = training ? Math.sin(t * 0.8 + s.phase) * 0.12 + 0.18 : talking ? Math.sin(t * 7) * 0.06 : 0;
      put(this.head, i, 0, 1.86, 0.02, headTilt, 0, L.skin);
      const eyeY = 1.9 - headTilt * 0.25, eyeZ = 0.265;
      put(this.eyes, i * 2, -0.1, eyeY, eyeZ, headTilt); put(this.eyes, i * 2 + 1, 0.1, eyeY, eyeZ, headTilt);
      let aL = -sw * 0.55 * s.walk, aR = sw * 0.55 * s.walk, zL = 0.08, zR = -0.08;
      if (working) { aR = -1.5 + Math.sin(t * 9 + s.phase) * 0.55; aL = -0.7; }
      else if (training) { aL = aR = -0.95 + Math.sin(t * 1.4 + s.phase) * 0.06; zL = 0.25; zR = -0.25; }
      else if (carrying) { aL = aR = -1.35; zL = 0.22; zR = -0.22; }
      else if (act === 'waving') { aR = -2.7 + Math.sin(t * 9) * 0.35; zR = -0.35; }
      else if (act === 'leisure:playing') { aL = aR = -0.85 + Math.sin(t * 1.1 + s.phase) * 0.05; zL = 0.2; zR = -0.2; }
      else if (act === 'leisure:fishing') { aL = aR = -1.05 + Math.sin(t * 0.9 + s.phase) * 0.05; zL = 0.12; zR = -0.12; }
      else if (act === 'leisure:music') { aR = -2.1 + Math.sin(t * 7) * 0.45; aL = -2.1 + Math.sin(t * 7 + Math.PI) * 0.45; zL = 0.3; zR = -0.3; }
      else if (talking) { aR = -0.7 + Math.sin(t * 5 + s.phase) * 0.35; }
      else if (s.walk < 0.2) { aL = Math.sin(t * 1.3 + s.phase) * 0.04; aR = -aL; }
      put(this.arms, i * 2, -0.39, 1.5, 0, aL, zL, L.body); put(this.arms, i * 2 + 1, 0.39, 1.5, 0, aR, zR, L.body);
      put(this.hands, i * 2, -0.39, 1.5, 0, aL, zL, L.skin); put(this.hands, i * 2 + 1, 0.39, 1.5, 0, aR, zR, L.skin);
      put(this.legs, i * 2, -0.14, 0.8, 0, sw * 0.62 * s.walk, 0, L.legs); put(this.legs, i * 2 + 1, 0.14, 0.8, 0, -sw * 0.62 * s.walk, 0, L.legs);
      const hm = this.hats[L.hat];
      if (hm) { const hi = hatN[L.hat]++; put(hm, hi, 0, 1.86, 0.02, headTilt, 0, L.hatColor); }
      const am = this.accs[L.acc];
      if (am) { const ai = accN[L.acc]++; if (L.acc === 2) put(am, ai, 0, 0, 0.02, headTilt * 0.4); else put(am, ai, 0, 0, 0, 0, 0, L.acc === 3 ? L.legs : L.accColor); }
      if (carrying) put(this.parcels, p++, 0, 1.3, 0.52);
      this.blobs.setMatrixAt(i, m4.makeTranslation(s.x, 0.05, s.z));
      if (training) {
        const skill = act.slice(9), c = this.skillColor[skill] ?? '#ffffff';
        const pulse = 1 + Math.sin(t * 3 + s.phase) * 0.08;
        this.auras.setMatrixAt(au, m4.compose(v.set(s.x, 0.07, s.z), q.identity(), v.clone().set(pulse, 1, pulse)));
        this.auras.setColorAt(au++, col.set(c));
      }
      s.head.set(s.x, (2.35 + bob + (L.hat === 3 ? 0.35 : L.hat === 2 || L.hat === 5 ? 0.2 : 0)) * (L.scale ?? 1), s.z);
      this.byIndex[i] = s.id;
      i++;
    }
    for (const mesh of [this.torso, this.head, this.blobs]) mesh.count = i;
    for (const mesh of [this.eyes, this.arms, this.hands, this.legs]) mesh.count = i * 2;
    this.hats.forEach((m, j) => { if (m) m.count = hatN[j]; });
    this.accs.forEach((m, j) => { if (m) m.count = accN[j]; });
    this.parcels.count = p; this.auras.count = au;
    for (const m of [this.torso, this.head, this.eyes, this.arms, this.hands, this.legs, this.parcels, this.blobs, this.auras, ...this.hats.filter(Boolean), ...this.accs.filter(Boolean)]) {
      m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    const sel = this.selected && this.agents.get(this.selected);
    this.marker.visible = !!sel;
    if (sel) { this.marker.position.set(sel.x, 0.08, sel.z); const sc = 1 + Math.sin(t * 4) * 0.06; this.marker.scale.set(sc, 1, sc); }
  }

  pick(raycaster) {
    let best = null;
    for (const mesh of [this.torso, this.head]) {
      mesh.boundingSphere = null; mesh.computeBoundingSphere();
      const hit = raycaster.intersectObject(mesh)[0];
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    return best ? this.byIndex[best.instanceId] : null;
  }
}
