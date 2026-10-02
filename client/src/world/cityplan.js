// The towers and the traffic of HermesCity. Places (Market Square, the stations, the halls, the park, the homes) are
// drawn by downtown.js; every other block of the grid gets towers here. Downtown streets are promenades with no cars;
// traffic runs on the avenues outside it. Pure data, no three.js.
import { PITCH, N, DOWNTOWN, DT_EDGE, lineAt, lineWidth, lineKind, blockBounds, placeAt, isDowntown, LINE_MIN, LINE_MAX, SIDEWALK as SW, rand } from './layout.js';

export const SIDEWALK = SW;
export const GROUND_TOP = 5.2;
export const EDGE = lineAt(LINE_MAX) + 30;
export const LANES = { street: [2.0], avenue: [2.05, 5.75], boulevard: [3.9, 7.7] };
/** Sign-band accents by district (the facade shader reads nine). */
export const DISTRICTS = [
  { name: 'Lyre Heights', accent: '#3b82c4' }, { name: 'Courier Row', accent: '#d99a1e' }, { name: 'Exchange District', accent: '#e0b02a' },
  { name: 'Winged Quarter', accent: '#e8703a' }, { name: 'Harbour Gate', accent: '#1fa39a' }, { name: 'Signal Hill', accent: '#7a5ce0' },
  { name: 'Caduceus Park', accent: '#3fae5b' }, { name: 'Old Post', accent: '#e0507a' }, { name: 'Downtown', accent: '#c9a227' },
];
const districtOf = (x, z) => {
  if (Math.abs(x) < DT_EDGE && Math.abs(z) < DT_EDGE) return 8;
  const oct = ((Math.round(Math.atan2(z, x) / (Math.PI / 4)) % 8) + 8) % 8;
  return [2, 3, 4, 5, 6, 7, 0, 1][oct];
};

let plan = null;
export function cityPlan() {
  if (plan) return plan;
  const roads = [], blocks = [], lots = [];
  const lo = lineAt(LINE_MIN), hi = lineAt(LINE_MAX);
  for (let i = LINE_MIN; i <= LINE_MAX; i++) {
    roads.push({ axis: 'z', line: i, at: lineAt(i), w: lineWidth(i), kind: lineKind(i), from: lo, to: hi });
    roads.push({ axis: 'x', line: i, at: lineAt(i), w: lineWidth(i), kind: lineKind(i), from: lo, to: hi });
  }
  for (let bz = -N; bz <= N; bz++) for (let bx = -N; bx <= N; bx++) {
    const r = blockBounds(bx, bz), place = placeAt(bx, bz), dt = isDowntown(bx, bz);
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    const ring = Math.max(Math.abs(bx), Math.abs(bz));
    const edge = ring === N;
    const block = { id: blocks.length, bx, bz, ...r, place, downtown: dt, edge, ring, district: districtOf(cx, cz), lots: [] };
    blocks.push(block);
    if (!place) subdivide(block, rand(((bx + 50) * 7919) ^ ((bz + 50) * 104729)), lots);
  }
  /** Car lanes: every road, but only the stretches outside downtown. */
  const lanes = [];
  for (const rd of roads) {
    const inside = Math.abs(rd.at) < DT_EDGE + 1;
    const spans = inside ? [[rd.from, -DT_EDGE - 12], [DT_EDGE + 12, rd.to]] : [[rd.from, rd.to]];
    for (const [a, b] of spans) if (b - a > 20) lanes.push({ ...rd, from: a, to: b });
  }
  plan = { roads, blocks, lots, lanes };
  return plan;
}

function subdivide(b, r, lots) {
  const ix0 = b.x0 + SIDEWALK, ix1 = b.x1 - SIDEWALK, iz0 = b.z0 + SIDEWALK, iz1 = b.z1 - SIDEWALK;
  const opts = b.edge ? [[2, 2], [2, 3], [3, 2]] : b.downtown ? [[1, 1], [1, 2], [2, 1], [2, 2]] : [[1, 2], [2, 1], [2, 2], [2, 3], [3, 2]];
  const [nx, nz] = opts[Math.floor(r() * opts.length)];
  const cuts = (n, a0, a1) => {
    const ws = Array.from({ length: n }, () => 0.75 + r() * 0.5), sum = ws.reduce((p, c) => p + c, 0), out = [];
    let a = a0;
    for (const w of ws) { const len = ((a1 - a0) * w) / sum; out.push([a, a + len]); a += len; }
    return out;
  };
  for (const [za, zb] of cuts(nz, iz0, iz1)) for (const [xa, xb] of cuts(nx, ix0, ix1)) {
    const lot = makeLot(lots.length, b, (xa + xb) / 2, (za + zb) / 2, xb - xa - 1.2, zb - za - 1.2, r);
    lots.push(lot); b.lots.push(lot.id);
  }
}

// Styles: 0 glass curtain wall, 1 office grid, 2 limestone deco with setbacks, 3 brick walk-up, 4 white modern.
function makeLot(id, b, x, z, w, d, r) {
  const east = Math.min(1, Math.max(0, (x - 120) / 240));         // the Exchange District rises east of downtown
  const near = Math.exp(-(((b.ring - DOWNTOWN - 1) / 1.6) ** 2));   // tallest just outside downtown
  const area = Math.min(1, Math.sqrt(w * d) / 26);
  let h;
  if (b.edge) h = 9 + r() * 16;
  else if (b.downtown) h = (22 + r() * 34) * (0.7 + 0.3 * area);   // downtown: mid-rise round the places
  else {
    const base = 22 + 60 * near + 120 * near * east;
    h = base * (0.45 + 0.8 * Math.pow(r(), 1.3)) * (0.6 + 0.4 * area);
    if (east > 0.4 && near > 0.5 && area > 0.75 && r() < 0.3) h = Math.max(h, 130 + r() * 80);
  }
  h = Math.max(9, Math.round(h * 10) / 10);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const style = h > 110 ? pick([0, 0, 2, 0, 4]) : h > 40 ? pick([0, 1, 2, 1, 4]) : pick([3, 3, 4, 1, 2]);
  return { id, block: b.id, district: b.district, fringe: b.edge, x, z, w, d, h, style, seed: r() };
}
