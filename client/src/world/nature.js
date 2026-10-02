// Grass, trees, flowers, rocks and water. Everything instanced; wind runs in the vertex shader.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { heightAt, townRadius, fbm, rand, GARDEN, POND } from './layout.js';

/** Inject wind sway into a standard material. `amp` scales with vertex height above `base`. */
function windy(mat, shared, { amp = 0.15, height = 1, freq = 1.6 } = {}) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = shared.time;
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vec4 ewRoot = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      float ewH = clamp(position.y / ${height.toFixed(2)}, 0.0, 1.5);
      float ewW = sin(uTime * ${freq.toFixed(2)} + ewRoot.x * 0.21 + ewRoot.z * 0.17) * 0.6 + sin(uTime * ${(freq * 2.3).toFixed(2)} + ewRoot.x * 0.7) * 0.25;
      transformed.x += ewW * ewH * ewH * ${amp.toFixed(3)};
      transformed.z += ewW * ewH * ewH * ${(amp * 0.6).toFixed(3)};`);
  };
  mat.customProgramCacheKey = () => `windy-${amp}-${height}-${freq}`;
  return mat;
}

const dummy = new THREE.Object3D();

export function buildNature(scene, mask, shared, q) {
  const group = new THREE.Group();
  const r = rand(20240928);

  // ---------- grass ----------
  const blade = new THREE.BufferGeometry();
  {
    const H = 0.62, W = 0.075, pts = [[-W, 0], [W, 0], [-W * 0.7, H * 0.45], [W * 0.7, H * 0.45], [0, H]];
    blade.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap(([x, y]) => [x, y, 0]), 3));
    blade.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
    const shade = pts.map(([, y]) => 0.5 + (y / H) * 0.62);
    blade.setAttribute('color', new THREE.Float32BufferAttribute(shade.flatMap((s) => [s, s, s]), 3));
    blade.computeVertexNormals();
    const n = blade.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0.25); // soft, lit from above
  }
  const grassMat = windy(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }), shared, { amp: 0.22, height: 0.62, freq: 1.9 });
  const count = q.grass;
  const grass = new THREE.InstancedMesh(blade, grassMat, count);
  const gc = new THREE.Color(), gA = new THREE.Color('#5d8f3e'), gB = new THREE.Color('#9dbb5a');
  let placed = 0, tries = 0;
  while (placed < count && tries++ < count * 6) {
    const a = r() * Math.PI * 2, d = placed < count * 0.8 ? Math.sqrt(r()) * 92 : 92 + r() * 50;
    const x = 18 + Math.cos(a) * d * 1.18, z = Math.sin(a) * d;
    if (mask.blocked(x, z, 0.25)) continue;
    const clump = fbm(x * 0.08, z * 0.08);
    if (clump < 0.36 && r() < 0.6) continue;
    dummy.position.set(x, heightAt(x, z), z);
    dummy.rotation.set(0, r() * Math.PI, 0);
    const s = 0.5 + clump * 0.55 + r() * 0.25;
    dummy.scale.set(0.9, s, 0.9);
    dummy.updateMatrix();
    grass.setMatrixAt(placed, dummy.matrix);
    grass.setColorAt(placed, gc.copy(gA).lerp(gB, fbm(x * 0.04 + 5, z * 0.04)));
    placed++;
  }
  grass.count = placed;
  grass.receiveShadow = true;
  group.add(grass);

  // ---------- flowers (meadow + garden beds) ----------
  const petal = new THREE.IcosahedronGeometry(0.13, 0); petal.translate(0, 0.42, 0);
  const stem = new THREE.CylinderGeometry(0.018, 0.018, 0.42, 3); stem.translate(0, 0.21, 0);
  const flowerMat = windy(new THREE.MeshStandardMaterial({ roughness: 0.6 }), shared, { amp: 0.12, height: 0.5, freq: 1.7 });
  const stemMat = windy(new THREE.MeshStandardMaterial({ color: '#4b7a36', roughness: 0.8 }), shared, { amp: 0.12, height: 0.5, freq: 1.7 });
  const FC = ['#f2d24b', '#f08a7a', '#ffffff', '#c89bea', '#f5a64a', '#e95d7c'];
  const nf = Math.round(3200 * q.trees);
  const flowers = new THREE.InstancedMesh(petal, flowerMat, nf), stems = new THREE.InstancedMesh(stem, stemMat, nf);
  let nfp = 0; tries = 0;
  while (nfp < nf && tries++ < nf * 8) {
    const inGarden = nfp < nf * 0.35;
    let x, z;
    if (inGarden) { const a = r() * Math.PI * 2, d = Math.sqrt(r()) * GARDEN.r; x = GARDEN.x + Math.cos(a) * d; z = GARDEN.z + Math.sin(a) * d; }
    else { const a = r() * Math.PI * 2, d = 20 + Math.sqrt(r()) * 90; x = 18 + Math.cos(a) * d * 1.18; z = Math.sin(a) * d; if (fbm(x * 0.05 + 11, z * 0.05) < 0.55) continue; }
    if (mask.blocked(x, z, 0.3)) continue;
    dummy.position.set(x, heightAt(x, z), z); dummy.rotation.set(0, r() * 6, 0); dummy.scale.setScalar(0.8 + r() * 0.6); dummy.updateMatrix();
    flowers.setMatrixAt(nfp, dummy.matrix); stems.setMatrixAt(nfp, dummy.matrix);
    flowers.setColorAt(nfp, gc.set(inGarden ? FC[(Math.floor(x / 2.2) + Math.floor(z / 2.2) * 3 + 99) % FC.length] : FC[Math.floor(r() * FC.length)]));
    nfp++;
  }
  flowers.count = stems.count = nfp;
  group.add(flowers, stems);

  // ---------- trees ----------
  const trunkGeo = new THREE.CylinderGeometry(0.2, 0.32, 2.4, 7); trunkGeo.translate(0, 1.2, 0);
  const blobs = [];
  for (const [x, y, z, s] of [[0, 3.3, 0, 1.55], [0.85, 2.8, 0.3, 1.1], [-0.8, 2.9, -0.2, 1.15], [0.1, 4.2, -0.3, 1.05], [-0.2, 2.7, 0.9, 0.95]]) {
    const b = new THREE.IcosahedronGeometry(s, 1); b.translate(x, y, z); blobs.push(b);
  }
  const flat = (g) => (g.index ? g.toNonIndexed() : g);
  const crownGeo = mergeGeometries(blobs.map(flat));
  crownGeo.computeVertexNormals();
  const pine = mergeGeometries([[0, 2.2, 1.9, 2.6], [0, 3.6, 1.5, 2.2], [0, 4.8, 1.05, 1.9]].map(([, y, rad, h]) => { const c = new THREE.ConeGeometry(rad, h, 8); c.translate(0, y, 0); return flat(c); }));
  pine.computeVertexNormals();
  const barkMat = new THREE.MeshStandardMaterial({ color: '#6b4d36', roughness: 0.9 });
  const leafMat = windy(new THREE.MeshStandardMaterial({ roughness: 0.75, flatShading: true }), shared, { amp: 0.09, height: 4.5, freq: 1.1 });
  const pineMat = windy(new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true }), shared, { amp: 0.06, height: 5.5, freq: 0.9 });
  const N_DEC = Math.round(520 * q.trees), N_PINE = Math.round(420 * q.trees);
  const trunks = new THREE.InstancedMesh(trunkGeo, barkMat, N_DEC + N_PINE);
  const crowns = new THREE.InstancedMesh(crownGeo, leafMat, N_DEC);
  const pines = new THREE.InstancedMesh(pine, pineMat, N_PINE);
  const LEAF = ['#4f8a3c', '#6a9a3f', '#3f7a45', '#86a843', '#5c8f52'], PINE = ['#2f5e45', '#3a6b4a', '#2b5540', '#44704c'];
  let nd = 0, np = 0, nt = 0; tries = 0;
  const plant = (x, z, kind, scale) => {
    const y = heightAt(x, z);
    dummy.position.set(x, y - 0.05, z); dummy.rotation.set(0, r() * 6.28, 0); dummy.scale.setScalar(scale); dummy.updateMatrix();
    trunks.setMatrixAt(nt++, dummy.matrix);
    if (kind === 'pine') { pines.setMatrixAt(np, dummy.matrix); pines.setColorAt(np++, gc.set(PINE[Math.floor(r() * PINE.length)])); }
    else { crowns.setMatrixAt(nd, dummy.matrix); crowns.setColorAt(nd++, gc.set(LEAF[Math.floor(r() * LEAF.length)]).offsetHSL(0, 0, (r() - 0.5) * 0.06)); }
  };
  while ((nd < N_DEC || np < N_PINE) && tries++ < 40000) {
    const a = r() * Math.PI * 2, d = 96 + Math.pow(r(), 0.8) * 130;
    const x = 18 + Math.cos(a) * d * 1.18, z = Math.sin(a) * d;
    const rr = townRadius(x, z);
    const pineish = rr > 150 || fbm(x * 0.02, z * 0.02) > 0.55;
    if (fbm(x * 0.035 + 4, z * 0.035) < 0.4 && r() < 0.7) continue; // clearings
    if (pineish && np < N_PINE) plant(x, z, 'pine', 1.1 + r() * 1.1);
    else if (!pineish && nd < N_DEC) plant(x, z, 'dec', 1 + r() * 0.8);
  }
  // town trees: along roads and around the plaza, never on anything
  tries = 0; let town = 0;
  while (town < 70 * q.trees && tries++ < 4000) {
    const a = r() * Math.PI * 2, d = 14 + Math.sqrt(r()) * 72;
    const x = 18 + Math.cos(a) * d * 1.18, z = Math.sin(a) * d;
    if (mask.blocked(x, z, 2.6) || nd >= N_DEC) continue;
    plant(x, z, r() < 0.2 && np < N_PINE ? 'pine' : 'dec', 0.8 + r() * 0.5); town++;
  }
  trunks.count = nt; crowns.count = nd; pines.count = np;
  for (const m of [trunks, crowns, pines]) { m.castShadow = true; m.receiveShadow = true; group.add(m); }

  // ---------- rocks ----------
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshStandardMaterial({ color: '#8d8a82', roughness: 0.95, flatShading: true }), 160);
  let nr = 0; tries = 0;
  while (nr < 160 && tries++ < 3000) {
    const a = r() * Math.PI * 2, d = 60 + r() * 160, x = 18 + Math.cos(a) * d * 1.18, z = Math.sin(a) * d;
    if (mask.blocked(x, z, 1.5)) continue;
    dummy.position.set(x, heightAt(x, z) + 0.1, z); dummy.rotation.set(r(), r() * 6, r()); const s = 0.4 + r() * r() * 2.4; dummy.scale.set(s, s * 0.6, s * (0.8 + r() * 0.4)); dummy.updateMatrix();
    rocks.setMatrixAt(nr, dummy.matrix); rocks.setColorAt(nr++, gc.set('#8d8a82').offsetHSL(0, 0, (r() - 0.5) * 0.1));
  }
  rocks.count = nr; rocks.castShadow = rocks.receiveShadow = true; group.add(rocks);

  // ---------- pond ----------
  const water = waterMaterial(shared);
  const pond = new THREE.Mesh(new THREE.CircleGeometry(POND.r, 48).rotateX(-Math.PI / 2), water);
  pond.position.set(POND.x, 0.06, POND.z); group.add(pond);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(POND.r + 0.15, 0.32, 8, 48).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#a8a296', roughness: 0.9 }));
  rim.position.set(POND.x, 0.08, POND.z); rim.scale.y = 0.6; rim.receiveShadow = true; group.add(rim);
  for (let i = 0; i < 7; i++) { // lily pads
    const a = r() * 6.28, d = r() * (POND.r - 1);
    const pad = new THREE.Mesh(new THREE.CircleGeometry(0.42, 12, 0.3, 5.7).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#4f8f45', roughness: 0.6 }));
    pad.position.set(POND.x + Math.cos(a) * d, 0.08, POND.z + Math.sin(a) * d); pad.rotation.y = r() * 6; group.add(pad);
  }

  scene.add(group);
  return { group, water };
}

/** Stylised water: depth tint, animated ripples, fresnel sky reflection and a sun glint. */
export function waterMaterial(shared) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime: shared.time, uSun: shared.sunDir, uNight: shared.night },
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uSun; uniform float uNight; varying vec3 vW;
      void main(){
        vec2 p = vW.xz;
        float a = sin(p.x*2.1 + uTime*1.3) + sin(p.y*2.7 - uTime*1.1) + sin((p.x+p.y)*3.3 + uTime*1.7)*0.6;
        float b = cos(p.x*2.6 - uTime*0.9) + cos(p.y*1.9 + uTime*1.4);
        vec3 n = normalize(vec3(a*0.06, 1.0, b*0.06));
        vec3 v = normalize(cameraPosition - vW);
        float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
        vec3 deep = mix(vec3(0.07,0.26,0.32), vec3(0.02,0.05,0.10), uNight);
        vec3 sky = mix(vec3(0.62,0.80,0.92), vec3(0.10,0.14,0.26), uNight);
        vec3 col = mix(deep, sky, 0.25 + fres*0.6);
        vec3 h = normalize(normalize(uSun) + v);
        col += vec3(1.0,0.92,0.75) * pow(max(dot(n,h),0.0), 180.0) * 2.2 * (1.0-uNight);
        gl_FragColor = vec4(col, 0.86);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
