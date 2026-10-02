// Effects: coin arcs, level-up beams and bursts, chimney smoke, fountain spray, fireflies.
import * as THREE from 'three';

const v = new THREE.Vector3(), q = new THREE.Quaternion(), s1 = new THREE.Vector3(1, 1, 1), m4 = new THREE.Matrix4(), col = new THREE.Color();

function softDot() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** A pool of camera-facing soft particles with per-particle colour, size and alpha. */
class Particles {
  constructor(scene, n, { additive = true, tex } = {}) {
    this.n = n; this.i = 0;
    this.pos = new Float32Array(n * 3); this.vel = new Float32Array(n * 3); this.life = new Float32Array(n); this.max = new Float32Array(n);
    this.col = new Float32Array(n * 3); this.size = new Float32Array(n); this.alpha = new Float32Array(n); this.grav = new Float32Array(n); this.grow = new Float32Array(n); this.amul = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: false,
      uniforms: { map: { value: tex ?? softDot() }, scale: { value: 800 } },
      vertexShader: `attribute float size; attribute float alpha; varying vec3 vC; varying float vA;
        uniform float scale;
        void main(){ vC = color; vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; varying vec3 vC; varying float vA;
        void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vC, t.a * vA); if (gl_FragColor.a < 0.01) discard; }`,
      vertexColors: true,
    });
    this.points = new THREE.Points(g, mat); this.points.frustumCulled = false; scene.add(this.points);
  }
  emit(x, y, z, vx, vy, vz, life, color, size, grav = 0, grow = 0, alpha = 1) {
    const i = this.i = (this.i + 1) % this.n;
    this.pos.set([x, y, z], i * 3); this.vel.set([vx, vy, vz], i * 3);
    this.life[i] = life; this.max[i] = life; col.set(color); this.col.set([col.r, col.g, col.b], i * 3); this.amul[i] = alpha;
    this.size[i] = size; this.grav[i] = grav; this.grow[i] = grow; this.alpha[i] = 1;
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const k = i * 3;
      this.vel[k + 1] -= this.grav[i] * dt;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      const f = this.life[i] / this.max[i];
      this.alpha[i] = Math.min(1, f * 2.5) * Math.min(1, (1 - f) * 8 + 0.2) * this.amul[i];
      this.size[i] += this.grow[i] * dt;
    }
    for (const a of ['position', 'color', 'size', 'alpha']) this.geo.attributes[a].needsUpdate = true;
  }
}

export class Effects {
  constructor(scene, crowd, { smoke = [], lamps = [] } = {}) {
    this.scene = scene; this.crowd = crowd; this.smokeSources = smoke;
    this.glow = new Particles(scene, 1400, { additive: true });
    this.smoke = new Particles(scene, 260, { additive: false });
    this.coinsMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.22, 0.06, 20).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: '#f2c44c', metalness: 0.9, roughness: 0.25, emissive: '#6b4a00', emissiveIntensity: 0.6 }), 200);
    this.coinsMesh.count = 0; this.coinsMesh.frustumCulled = false; scene.add(this.coinsMesh);
    this.flights = [];
    this.beams = [];
    this.beamGeo = new THREE.CylinderGeometry(0.9, 0.9, 22, 32, 1, true).translate(0, 11, 0);
    const c = document.createElement('canvas'); c.width = 4; c.height = 128;
    const g = c.getContext('2d'), gr = g.createLinearGradient(0, 128, 0, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 4, 128);
    this.beamTex = new THREE.CanvasTexture(c);
    this.acc = 0; this.fireflyAcc = 0;
  }

  /** Point sprites are sized in world units: pass the drawing-buffer height and vertical fov. */
  setScale(heightPx, fovDeg) { const k = (heightPx * 0.5) / Math.tan((fovDeg * Math.PI) / 360); this.glow.points.material.uniforms.scale.value = k; this.smoke.points.material.uniforms.scale.value = k; }

  coinArc(from, to) {
    if (!from || !to) return;
    for (let k = 0; k < 4; k++) this.flights.push({ a: { x: from.x, z: from.z }, to, t: -k * 0.1, dur: 1.15 });
  }

  xp(agent, color, big = false) {
    const s = this.crowd.agents.get(agent); if (!s) return;
    for (let i = 0; i < (big ? 70 : 16); i++) {
      const a = Math.random() * Math.PI * 2, sp = big ? 2 + Math.random() * 4 : 0.6 + Math.random() * 1.2;
      this.glow.emit(s.x + Math.cos(a) * 0.4, 1.2 + Math.random(), s.z + Math.sin(a) * 0.4, Math.cos(a) * sp, (big ? 3 : 1.6) + Math.random() * 2, Math.sin(a) * sp, big ? 1.8 : 1.1, color, big ? 0.55 : 0.32, big ? 3 : 0.5);
    }
  }

  levelUp(agent, color) {
    const s = this.crowd.agents.get(agent); if (!s) return;
    const mat = new THREE.MeshBasicMaterial({ map: this.beamTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
    const beam = new THREE.Mesh(this.beamGeo, mat); beam.position.set(s.x, 0, s.z); this.scene.add(beam);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.6, 0.9, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    ring.position.set(s.x, 0.1, s.z); this.scene.add(ring);
    this.beams.push({ beam, ring, t: 0, id: agent });
    this.xp(agent, color, true);
  }

  update(dt, t, night) {
    // coins
    let n = 0;
    for (let j = this.flights.length - 1; j >= 0; j--) {
      const f = this.flights[j]; f.t += dt;
      if (f.t >= f.dur) { this.flights.splice(j, 1); this.glow.emit(f.to.x, 1.6, f.to.z, 0, 1.5, 0, 0.5, '#ffd76a', 0.5); continue; }
      if (f.t < 0 || n >= 200) continue;
      const u = f.t / f.dur, e = u * u * (3 - 2 * u);
      v.set(f.a.x + (f.to.x - f.a.x) * e, 1.8 + Math.sin(u * Math.PI) * 5.5, f.a.z + (f.to.z - f.a.z) * e);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, f.t * 14);
      this.coinsMesh.setMatrixAt(n++, m4.compose(v, q, s1));
      if (Math.random() < 0.5) this.glow.emit(v.x, v.y, v.z, 0, -0.3, 0, 0.45, '#ffcf5a', 0.22);
    }
    this.coinsMesh.count = n; this.coinsMesh.instanceMatrix.needsUpdate = true;

    // level-up beams
    for (let j = this.beams.length - 1; j >= 0; j--) {
      const b = this.beams[j]; b.t += dt;
      const s = this.crowd.agents.get(b.id);
      if (s) { b.beam.position.set(s.x, 0, s.z); b.ring.position.set(s.x, 0.1, s.z); }
      const f = b.t / 2.4;
      b.beam.material.opacity = Math.max(0, 1 - f) * Math.min(1, b.t * 5);
      b.beam.scale.set(1 - f * 0.5, 0.3 + Math.min(1, b.t * 2) * 0.7, 1 - f * 0.5);
      b.ring.scale.setScalar(1 + b.t * 7); b.ring.material.opacity = Math.max(0, 1 - b.t / 1.2);
      if (b.t > 2.4) { this.scene.remove(b.beam, b.ring); b.beam.material.dispose(); b.ring.material.dispose(); b.ring.geometry.dispose(); this.beams.splice(j, 1); }
    }

    // chimney smoke and fountain spray
    this.acc += dt;
    while (this.acc > 0.12) {
      this.acc -= 0.12;
      for (const c of this.smokeSources) this.smoke.emit(c.x + (Math.random() - 0.5) * 0.4, c.y, c.z + (Math.random() - 0.5) * 0.4, 0.3 + Math.random() * 0.2, 0.9 + Math.random() * 0.4, 0.08, 4, night > 0.5 ? '#4a4a52' : '#d8d4ce', 0.55, -0.05, 0.75, 0.32);
      for (let k = 0; k < 3; k++) { const a = Math.random() * Math.PI * 2; this.glow.emit(Math.cos(a) * 0.3, 4.4, Math.sin(a) * 0.3, Math.cos(a) * 1.3, 2.2 + Math.random(), Math.sin(a) * 1.3, 0.9, '#bfe3ff', 0.16, 9.8, 0, 0.5); }
    }
    // fireflies over the garden and meadows at night
    if (night > 0.4) {
      this.fireflyAcc += dt * night * 10;
      while (this.fireflyAcc > 1) {
        this.fireflyAcc -= 1;
        const a = Math.random() * Math.PI * 2, d = 6 + Math.random() * 60;
        this.glow.emit(Math.cos(a) * d + 4, 0.6 + Math.random() * 2, Math.sin(a) * d + 18, (Math.random() - 0.5) * 0.6, (Math.random() - 0.3) * 0.3, (Math.random() - 0.5) * 0.6, 4, '#d9ff7a', 0.28);
      }
    }
    this.glow.update(dt); this.smoke.update(dt);
  }
}
