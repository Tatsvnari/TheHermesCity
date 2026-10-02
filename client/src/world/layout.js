// Client view of the city plan. Every position comes from server/src/plan.ts (the same file the server uses), so what
// is drawn and where agents walk can never drift apart. This module adds only client helpers: noise, a mask, flags.
import * as PLAN from '../../../server/src/plan.ts';

export const { PITCH, DOWNTOWN, DT_EDGE, EDGE, SIDEWALK, BLOCKS, lineAt, lineWidth, lineKind, blockBounds, blockCentre, isDowntown, frontOf, forecourt, backOf,
  placeAt, placeOf, PLAZA, LIBRARY, WORKSHOP, BANK, PARK, bedPos, TABLE_SPOTS, GAMES_CENTRE, CIVIC, TOWNHALL, HALL, CIVIC_SPOTS, LODGING, HOUSE_PLOTS,
  houseDoor, stallPos, GUILD, LINE_MIN, LINE_MAX, N, STATION_BLOCK, ZONES } = PLAN;
export const POND = PLAN.PARK.pond;
export const GARDEN = { x: PLAN.PARK.centre.x, z: PLAN.PARK.centre.z, r: 9 };
/** The promenade south of the square, where the Lantern Walk project goes. */
export const MEADOW = { x: lineAt(1), z0: lineAt(-2), z1: lineAt(3) };
export const STATION_PAD = 10;
export const isOuter = () => false;
export function plotPos(plot) { const s = stallPos(plot); return { x: s.x, z: s.z, ry: s.ry, side: 1 }; }

const flags = { homes: false, leisure: false, games: false, town: false };
export const setMeadow = (on) => { flags.homes = !!on; };
export const setLeisure = (on) => { flags.leisure = !!on; };
export const setGames = (on) => { flags.games = !!on; };
export const setTown = (on) => { flags.town = !!on; };
export const meadowOpen = () => flags.homes;
export const parkOpen = () => flags.leisure;
export const townOpen = () => flags.town;

// ---------- deterministic noise ----------
export const hash2 = (x, y) => { let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
export function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export const fbm = (x, y) => noise(x, y) * 0.5 + noise(x * 2.03, y * 2.03) * 0.25 + noise(x * 4.1, y * 4.1) * 0.125 + noise(x * 8.3, y * 8.3) * 0.0625;
export const rand = (seed) => { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), s | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
export const hashStr = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

/** The city is flat. */
export const heightAt = () => 0;
export const townRadius = (x, z) => Math.hypot(x, z);
export const roads = () => [];

export class Mask {
  constructor() { this.circles = []; this.rects = []; }
  circle(x, z, r) { this.circles.push({ x, z, r }); return this; }
  rect(x, z, w, d, ry = 0) { this.rects.push({ x, z, hw: w / 2, hd: d / 2, c: Math.cos(ry), s: Math.sin(ry) }); return this; }
  seg() { return this; }
  blocked(x, z, pad = 0) {
    for (const c of this.circles) if ((x - c.x) ** 2 + (z - c.z) ** 2 < (c.r + pad) ** 2) return true;
    for (const r of this.rects) { const dx = x - r.x, dz = z - r.z, lx = dx * r.c + dz * r.s, lz = -dx * r.s + dz * r.c; if (Math.abs(lx) < r.hw + pad && Math.abs(lz) < r.hd + pad) return true; }
    return false;
  }
}
/** Everything is city except the lawns of the park block. */
export function townMask() {
  const m = new Mask();
  m.blocked = (x, z) => { const b = placeAt(Math.round(x / PITCH), Math.round(z / PITCH)); return !(b && b.kind === 'park'); };
  return m;
}
