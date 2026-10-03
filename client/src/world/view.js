// Assembles the living town: engine + terrain + architecture + nature + crowd + effects + live socket + camera director.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Engine } from './engine.js';
import { buildCity } from './city.js';
import { buildDowntown, buildStalls, buildRowhouses } from './downtown.js';
import { FirstPerson } from './walk.js';
import { Crowd, PALETTE } from './agents.js';
import { Effects } from './fx.js';
import { hashStr, BANK, LODGING, setMeadow, PARK, setLeisure, setGames, CIVIC, setTown, BLOCKS, frontOf, backOf, forecourt, GAMES_CENTRE, HOUSE_PLOTS, LIBRARY } from './layout.js';
import { api, connectWorld } from '../shared/common.js';

const easeInOut = (x) => x * x * (3 - 2 * x);

export async function createView(canvas, opts = {}) {
  const [defs, feats] = await Promise.all([api('public/skills'), api('public/features').catch(() => ({}))]);
  setMeadow(feats.homes); // Meadowside and the Lodging House are drawn once the city has homes open
  setLeisure(feats.leisure); // and the park by the Garden once it has leisure open
  setGames(feats.games); // and the Games Court once it has games open
  setTown(feats.town); // and the City Hall square once it has the City Hall open
  const stations = defs.skills.map((s) => ({ skill: s.id, name: s.name, station: s.station, color: s.color, x: s.x, z: s.z, trainable: s.trainable, blurb: s.blurb }));
  await Promise.all(['600 64px "Fraunces Variable"', '500 40px "Inter Variable"', '600 40px "JetBrains Mono Variable"'].map((f) => document.fonts.load(f))).catch(() => {});

  const coarse = matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency ?? 8) <= 4;
  const engine = new Engine(canvas, { fixedTime: opts.fixedTime ?? null, quality: opts.quality ?? (coarse ? 'low' : undefined) });
  const city = buildCity(engine.scene, engine.shared, engine.q); // the streets and the skyline
  const town = buildDowntown(engine.scene, stations, engine.shared, engine.q, feats); // every place agents go
  const crowd = new Crowd(engine.scene, engine.shared);
  crowd.skillColor = Object.fromEntries(stations.map((s) => [s.skill, s.color]));
  const fx = new Effects(engine.scene, crowd, { smoke: town.smoke });
  const shops = new THREE.Group(); engine.scene.add(shops);
  const homes = new THREE.Group(); engine.scene.add(homes);
  const { park, garden, civic, built } = town;
  // first person: the solids are every building, stall and townhouse downtown plus every tower lot outside it
  const solids = [...town.solids, ...city.plan.lots.map((l) => ({ x0: l.x - l.w / 2, x1: l.x + l.w / 2, z0: l.z - l.d / 2, z1: l.z + l.d / 2 }))];
  const fp = new FirstPerson(engine.camera, canvas, solids);
  // where a tap or a click sends you: a gold ring that fades as you get there
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.7, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#e0b02a', transparent: true, opacity: 0, depthWrite: false }));
  engine.scene.add(marker);
  fp.onArrive = () => { marker.material.opacity = 0; };
  const lodging = feats.homes ? town.lodging : null;
  let homeGlows = [];
  const homeColor = (id, avatar) => (avatar && Number.isInteger(avatar.body) ? PALETTE[avatar.body] : PALETTE[hashStr(id) % 16]);
  const colorOf = (id) => { const s = crowd.agents.get(id); return s ? `#${s.lookData.body.getHexString()}` : PALETTE[hashStr(id) % 16]; };

  // ---------- camera ----------
  const controls = new OrbitControls(engine.camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.07;
  controls.minDistance = 9; controls.maxDistance = 340; controls.maxPolarAngle = 1.38; controls.minPolarAngle = 0.25;
  controls.screenSpacePanning = false; controls.zoomSpeed = 0.8; controls.rotateSpeed = 0.55;
  controls.target.set(0, 0, 0);
  controls.enabled = opts.interactive !== false;
  if (opts.street) { // a single fixed view at street level (the homepage)
    controls.maxPolarAngle = Math.PI - 0.05; controls.minDistance = 1;
    controls.target.set(...opts.street.at); engine.camera.position.set(...opts.street.from);
  }

  const toward = (b) => { const f = frontOf(b.bx, b.bz); return Math.atan2(f.x, f.z); }; // camera stands in front, looking at the building
  const placeShot = (kind, label, d = 44) => { const b = BLOCKS.find((x) => x.kind === kind); if (!b) return []; const p = forecourt(b, 0.9), c = backOf(b); return [{ t: [c.x, 6, c.z], az: toward(b), el: 1.12, d, label }]; };
  const shots = [
    { t: [0, 2, 0], az: 0.7, el: 0.95, d: 70, label: 'Market Square' },
    { t: [0, 25, 0], az: -0.7, el: 0.95, d: 330, label: 'HermesCity' },
    ...stations.map((s) => { const b = BLOCKS.find((x) => x.skill === s.skill); const c = b ? backOf(b) : s; return { t: [c.x, 6, c.z], az: b ? toward(b) : 0.6, el: 1.1, d: 46, label: s.station, skill: s.skill }; }),
    ...placeShot('library', 'The Skill Library'),
    ...placeShot('bank', 'The Bank'),
    ...placeShot('workshop', 'The Workshop'),
    ...(feats.leisure ? [{ t: [PARK.centre.x, 1, PARK.centre.z], az: Math.PI, el: 0.8, d: 60, label: 'Caduceus Park' }] : []),
    ...(feats.games ? [{ t: [GAMES_CENTRE.x, 1, GAMES_CENTRE.z], az: Math.PI, el: 0.85, d: 40, label: 'The Games Court' }] : []),
    ...(feats.town ? [{ t: [CIVIC.x, 4, CIVIC.z], az: 0, el: 0.95, d: 60, label: 'City Hall' }] : []),
    ...(feats.homes ? [...placeShot('lodging', 'The Lodging House', 60), { t: [HOUSE_PLOTS[0].x, 3, HOUSE_PLOTS[0].z], az: Math.PI, el: 0.95, d: 50, label: HOUSE_PLOTS[0].district }] : []),
  ];
  const director = {
    mode: opts.tour ? 'tour' : 'free', idle: 0, shot: 0, shotT: 0, follow: null,
    from: null, to: null,
    order: opts.tourOrder ?? shots.map((_, i) => i),
    go(i) {
      const s = shots[i]; this.shotT = 0;
      const sph = new THREE.Spherical().setFromVector3(engine.camera.position.clone().sub(controls.target));
      this.from = { t: controls.target.clone(), sph };
      this.to = { t: new THREE.Vector3(...s.t), sph: new THREE.Spherical(s.d, s.el, s.az) };
      let da = this.to.sph.theta - sph.theta; da = Math.atan2(Math.sin(da), Math.cos(da)); this.to.sph.theta = sph.theta + da;
    },
  };
  const view = { engine, crowd, fx, controls, stations, director, town, city, shops, civic, features: feats, onMessage: null, onSelect: null };
  view.currentShot = () => shots[director.order[director.shot % director.order.length]];
  const startInteraction = () => { if (director.mode === 'tour' && opts.interactive !== false) director.mode = 'free'; director.idle = 0; };
  controls.addEventListener('start', startInteraction);
  canvas.addEventListener('wheel', startInteraction, { passive: true });

  view.fp = fp;
  /** First person is how you arrive: walk (you), eyes (through an agent's eyes), or map (the overhead view). */
  view.setMode = (mode) => {
    if (mode === 'walk') {
      if (director.mode === 'map' || director.mode === 'free' || director.mode === 'follow') fp.teleport(controls.target.x, controls.target.z);
      director.mode = 'walk'; controls.enabled = false; fp.active = true;
    } else if (mode === 'map') {
      const p = director.mode === 'eyes' ? crowd.agents.get(director.ride) ?? fp.pos : fp.pos;
      fp.stop(); director.mode = 'free'; controls.enabled = opts.interactive !== false;
      controls.target.set(p.x, 0, p.z); engine.camera.position.set(p.x + 40, 70, p.z + 60);
    }
    engine.camera.fov = director.mode === 'walk' ? 64 : 42; engine.camera.updateProjectionMatrix();
    view.onMode?.(view.mode());
  };
  view.mode = () => (director.mode === 'walk' ? 'walk' : director.mode === 'eyes' ? 'eyes' : 'map');
  /** Ride along behind an agent's eyes. */
  view.ride = (id) => { if (!id) return view.setMode('walk'); fp.stop(); director.mode = 'eyes'; director.ride = id; crowd.selected = id; controls.enabled = false; engine.camera.fov = 64; engine.camera.updateProjectionMatrix(); view.onMode?.('eyes'); };
  /** A person playing walks as themselves: stepping sends them across the city. */
  view.setMe = (id, onStep) => { view.me = id; const s = crowd.agents.get(id); if (s) fp.teleport(s.x, s.z); fp.onStep = id ? onStep : null; };
  view.follow = (id) => {
    if (director.mode === 'walk' || director.mode === 'eyes') { crowd.selected = id; if (!id && director.mode === 'eyes') view.setMode('walk'); return; }
    director.follow = id; director.mode = id ? 'follow' : 'free'; crowd.selected = id;
  };
  view.setTour = (on) => { director.mode = on ? 'tour' : 'free'; director.idle = 0; if (on) director.go(director.order[director.shot % director.order.length]); };
  /** Frame a place from the plaza side at a three-quarter angle, with a short glide. */
  view.focusOn = (x, z, d = 32) => {
    director.mode = 'glide'; director.shotT = 0;
    const sph = new THREE.Spherical().setFromVector3(engine.camera.position.clone().sub(controls.target));
    director.from = { t: controls.target.clone(), sph };
    const to = new THREE.Spherical(d, 0.98, Math.hypot(x, z) > 1 ? Math.atan2(-x, -z) : 0.6);
    let da = to.theta - sph.theta; da = Math.atan2(Math.sin(da), Math.cos(da)); to.theta = sph.theta + da;
    director.to = { t: new THREE.Vector3(x, 2.5, z), sph: to };
  };

  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6 || opts.interactive === false) return;
    const r = canvas.getBoundingClientRect();
    if (document.pointerLockElement === canvas) ptr.set(0, 0); // looking with a locked mouse: aim at the centre
    else ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, engine.camera);
    const id = crowd.pick(ray);
    view.onSelect?.(id);
    if (!id && director.mode === 'walk') { // in first person a click on a station opens it; walking is by keys
      const hit = new THREE.Vector3();
      if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) {
        const st = view.me ? stations.find((s) => s.trainable && Math.hypot(s.x - hit.x, s.z - hit.z) < 9) : null;
        if (st && view.onStation?.(st)) return;
        if (Math.hypot(hit.x - fp.pos.x, hit.z - fp.pos.z) < 160) { fp.walkTo(hit.x, hit.z); marker.position.set(hit.x, 0.09, hit.z); marker.scale.setScalar(1); marker.material.opacity = 0.9; }
      }
    } else if (!id && view.onGround) { // play mode: a click on the ground is a place to walk to
      const hit = new THREE.Vector3();
      if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) view.onGround(hit.x, hit.z);
    }
  });

  // ---------- live socket ----------
  const handle = (m) => {
    if (m.t === 'snapshot') {
      for (const id of [...crowd.agents.keys()]) crowd.remove(id);
      m.agents.forEach((a) => crowd.upsert(a));
      buildStalls(shops, m.shops, colorOf);
      homeGlows = buildRowhouses(homes, m.houses, homeColor, PALETTE);
      if (park) { park.setBeds(m.beds); park.setWall(m.wall); }
      garden?.setTables(m.tables);
      civic?.setWorks(m.works ?? []); civic?.setHall(m.hall); built?.set(m.built);
    } else if (m.t === 'delta') {
      for (const d of m.agents) crowd.move(d);
    } else if (m.t === 'agent') crowd.upsert(m.agent);
    else if (m.t === 'gone') crowd.remove(m.id);
    else if (m.t === 'shops') buildStalls(shops, m.shops, colorOf);
    else if (m.t === 'houses') homeGlows = buildRowhouses(homes, m.houses, homeColor, PALETTE);
    else if (m.t === 'beds') park?.setBeds(m.beds);
    else if (m.t === 'gallery') park?.setWall(m.wall);
    else if (m.t === 'tables') { garden?.setTables(m.tables); view.onTables?.(m.tables); }
    else if (m.t === 'works') civic?.setWorks(m.works);
    else if (m.t === 'hall') civic?.setHall(m.hall);
    else if (m.t === 'projects') built?.set(m.built);
    else if (m.t === 'event') {
      if (m.kind === 'payment' || m.kind === 'direct_paid') coinArcFor(m);
      if (m.kind === 'level_up') fx.levelUp(m.agent, crowd.skillColor[m.skill] ?? '#ffffff');
    } else if (m.t === 'fx' && m.kind === 'xp' && m.passed) fx.xp(m.agent, crowd.skillColor[m.skill] ?? '#ffffff');
    view.onMessage?.(m);
  };
  const coinArcFor = (m) => {
    const from = m.from === 'treasury' ? { x: BANK.x, z: BANK.z } : crowd.agents.get(m.from);
    const to = crowd.agents.get(m.to);
    if (from && to) fx.coinArc(from, to);
  };
  view.disconnect = connectWorld(handle, (up) => opts.onConnection?.(up));

  // ---------- frame ----------
  let glowTick = 0;
  engine.onFrame((dt, t) => {
    crowd.update(dt, t);
    fx.setScale(engine.renderer.domElement.height, engine.camera.fov);
    fx.update(dt, t, engine.night);
    town.update(t, dt, engine.night, engine.dayT);
    city.update(dt);
    if (park && glowTick % 600 === 0) park.tick(); // crops grow
    garden?.face(engine.camera);
    if (++glowTick % 15 === 0) { // lights on in the homes of whoever is in
      const dark = engine.night > 0.15;
      if (civic) for (const g of civic.glows) g.visible = dark;
      for (const g of homeGlows) g.visible = dark && crowd.agents.get(g.userData.owner)?.act === 'home';
      if (lodging) {
        let n = 0; for (const s of crowd.agents.values()) if (s.act === 'home' && Math.hypot(s.x - LODGING.door.x, s.z - LODGING.door.z) < 4) n++;
        const lit = dark ? Math.min(lodging.glows.length, Math.ceil(n / 2)) : 0;
        lodging.glows.forEach((g, i) => { g.visible = ((i * 7) % lodging.glows.length) < lit; });
      }
    }

    if (marker.material.opacity > 0) { marker.material.opacity = Math.max(0, marker.material.opacity - dt * 0.35); marker.scale.multiplyScalar(1 + dt * 0.25); }
    if (director.mode === 'walk') { fp.update(dt); engine.focus.set(fp.pos.x, 0, fp.pos.z); opts.onFrame?.(dt, t); return; }
    if (director.mode === 'eyes') {
      const s = crowd.agents.get(director.ride);
      if (s) { fp.ride(s); engine.focus.set(s.x, 0, s.z); opts.onFrame?.(dt, t); return; }
      view.setMode('walk');
    }
    director.idle += dt;
    if (director.mode === 'free' && opts.idleTour && director.idle > opts.idleTour) view.setTour(true);
    if (director.mode === 'tour' || director.mode === 'glide') {
      if (!director.to) director.go(director.order[director.shot % director.order.length]);
      director.shotT += dt;
      const f = Math.min(1, director.shotT / 3.2), k = easeInOut(f);
      controls.target.lerpVectors(director.from.t, director.to.t, k);
      const sph = new THREE.Spherical(
        director.from.sph.radius + (director.to.sph.radius - director.from.sph.radius) * k,
        director.from.sph.phi + (director.to.sph.phi - director.from.sph.phi) * k,
        director.from.sph.theta + (director.to.sph.theta - director.from.sph.theta) * k + (director.mode === 'tour' ? Math.max(0, director.shotT - 3.2) * 0.035 : 0),
      );
      engine.camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph));
      if (director.mode === 'glide') { if (director.shotT > 3.2) { director.mode = 'free'; director.to = null; } }
      else if (director.shotT > (opts.shotSeconds ?? 11)) { director.shot++; director.go(director.order[director.shot % director.order.length]); }
    } else if (director.mode === 'follow') {
      const s = crowd.agents.get(director.follow);
      if (s) {
        const want = new THREE.Vector3(s.x, 1.4, s.z), delta = want.sub(controls.target).multiplyScalar(Math.min(1, dt * 4));
        controls.target.add(delta); engine.camera.position.add(delta);
      }
    }
    if (!opts.street) {
    controls.target.x = Math.max(-300, Math.min(300, controls.target.x));
    controls.target.z = Math.max(-300, Math.min(300, controls.target.z));
    }
    controls.update();
    engine.focus.copy(controls.target);
    opts.onFrame?.(dt, t);
  });
  // arrive in first person, standing in Market Square facing the fountain (the homepage and tours keep their cameras)
  if (!opts.street && !opts.tour && opts.interactive !== false && opts.mode !== 'map') { fp.start({ x: -19, z: -10, yaw: -Math.PI / 2 }); director.mode = 'walk'; controls.enabled = false; engine.camera.fov = 64; engine.camera.updateProjectionMatrix(); }
  engine.start();
  return view;
}
