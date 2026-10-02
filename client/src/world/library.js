// Hermes Hall, home of the Skill Library: a stone plinth, a glass hall behind gold fins, a winged emblem over the
// door, a lit sign, and a caduceus on a plinth out front. Faces Market Square.
import * as THREE from 'three';
import { LIBRARY } from './layout.js';

const std = (color, roughness = 0.8, metalness = 0, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

function signTex() {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 192;
  const g = c.getContext('2d');
  g.fillStyle = '#10141c'; g.fillRect(0, 0, 1024, 192);
  g.strokeStyle = '#e8b23a'; g.lineWidth = 6; g.strokeRect(8, 8, 1008, 176);
  g.fillStyle = '#f7e7b8'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '700 88px "Fraunces Variable", Georgia, serif'; g.fillText('THE SKILL LIBRARY', 512, 100, 960);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export function buildLibrary(scene, shared, ry = Math.PI) {
  const { x, z } = LIBRARY;
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; g.scale.setScalar(1.5); // front (+z local) faces the square
  const stone = std('#d8d0c2', 0.9), dark = std('#3b4250', 0.6, 0.3), gold = std('#d9a93a', 0.3, 0.9);
  const glass = new THREE.MeshStandardMaterial({ color: '#2a3b4f', roughness: 0.08, metalness: 0.5, emissive: '#ffcf8a', emissiveIntensity: 0 });
  const add = (geo, mat, px, py, pz, ry = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(px, py, pz); m.rotation.y = ry; m.castShadow = m.receiveShadow = true; g.add(m); return m; };
  // plinth and steps
  add(new THREE.BoxGeometry(13, 0.8, 12), stone, 0, 0.4, 0);
  for (let i = 0; i < 3; i++) add(new THREE.BoxGeometry(6.5, 0.27, 0.8), stone, 0, 0.13 + i * 0.27, 6.4 - i * 0.6);
  // the glass hall and its roof slab
  add(new THREE.BoxGeometry(11, 7.2, 10), glass, 0, 0.8 + 3.6, 0);
  add(new THREE.BoxGeometry(12.4, 0.6, 11.4), stone, 0, 0.8 + 7.2 + 0.3, 0);
  add(new THREE.BoxGeometry(8, 2.6, 7), dark, 0, 0.8 + 7.8 + 1.3, 0); // the reading loft on the roof
  add(new THREE.BoxGeometry(8.6, 0.3, 7.6), stone, 0, 0.8 + 7.8 + 2.75, 0);
  // gold fins round the hall
  for (let i = -5; i <= 5; i++) {
    add(new THREE.BoxGeometry(0.16, 7.2, 0.5), gold, i * 1.05, 0.8 + 3.6, 5.1);
    add(new THREE.BoxGeometry(0.16, 7.2, 0.5), gold, i * 1.05, 0.8 + 3.6, -5.1);
  }
  for (let i = -4; i <= 4; i++) { add(new THREE.BoxGeometry(0.5, 7.2, 0.16), gold, 5.6, 0.8 + 3.6, i * 1.1); add(new THREE.BoxGeometry(0.5, 7.2, 0.16), gold, -5.6, 0.8 + 3.6, i * 1.1); }
  // door and the winged emblem above it
  add(new THREE.BoxGeometry(2.4, 3.2, 0.2), dark, 0, 0.8 + 1.6, 5.25);
  add(new THREE.CylinderGeometry(0.55, 0.55, 0.18, 28), gold, 0, 0.8 + 4.6, 5.45).rotation.x = Math.PI / 2;
  const wing = new THREE.Shape(); wing.moveTo(0, 0); wing.quadraticCurveTo(1.6, 0.9, 2.6, 0.45); wing.quadraticCurveTo(1.7, 0.1, 2.3, -0.35); wing.quadraticCurveTo(1.2, -0.2, 0, -0.35);
  const wgeo = new THREE.ExtrudeGeometry(wing, { depth: 0.12, bevelEnabled: false });
  for (const s of [-1, 1]) { const w = add(wgeo, gold, s * 0.45, 0.8 + 4.7, 5.4); w.scale.set(s, 1, 1); }
  // the sign along the roof edge
  const signMat = new THREE.MeshStandardMaterial({ map: signTex(), emissiveMap: null, emissive: '#e8b23a', emissiveIntensity: 0.05, roughness: 0.5 });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(9.6, 1.8), signMat); sign.position.set(0, 0.8 + 7.2 + 0.3, 5.75); g.add(sign);
  // the caduceus out front: a staff, two coiled serpents and wings, on a plinth
  const front = new THREE.Group(); front.position.set(-4.6, 0, 7.8); // beside the steps, clear of the walk g.add(front);
  const fadd = (geo, mat, px, py, pz) => { const m = new THREE.Mesh(geo, mat); m.position.set(px, py, pz); m.castShadow = true; front.add(m); return m; };
  fadd(new THREE.BoxGeometry(1.6, 1.2, 1.6), stone, 0, 0.6, 0);
  fadd(new THREE.CylinderGeometry(0.07, 0.07, 3.6, 10), gold, 0, 1.2 + 1.8, 0);
  fadd(new THREE.SphereGeometry(0.2, 16, 10), gold, 0, 1.2 + 3.7, 0);
  for (const ph of [0, Math.PI]) {
    const pts = []; for (let i = 0; i <= 60; i++) { const t = i / 60, a = ph + t * Math.PI * 5; pts.push(new THREE.Vector3(Math.cos(a) * 0.32 * (1 - t * 0.35), 1.4 + t * 2.6, Math.sin(a) * 0.32 * (1 - t * 0.35))); }
    fadd(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 80, 0.055, 6), gold, 0, 0, 0);
  }
  for (const s of [-1, 1]) { const w = fadd(wgeo, gold, s * 0.12, 1.2 + 3.3, -0.06); w.scale.set(s * 0.45, 0.45, 1); }
  // reading lamps inside (lit at night) and a warm floor
  add(new THREE.BoxGeometry(10.4, 0.05, 9.4), std('#7a5a40', 0.7), 0, 0.83, 0);
  scene.add(g);
  return {
    group: g,
    update() { const L = shared.lights.value; glass.emissiveIntensity = 0.05 + L * 0.55; signMat.emissiveIntensity = 0.05 + L * 0.5; },
  };
}
