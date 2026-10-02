// Renderer, sky, day/night, lights, shadows, post-processing and quality tiers.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { storage } from '../shared/common.js';

export const QUALITY = {
  high: { dpr: 2, shadow: 4096, shadowSpan: 75, grass: 90000, bloom: true, msaa: 4, trees: 1, cars: 320 },
  balanced: { dpr: 1.5, shadow: 2048, shadowSpan: 62, grass: 40000, bloom: true, msaa: 4, trees: 0.8, cars: 220 },
  low: { dpr: 1, shadow: 1024, shadowSpan: 55, grass: 10000, bloom: false, msaa: 0, trees: 0.55, cars: 110 },
};

const CYCLE_S = 24 * 60; // one in-world day every 24 minutes, the same for every viewer
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerpColor = (out, stops, x) => {
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i], [b, cb] = stops[i + 1];
    if (x >= a && x <= b) return out.copy(ca).lerp(cb, (x - a) / (b - a || 1));
  }
  return out.copy(x < stops[0][0] ? stops[0][1] : stops[stops.length - 1][1]);
};
const C = (h) => new THREE.Color(h);
/** Render scale: the canvas is drawn at this fraction of its size and shown with image-rendering: pixelated. */
export const PIXEL = 0.55;

export class Engine {
  constructor(canvas, { quality, fixedTime = null, onQuality, fixedSize = null } = {}) {
    this.canvas = canvas;
    this.fixedSize = fixedSize; // [w, h] for offline rendering (the film)
    this.fixedTime = fixedTime;
    this.onQuality = onQuality;
    this.frameHooks = [];
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.15, 4000);
    this.camera.position.set(-40, 48, 78);

    // sky
    this.sky = new Sky();
    this.sky.scale.setScalar(3000);
    Object.assign(this.sky.material.uniforms.turbidity, { value: 5.5 });
    this.sky.material.uniforms.rayleigh.value = 1.4;
    this.sky.material.uniforms.mieCoefficient.value = 0.004;
    this.sky.material.uniforms.mieDirectionalG.value = 0.82;
    this.scene.add(this.sky);
    this.stars = makeStars();
    this.scene.add(this.stars);
    this.scene.fog = new THREE.Fog(0xcfe0ea, 260, 1150);

    // lights
    this.hemi = new THREE.HemisphereLight(0xdfeeff, 0x4a5a3a, 0.9);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.035;
    this.scene.add(this.sun, this.sun.target);
    this.moon = new THREE.DirectionalLight(0x9fb4ff, 0);
    this.scene.add(this.moon, this.moon.target);

    // environment lighting from the sky, refreshed as the sun moves
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envScene = new THREE.Scene();
    this.envSky = new Sky(); this.envSky.scale.setScalar(1000);
    this.envScene.add(this.envSky);
    this.envTarget = null; this.envElev = 999;

    // post
    this.focus = new THREE.Vector3(15, 0, 0);
    this.night = 0; this.elev = 30; this.dayT = 0.35;
    this.shared = { time: { value: 0 }, night: { value: 0 }, lights: { value: 0 }, sunDir: { value: new THREE.Vector3(0, 1, 0) } };
    const wanted = quality ?? storage('hc_quality') ?? 'auto';
    this.auto = wanted === 'auto';
    this.setQuality(this.auto ? 'balanced' : wanted, false);
    this.clock = new THREE.Clock();
    this.frameTimes = [];
    if (!fixedSize) addEventListener('resize', () => this.resize());
    this.resize();
  }

  setQuality(name, persist = true) {
    this.qualityName = QUALITY[name] ? name : 'balanced';
    this.q = QUALITY[this.qualityName];
    if (persist) { storage('hc_quality', name); this.auto = name === 'auto'; }
    this.sun.shadow.mapSize.set(this.q.shadow, this.q.shadow);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    const cam = this.sun.shadow.camera, s = this.q.shadowSpan;
    Object.assign(cam, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 420 });
    cam.updateProjectionMatrix();
    this.buildComposer();
    this.resize();
    this.onQuality?.(this.qualityName, this.q);
  }

  buildComposer() {
    this.composer?.dispose();
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: this.q.msaa });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = this.q.bloom ? new UnrealBloomPass(new THREE.Vector2(256, 256), 0.35, 0.6, 0.86) : null;
    if (this.bloom) this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  resize() {
    const [w, h] = this.fixedSize ?? [this.canvas.clientWidth || innerWidth, this.canvas.clientHeight || innerHeight];
    const dpr = (this.fixedSize ? 1 : Math.min(devicePixelRatio || 1, this.q.dpr)) * PIXEL; // under full resolution, upscaled crisp: the city's pixel look
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 0..1 through the in-world day. */
  dayPhase() {
    if (this.fixedTime != null) return this.fixedTime;
    return ((Date.now() / 1000) % CYCLE_S) / CYCLE_S;
  }

  updateSky() {
    const t = this.dayPhase();
    const s = Math.sin(2 * Math.PI * (t - 0.25));
    const elev = 30 + 45 * s; // degrees; night is roughly a quarter of the cycle
    const az = 180 + 360 * t;
    this.elev = elev; this.dayT = t;
    const night = 1 - smooth(-8, 6, elev);
    const golden = 1 - smooth(4, 26, elev);
    this.night = night;
    this.shared.night.value = night;
    this.shared.lights.value = 1 - smooth(-4, 11, elev); // windows, signs and street lamps come up through dusk

    const phi = THREE.MathUtils.degToRad(90 - elev), theta = THREE.MathUtils.degToRad(az);
    const sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    this.shared.sunDir.value.copy(sunDir);
    this.sky.material.uniforms.sunPosition.value.copy(sunDir);
    this.sky.material.uniforms.rayleigh.value = 1.2 + golden * 1.6;
    this.sky.material.uniforms.turbidity.value = 5 + golden * 4;

    // sun follows the view so shadows stay crisp where people are looking
    const f = this.focus, texel = (this.q.shadowSpan * 2) / this.q.shadow;
    const fx = Math.round(f.x / texel) * texel, fz = Math.round(f.z / texel) * texel;
    const dir = sunDir.clone(); if (dir.y < 0.12) dir.y = 0.12; dir.normalize();
    this.sun.position.set(fx + dir.x * 200, dir.y * 200, fz + dir.z * 200);
    this.sun.target.position.set(fx, 0, fz);
    this.sun.intensity = 3.4 * smooth(-2, 12, elev) * (1 - golden * 0.3);
    lerpColor(this.sun.color, [[-5, C('#ff9a5c')], [8, C('#ffb27a')], [25, C('#fff1dc')], [90, C('#fff8ee')]], elev);
    this.sun.castShadow = elev > -1;

    this.moon.position.set(fx - dir.x * 200, 160, fz - dir.z * 200);
    this.moon.target.position.set(fx, 0, fz);
    this.moon.intensity = 0.55 * night;

    this.hemi.intensity = 0.42 + 0.22 * (1 - night) - golden * 0.08;
    lerpColor(this.hemi.color, [[-10, C('#34426a')], [4, C('#f0b89a')], [20, C('#dfeeff')], [90, C('#e8f2ff')]], elev);
    lerpColor(this.hemi.groundColor, [[-10, C('#1c2330')], [10, C('#5b4a3a')], [30, C('#4c5a3c')]], elev);

    const fog = this.scene.fog;
    lerpColor(fog.color, [[-12, C('#131a2a')], [-2, C('#3b3f5c')], [6, C('#e6b594')], [18, C('#d9dfe0')], [40, C('#cfe0ea')]], elev);
    this.renderer.toneMappingExposure = 0.8 + night * 0.35;
    this.stars.material.opacity = smooth(0.35, 0.95, night);
    if (this.bloom) { this.bloom.strength = 0.28 + night * 0.55; this.bloom.threshold = 0.9 - night * 0.25; }

    if (Math.abs(elev - this.envElev) > 3) {
      this.envElev = elev;
      const u = this.envSky.material.uniforms;
      u.sunPosition.value.copy(sunDir.y < 0.02 ? new THREE.Vector3(sunDir.x, 0.02, sunDir.z) : sunDir);
      u.rayleigh.value = this.sky.material.uniforms.rayleigh.value;
      u.turbidity.value = this.sky.material.uniforms.turbidity.value;
      this.envTarget?.dispose();
      this.envTarget = this.pmrem.fromScene(this.envScene, 0.02);
      this.scene.environment = this.envTarget.texture;
    }
    this.scene.environmentIntensity = 0.32 * (1 - night) + 0.06;
  }

  onFrame(fn) { this.frameHooks.push(fn); }

  start() {
    const loop = () => {
      requestAnimationFrame(loop);
      if (document.hidden || this.paused) { this.clock.getDelta(); return; }
      const dt = Math.min(this.clock.getDelta(), 0.1);
      const t = this.clock.elapsedTime;
      this.shared.time.value = t;
      this.updateSky();
      for (const fn of this.frameHooks) fn(dt, t);
      this.composer.render(dt);
      this.measure(dt);
    };
    requestAnimationFrame(loop);
  }

  /** Auto quality: after a short warm-up, step down if frames are slow, up if there is headroom. */
  measure(dt) {
    if (!this.auto) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 150) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)];
    this.frameTimes = [];
    const order = ['low', 'balanced', 'high'], i = order.indexOf(this.qualityName);
    if (med > 1 / 38 && i > 0) this.setQuality(order[i - 1], false);
    else if (med < 1 / 110 && i < 2 && (devicePixelRatio || 1) > 1.2) this.setQuality(order[i + 1], false);
    else this.auto = false; // settled
  }
}

function makeStars() {
  const n = 1800, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random(), v = Math.random() * 0.48 + 0.02;
    const th = u * Math.PI * 2, ph = Math.acos(1 - v * 2) * 0.5;
    const r = 1400;
    pos.set([Math.sin(ph) * Math.cos(th) * r, Math.cos(ph) * r, Math.sin(ph) * Math.sin(th) * r], i * 3);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({ color: 0xdfe8ff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
  const p = new THREE.Points(g, m); p.renderOrder = 1;
  return p;
}
