// First person: the way into HermesCity. Walk at eye height with WASD (or the arrow keys), look with the mouse (click to
// lock, Esc to unlock) or by dragging, Shift to run. On a touch screen (and with a mouse) a tap on the
// ground walks you there and a drag looks. Buildings, stalls, the fountain and the townhouses are solid. "Through their eyes" puts the camera behind any
// agent's eyes and walks with them; a person playing walks as themselves.
import * as THREE from 'three';
import { placeAt as blockPlace, PITCH, EDGE, DT_EDGE } from './layout.js';

const EYE = 1.68, WALK = 5.5, RUN = 14, BODY = 0.4, CELL = 32, LOOK = 0.0022;
const cellKey = (x, z) => `${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;

/** Where you are, in words. */
export function whereAt(x, z) {
  const b = blockPlace(Math.round(x / PITCH), Math.round(z / PITCH));
  if (b) return b.kind === 'station' || b.kind === 'guild' ? `${b.skill === 'commerce' ? "the Merchants' Guild" : b.skill}` : b.name ?? b.district ?? 'downtown';
  return Math.abs(x) < DT_EDGE && Math.abs(z) < DT_EDGE ? 'downtown' : 'the outer city';
}

export class FirstPerson {
  /** solids: [{x0, x1, z0, z1}] rectangles and [{x, z, r}] circles a person can't walk into. */
  constructor(camera, canvas, solids) {
    this.camera = camera; this.canvas = canvas;
    this.pos = new THREE.Vector3(); this.yaw = 0; this.pitch = 0; this.bob = 0; this.moved = 0;
    this.keys = new Set(); this.stick = null; this.look = null; this.goal = null; this.stuck = 0; this.active = false; this.onChange = null; this.onStep = null;
    this.cells = new Map(); this.circles = [];
    for (const s of solids) {
      if ('r' in s) { this.circles.push(s); continue; }
      const r = { x0: s.x0 - BODY, x1: s.x1 + BODY, z0: s.z0 - BODY, z1: s.z1 + BODY };
      for (let cx = Math.floor(r.x0 / CELL); cx <= Math.floor(r.x1 / CELL); cx++) for (let cz = Math.floor(r.z0 / CELL); cz <= Math.floor(r.z1 / CELL); cz++) {
        const k = `${cx}:${cz}`; (this.cells.get(k) ?? this.cells.set(k, []).get(k)).push(r);
      }
    }
    const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '') || document.activeElement?.isContentEditable;
    this.onKey = (e) => {
      if (!this.active || typing()) return;
      const on = e.type === 'keydown';
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'].includes(e.code)) { if (on) this.keys.add(e.code); else this.keys.delete(e.code); e.preventDefault(); }
    };
    this.onMouse = (e) => {
      if (!this.active) return;
      if (document.pointerLockElement === canvas) this.turn(e.movementX, e.movementY);
      else if (this.look && e.pointerType === 'mouse') { this.turn(e.clientX - this.look.x, e.clientY - this.look.y); this.look = { x: e.clientX, y: e.clientY }; }
    };
    this.onDown = (e) => { if (this.active && e.pointerType === 'mouse') this.look = { x: e.clientX, y: e.clientY, t: performance.now() }; };
    this.onUp = (e) => {
      if (this.active && e.pointerType === 'mouse' && this.look && performance.now() - this.look.t > 450 && canvas.requestPointerLock && document.pointerLockElement !== canvas) { /* a long drag stays a drag */ }
      this.look = null;
    };
    this.onDbl = () => { if (this.active && canvas.requestPointerLock && document.pointerLockElement !== canvas) canvas.requestPointerLock()?.catch?.(() => {}); };
    this.onTouch = (e) => {
      if (!this.active) return;
      for (const t of e.changedTouches) {
        if (e.type === 'touchstart') { if (!this.look) this.look = { id: t.identifier, x: t.clientX, y: t.clientY }; }
        else if (e.type === 'touchmove') { if (this.look?.id === t.identifier) { this.turn((t.clientX - this.look.x) * 1.6, (t.clientY - this.look.y) * 1.6); this.look.x = t.clientX; this.look.y = t.clientY; } }
        else if (this.look?.id === t.identifier) this.look = null;
      }
      if (e.type === 'touchmove') e.preventDefault();
    };
    addEventListener('keydown', this.onKey); addEventListener('keyup', this.onKey);
    addEventListener('pointermove', this.onMouse);
    canvas.addEventListener('pointerdown', this.onDown); addEventListener('pointerup', this.onUp); canvas.addEventListener('dblclick', this.onDbl);
    for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) canvas.addEventListener(ev, this.onTouch, { passive: false });
    this.ring = Object.assign(document.createElement('div'), { className: 'fp-stick', hidden: true });
    this.knob = Object.assign(document.createElement('div'), { className: 'fp-knob' });
    this.ring.append(this.knob); document.body.append(this.ring);
  }

  turn(dx, dy) { this.yaw -= dx * LOOK; this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch - dy * LOOK)); }
  drawStick() {
    this.ring.hidden = !this.stick;
    if (!this.stick) return;
    this.ring.style.left = `${this.stick.x - 50}px`; this.ring.style.top = `${this.stick.y - 50}px`;
    this.knob.style.transform = `translate(${this.stick.dx}px, ${this.stick.dy}px)`;
  }

  blocked(x, z) {
    if (Math.abs(x) > EDGE - 40 || Math.abs(z) > EDGE - 40) return true;
    for (const c of this.circles) if ((x - c.x) ** 2 + (z - c.z) ** 2 < (c.r + BODY) ** 2) return true;
    for (const r of this.cells.get(cellKey(x, z)) ?? []) if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) return true;
    return false;
  }
  free(x, z) {
    if (!this.blocked(x, z)) return [x, z];
    for (let r = 1.5; r < 120; r += 1.5) for (let a = 0; a < 16; a++) { const px = x + Math.cos((a / 16) * Math.PI * 2) * r, pz = z + Math.sin((a / 16) * Math.PI * 2) * r; if (!this.blocked(px, pz)) return [px, pz]; }
    return [0, 30];
  }

  /** Walk to a point (a tap or a click on the ground). Keys or a new tap take over. */
  walkTo(x, z) { this.goal = { x, z }; this.stuck = 0; }

  start({ x = 0, z = 15, yaw = 0, pitch = 0.08 } = {}) {
    const [fx, fz] = this.free(x, z);
    this.pos.set(fx, EYE, fz); this.yaw = yaw; this.pitch = pitch; this.active = true; this.keys.clear(); this.lastPlace = null;
  }
  stop() {
    this.active = false; this.keys.clear(); this.stick = null; this.look = null; this.drawStick();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }
  /** Put the walker where an agent stands (a person playing starts at their own avatar). */
  teleport(x, z, yaw) { const [fx, fz] = this.free(x, z); this.pos.x = fx; this.pos.z = fz; if (yaw != null) this.yaw = yaw; }

  update(dt) {
    const k = this.keys, f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let s = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const turnKeys = (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0);
    if (turnKeys) this.yaw -= turnKeys * 1.8 * dt;
    let fwd = f, mag = 1;
    if (this.stick) { fwd = -this.stick.dy / 60; s = this.stick.dx / 60; mag = Math.min(1, Math.hypot(fwd, s)); }
    if (f || s || turnKeys) this.goal = null; // keys take over from a tap
    if (this.goal && !f && !s) {               // walking to a tapped spot: turn toward it and go
      const dx = this.goal.x - this.pos.x, dz = this.goal.z - this.pos.z, d = Math.hypot(dx, dz);
      if (d < 0.6 || this.stuck > 40) { this.goal = null; this.onArrive?.(); }
      else {
        const want = Math.atan2(-dx, -dz); let diff = want - this.yaw; diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        this.yaw += diff * Math.min(1, dt * 6);
        fwd = Math.abs(diff) < 1.2 ? Math.min(1, d / 1.5 + 0.35) : 0;
      }
    }
    const speed = k.has('ShiftLeft') || k.has('ShiftRight') || (mag > 0.92 && this.stick) ? RUN : WALK;
    const len = Math.hypot(fwd, s);
    if (len > 0.05) {
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      const vx = ((-sin * fwd + cos * s) / len) * speed * Math.min(1, len) * dt, vz = ((-cos * fwd - sin * s) / len) * speed * Math.min(1, len) * dt;
      const x0 = this.pos.x, z0 = this.pos.z;
      if (!this.blocked(this.pos.x + vx, this.pos.z)) this.pos.x += vx;
      if (!this.blocked(this.pos.x, this.pos.z + vz)) this.pos.z += vz;
      this.stuck = Math.hypot(this.pos.x - x0, this.pos.z - z0) < speed * dt * 0.2 ? this.stuck + 1 : 0;
      this.moved += Math.hypot(this.pos.x - x0, this.pos.z - z0);
      this.bob += dt * (speed > WALK ? 11 : 8);
    } else if (this.moved > 0) { this.onStep?.(this.pos.x, this.pos.z); this.moved = 0; } // stopped: tell the city where you are
    if (this.moved > 6) { this.onStep?.(this.pos.x, this.pos.z); this.moved = 0; }
    this.camera.position.set(this.pos.x, EYE + Math.sin(this.bob) * (len > 0.05 ? 0.035 : 0), this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    const place = whereAt(this.pos.x, this.pos.z);
    if (place !== this.lastPlace) { this.lastPlace = place; this.onChange?.(place); }
  }

  /** Behind an agent's eyes, looking the way they face. */
  ride(a) {
    const ry = a.ry ?? 0, eye = new THREE.Vector3(a.x + Math.sin(ry) * 0.4, 1.62, a.z + Math.cos(ry) * 0.4);
    this.camera.position.copy(eye);
    this.camera.lookAt(eye.x + Math.sin(ry) * 10, eye.y - 0.5, eye.z + Math.cos(ry) * 10);
    return eye;
  }
}
