// Traffic: cars running the lanes of every road, with head- and tail-lights after dusk. Four instanced
// meshes share one matrix buffer, so moving a car is one write.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LANES } from './cityplan.js';
import { rand } from './layout.js';

const PAINT = ['#e9e7e2', '#1c1e22', '#8d949c', '#3b4b63', '#7a2b2b', '#2f5a4a', '#c9c3b6', '#262b33', '#b7472f', '#4a4f57'];
const TAXI = '#f2c230';

export class Traffic {
  constructor(scene, plan, shared, q) {
    const r = rand(404);
    // lanes: right-hand traffic. Along z, +z traffic keeps to -x; along x, +x traffic keeps to +z.
    this.lanes = [];
    for (const rd of plan.roads) {
      for (const o of LANES[rd.kind]) for (const side of [-1, 1]) {
        const off = o * side;
        const dir = rd.axis === 'z' ? (off < 0 ? 1 : -1) : (off > 0 ? 1 : -1);
        const ang = rd.axis === 'x' ? (dir > 0 ? 0 : Math.PI) : (dir > 0 ? -Math.PI / 2 : Math.PI / 2);
        this.lanes.push({ axis: rd.axis, at: rd.at + off, from: rd.from, len: rd.to - rd.from, dir, c: Math.cos(ang), s: Math.sin(ang), fast: rd.kind !== 'street' });
      }
    }
    const weight = this.lanes.map((l) => l.len * (l.fast ? 1.6 : 1));
    const total = weight.reduce((a, b) => a + b, 0);
    const cum = []; let acc = 0; for (const w of weight) cum.push((acc += w / total));

    const n = Math.round(q.cars);
    this.cars = [];
    for (let i = 0; i < n; i++) {
      const u = r(); let li = cum.findIndex((c) => c >= u); if (li < 0) li = this.lanes.length - 1;
      const L = this.lanes[li];
      this.cars.push({ L, s: r() * L.len, v: (L.fast ? 11 : 8) + r() * 5 });
    }

    const body = new THREE.BoxGeometry(4.3, 0.75, 1.85).translate(0, 0.72, 0);
    const cabin = mergeGeometries([new THREE.BoxGeometry(2.2, 0.62, 1.66).translate(-0.25, 1.4, 0), new THREE.BoxGeometry(3.9, 0.42, 1.7).translate(0, 0.3, 0)]);
    const pair = (x, y) => mergeGeometries([-0.62, 0.62].map((z) => new THREE.BoxGeometry(0.1, 0.16, 0.4).translate(x, y, z)));
    this.headMat = new THREE.MeshStandardMaterial({ color: '#fffaf0', emissive: '#fff1d0', emissiveIntensity: 0.3 });
    this.tailMat = new THREE.MeshStandardMaterial({ color: '#5a0d0a', emissive: '#ff2a18', emissiveIntensity: 0.3 });
    this.body = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.55 }), n);
    this.glass = new THREE.InstancedMesh(cabin, new THREE.MeshStandardMaterial({ color: '#14181e', roughness: 0.15, metalness: 0.6 }), n);
    this.heads = new THREE.InstancedMesh(pair(2.16, 0.86), this.headMat, n);
    this.tails = new THREE.InstancedMesh(pair(-2.16, 0.9), this.tailMat, n);
    const c = new THREE.Color();
    this.cars.forEach((_, i) => this.body.setColorAt(i, c.set(r() < 0.14 ? TAXI : PAINT[Math.floor(r() * PAINT.length)])));
    for (const m of [this.glass, this.heads, this.tails]) m.instanceMatrix = this.body.instanceMatrix;
    for (const m of [this.body, this.glass, this.heads, this.tails]) { m.frustumCulled = false; m.count = n; scene.add(m); }
    this.body.castShadow = this.body.receiveShadow = true;
    this.update(0, 0);
  }

  update(dt, lights = 0) {
    const a = this.body.instanceMatrix.array;
    for (let i = 0, o = 0; i < this.cars.length; i++, o += 16) {
      const car = this.cars[i], L = car.L;
      car.s += car.v * dt; if (car.s > L.len) car.s -= L.len;
      const along = L.dir > 0 ? L.from + car.s : L.from + L.len - car.s;
      const x = L.axis === 'z' ? L.at : along, z = L.axis === 'z' ? along : L.at;
      a[o] = L.c; a[o + 1] = 0; a[o + 2] = -L.s; a[o + 3] = 0;
      a[o + 4] = 0; a[o + 5] = 1; a[o + 6] = 0; a[o + 7] = 0;
      a[o + 8] = L.s; a[o + 9] = 0; a[o + 10] = L.c; a[o + 11] = 0;
      a[o + 12] = x; a[o + 13] = 0; a[o + 14] = z; a[o + 15] = 1;
    }
    this.body.instanceMatrix.needsUpdate = true;
    this.headMat.emissiveIntensity = 0.3 + lights * 3.5;
    this.tailMat.emissiveIntensity = 0.3 + lights * 2.4;
  }
}
