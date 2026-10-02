// The HermesCity plan: ONE source for every position in the city, imported by the server (agents, routes, zones)
// and by the client (what is drawn where). Pure data, no dependencies.
//
// A grid of 64 m blocks. The block at the origin is Market Square. Downtown is the 7 x 7 blocks around it: its streets
// are pedestrian promenades, and every place an agent can go stands on a downtown block, its building at the back and
// a paved forecourt in front, facing the square. Agents walk the promenade centrelines (Manhattan routes). Beyond
// downtown the grid carries on as ordinary city (towers, traffic) out to the edge.

export type P = { x: number; z: number };
export const PITCH = 64;
export const N = 6;                                   // block indices run -N..N on each axis
export const DOWNTOWN = 3;                            // |bx|, |bz| <= 3 are downtown (pedestrian streets)
export const lineAt = (i: number) => (i - 0.5) * PITCH; // street line i lies between block i-1 and block i
export const LINE_MIN = -N, LINE_MAX = N + 1;
export const EDGE = lineAt(LINE_MAX) + 30;
export const DT_EDGE = lineAt(DOWNTOWN + 1);          // the downtown streets run -DT_EDGE..DT_EDGE
export const lineWidth = (i: number) => (i === -DOWNTOWN || i === DOWNTOWN + 1 ? 22 : Math.abs(i - 0.5) > DOWNTOWN + 1 ? 16 : 14);
export const lineKind = (i: number) => (lineWidth(i) >= 22 ? 'boulevard' : lineWidth(i) >= 16 ? 'avenue' : 'street');
export const SIDEWALK = 4;
export const blockOf = (v: number) => Math.round(v / PITCH);
export const blockCentre = (b: number) => b * PITCH;
/** Inner bounds of block b (kerb to kerb). */
export function blockBounds(bx: number, bz: number) {
  return { x0: lineAt(bx) + lineWidth(bx) / 2, x1: lineAt(bx + 1) - lineWidth(bx + 1) / 2, z0: lineAt(bz) + lineWidth(bz) / 2, z1: lineAt(bz + 1) - lineWidth(bz + 1) / 2 };
}
export const isDowntown = (bx: number, bz: number) => Math.abs(bx) <= DOWNTOWN && Math.abs(bz) <= DOWNTOWN;

/** Which way a downtown block faces: toward Market Square, along its larger offset. Unit vector. */
export function frontOf(bx: number, bz: number): P {
  if (bx === 0 && bz === 0) return { x: 0, z: 1 };
  return Math.abs(bx) >= Math.abs(bz) ? { x: -Math.sign(bx), z: 0 } : { x: 0, z: -Math.sign(bz) };
}

// ---------------- what stands where ----------------
export type Kind = 'square' | 'station' | 'guild' | 'workshop' | 'bank' | 'library' | 'cityhall' | 'park' | 'games' | 'lodging' | 'homes' | 'tower';
export interface Block { bx: number; bz: number; kind: Kind; skill?: string; name?: string; district?: string }

/** Skill stations by block. The Exchange (markets) and the Guild (commerce) sit next to the square. */
const STATION_BLOCKS: Record<string, [number, number]> = {
  markets: [1, -1], commerce: [1, 0],
  logic: [-2, -1], ciphers: [-2, 1], arithmetic: [-1, -2], planning: [1, -2], reading: [2, -1], code: [2, 1],
  pathfinding: [1, 2], wrangling: [-1, 2], calendar: [-2, -2], geometry: [2, -2], probability: [2, 2], sequences: [-2, 2],
  networks: [-3, -1], bookkeeping: [3, -1], wordplay: [-3, 1], encoding: [3, 1], puzzles: [-1, -3], patterns: [1, 3],
};
const PLACES: Block[] = [
  { bx: 0, bz: 0, kind: 'square', name: 'Market Square' },
  { bx: -1, bz: 0, kind: 'library', name: 'Hermes Hall' },
  { bx: 0, bz: -1, kind: 'cityhall', name: 'City Hall' },
  { bx: 0, bz: 1, kind: 'park', name: 'Caduceus Park' },
  { bx: -1, bz: -1, kind: 'bank', name: 'The Bank' },
  { bx: -1, bz: 1, kind: 'workshop', name: 'The Workshop' },
  { bx: 0, bz: 2, kind: 'games', name: 'The Games Court' },
  { bx: 0, bz: -2, kind: 'lodging', name: 'The Lodging House' },
  { bx: -3, bz: -3, kind: 'homes', district: 'Lantern Row' }, { bx: -3, bz: 3, kind: 'homes', district: 'Orchard Row' },
  { bx: 3, bz: -3, kind: 'homes', district: 'Courier Row' }, { bx: 3, bz: 3, kind: 'homes', district: 'Winged Row' },
  { bx: 0, bz: 3, kind: 'homes', district: 'Meadow Row' },
];
export const BLOCKS: Block[] = (() => {
  const out: Block[] = [...PLACES];
  for (const [skill, [bx, bz]] of Object.entries(STATION_BLOCKS)) out.push({ bx, bz, kind: skill === 'commerce' ? 'guild' : 'station', skill });
  return out;
})();
const byKey = new Map(BLOCKS.map((b) => [`${b.bx},${b.bz}`, b]));
export const placeAt = (bx: number, bz: number) => byKey.get(`${bx},${bz}`);
export const placeOf = (kind: Kind) => BLOCKS.find((b) => b.kind === kind)!;

/** A place's forecourt centre: halfway between the block centre and its front kerb. Stations train here. */
export function forecourt(b: { bx: number; bz: number }, depth = 0.5): P {
  const f = frontOf(b.bx, b.bz), r = blockBounds(b.bx, b.bz), cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
  const hx = (r.x1 - r.x0) / 2, hz = (r.z1 - r.z0) / 2;
  return { x: cx + f.x * hx * depth, z: cz + f.z * hz * depth };
}
/** Where a building's centre sits: in the back half of its block. */
export function backOf(b: { bx: number; bz: number }, depth = 0.38): P {
  const f = frontOf(b.bx, b.bz), r = blockBounds(b.bx, b.bz), cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
  const hx = (r.x1 - r.x0) / 2, hz = (r.z1 - r.z0) / 2;
  return { x: cx - f.x * hx * depth, z: cz - f.z * hz * depth };
}
export const stationPos = (skill: string) => { const b = STATION_BLOCKS[skill]; return b ? forecourt({ bx: b[0], bz: b[1] }) : { x: 0, z: 0 }; };
export const STATION_BLOCK = STATION_BLOCKS;

// ---------------- the places the server and client share ----------------
export const PLAZA = { x: 0, z: 0, r: 12.5 };
const lib = placeOf('library'), hall = placeOf('cityhall'), park = placeOf('park'), shop = placeOf('workshop'), bank = placeOf('bank'),
  games = placeOf('games'), lodge = placeOf('lodging');
export const LIBRARY = { ...backOf(lib), front: forecourt(lib) };
export const WORKSHOP = forecourt(shop, 0.25);
export const BANK = forecourt(bank, 0.25);
/** Market Square's stalls: 16 kiosks in a ring of four rows round the fountain; the Guild hall holds the rest. */
/** Market Square's stalls: two aisles running east-west (z = -10 and z = +10), a row of four stalls on each side of each
 *  aisle, every stall facing its aisle. The walk down the middle (z = 0) has the statue and the benches. */
export const AISLES = [-10, 10];
export function stallPos(plot: number): { x: number; z: number; door: P; ry: number } {
  const row = Math.floor(plot / 4) % 4, x = ((plot % 4) - 1.5) * 7.4;
  const [z, ry] = row === 0 ? [-15.5, 0] : row === 1 ? [-4.5, Math.PI] : row === 2 ? [4.5, 0] : [15.5, Math.PI];
  return { x, z, ry, door: { x, z: z + Math.cos(ry) * 3.2 } };
}
/** A spot to stand in the square: along an aisle or the middle walk, never inside a stall. */
export function squareSpot(seed: number): P {
  const lane = [AISLES[0], 0, AISLES[1]][Math.floor(seed * 3) % 3], t = (seed * 7.31) % 1;
  return { x: -15 + t * 30, z: lane + (((seed * 13.7) % 1) - 0.5) * 2.4 };
}
export const GUILD = backOf(placeOf('guild'));
export const guildCounter = (plot: number) => { const f = forecourt(placeOf('guild'), 0.15); return { x: f.x, z: f.z + (((plot - 16) % 9) - 4) * 0.9 }; };

/** Caduceus Park (leisure): a pond, 24 allotment beds, the bandstand and the Gallery wall, in local block coordinates. */
const pc = { x: blockCentre(park.bx), z: blockCentre(park.bz) };
export const PARK = { pond: { x: pc.x - 12, z: pc.z - 6, r: 4.6 }, bandstand: { x: pc.x + 13, z: pc.z + 12 }, gallery: { x: pc.x - 6, z: pc.z + 19 }, path: pc.x, centre: pc };
const BED_COLS = [-3.6, 0, 3.6, 7.2, 10.8, 14.4];
export const bedPos = (i: number) => ({ x: pc.x + BED_COLS[i % 6] - 2, z: pc.z - 17 + Math.floor(i / 6) * 2.7 });
/** The Games Court: eight stone tables. */
const gc = { x: blockCentre(games.bx), z: blockCentre(games.bz) };
export const TABLE_SPOTS: [number, number][] = [[-9, -6], [-4.5, -6], [0, -6], [4.5, -6], [9, -6], [-6, 1], [0, 1], [6, 1]].map(([x, z]) => [gc.x + x, gc.z + z]);
export const GAMES_CENTRE = gc;
export function seatPos(spot: number | null, k: number) {
  const [x, z] = spot === null ? [gc.x, gc.z] : TABLE_SPOTS[spot];
  const ring = k < 4 ? 1.75 : 2.9, n = k < 4 ? 4 : 10, a = ((k < 4 ? k : k - 4) / n) * Math.PI * 2 + Math.PI / 4;
  return { x: x + Math.cos(a) * ring, z: z + Math.sin(a) * ring };
}
/** the City Hall square (the Civic Square): the hall at the back, the Hall of Fame, and 14 spots for public works. */
const hb = blockBounds(hall.bx, hall.bz);
export const CIVIC = { x0: hb.x0 + 2, x1: hb.x1 - 2, z0: hb.z0 + 2, z1: hb.z1 - 2, x: (hb.x0 + hb.x1) / 2, z: (hb.z0 + hb.z1) / 2,
  gate: forecourt(hall, 1.05), entry: forecourt(hall, 0.85) };
export const TOWNHALL = backOf(hall, 0.5);
export const HALL = { x: CIVIC.x + 14, z: CIVIC.z + 4 };
export const CIVIC_SPOTS: [number, number][] = [[-12, 8], [-6, 8], [0, 8], [6, 8], [12, 8], [-14, 2], [-8, 2], [8, 2], [-14, 14], [-8, 14], [8, 14], [14, 14], [-2, 14], [2, 2]]
  .map(([x, z]) => [CIVIC.x + x, CIVIC.z + z]);
/** The Lodging House: a hotel tower where every agent without a house has a room. */
export const LODGING = { ...backOf(lodge), door: forecourt(lodge, 0.7) };

/** Homes: eight townhouses per residential block, two on each side, each facing its own street. */
export const HOME_BLOCKS = BLOCKS.filter((b) => b.kind === 'homes');
export const HOUSE_PLOTS = HOME_BLOCKS.flatMap((b, bi) => {
  const r = blockBounds(b.bx, b.bz), cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, inset = 8;
  const spots: { x: number; z: number; ry: number }[] = [
    { x: cx - 9, z: r.z0 + inset, ry: Math.PI }, { x: cx + 9, z: r.z0 + inset, ry: Math.PI },
    { x: r.x1 - inset, z: cz - 9, ry: Math.PI / 2 }, { x: r.x1 - inset, z: cz + 9, ry: Math.PI / 2 },
    { x: cx + 9, z: r.z1 - inset, ry: 0 }, { x: cx - 9, z: r.z1 - inset, ry: 0 },
    { x: r.x0 + inset, z: cz + 9, ry: -Math.PI / 2 }, { x: r.x0 + inset, z: cz - 9, ry: -Math.PI / 2 },
  ];
  return spots.map((s) => ({ ...s, district: b.district!, block: bi }));
}).slice(0, 34).map((s, plot) => ({ plot, ...s, price: [2600, 2400, 4000, 3400, 2200][s.block] ?? 2200 }));
/** A house's front door: on the sidewalk in front of it. ry = 0 faces +z. */
export const houseDoor = (h: { x: number; z: number; ry: number }) => ({ x: h.x + Math.sin(h.ry) * 5.2, z: h.z + Math.cos(h.ry) * 5.2 });

/** Named zones agents can move_to. */
const AISLES_Z = -10;
export const ZONES = {
  plaza: { x: 0, z: 0, r: 11 },
  market: { x: 0, z: AISLES_Z, r: 6 },
  workshop: { ...WORKSHOP, r: 6 },
  bank: { ...BANK, r: 5 },
  garden: { x: PARK.centre.x, z: PARK.centre.z, r: 7 },
  meadow: { ...forecourt(placeOf('lodging'), 0.85), r: 5 },
  park: { x: PARK.bandstand.x - 6, z: PARK.bandstand.z - 4, r: 4 },
  games: { x: gc.x, z: gc.z - 1, r: 4 },
  townhall: { x: CIVIC.x, z: CIVIC.z + 6, r: 5 },
  library: { ...LIBRARY.front, r: 4 },
};

// ---------------- walking: Manhattan along the downtown promenades ----------------
const clampDT = (v: number) => Math.max(-DT_EDGE + 2, Math.min(DT_EDGE - 2, v));
/** The street point in front of p: out of its block by the front for places, by the nearest kerb for the square and homes. */
function curb(p: P): { pt: P; axis: 'x' | 'z'; line: number; via: P[] } {
  const bx = Math.max(-DOWNTOWN, Math.min(DOWNTOWN, blockOf(p.x))), bz = Math.max(-DOWNTOWN, Math.min(DOWNTOWN, blockOf(p.z)));
  const b = placeAt(bx, bz), r = blockBounds(bx, bz);
  let dir: P;
  if (b && b.kind === 'square') { // the market: out along your aisle to the open side of the square, then to the street
    const side = p.x >= 0 ? 1 : -1, line = side > 0 ? bx + 1 : bx;
    return { pt: { x: lineAt(line), z: clampDT(p.z) }, axis: 'z', line, via: [{ x: side * 20, z: p.z }, { x: side > 0 ? r.x1 + 0.5 : r.x0 - 0.5, z: p.z }] };
  }
  if (b && (b.kind === 'station' || b.kind === 'guild' || b.kind === 'library' || b.kind === 'bank' || b.kind === 'workshop' || b.kind === 'lodging' || b.kind === 'cityhall')) dir = frontOf(bx, bz);
  else {
    const d = [[p.x - r.x0, { x: -1, z: 0 }], [r.x1 - p.x, { x: 1, z: 0 }], [p.z - r.z0, { x: 0, z: -1 }], [r.z1 - p.z, { x: 0, z: 1 }]] as [number, P][];
    dir = d.sort((a, c) => a[0] - c[0])[0][1];
  }
  if (dir.x) { const line = dir.x > 0 ? bx + 1 : bx; return { pt: { x: lineAt(line), z: clampDT(p.z) }, axis: 'z', line, via: [{ x: dir.x > 0 ? r.x1 + 0.5 : r.x0 - 0.5, z: p.z }] }; }
  const line = dir.z > 0 ? bz + 1 : bz; return { pt: { x: clampDT(p.x), z: lineAt(line) }, axis: 'x', line, via: [{ x: p.x, z: dir.z > 0 ? r.z1 + 0.5 : r.z0 - 0.5 }] };
}
const nearestLine = (v: number) => Math.max(-DOWNTOWN, Math.min(DOWNTOWN + 1, Math.round(v / PITCH + 0.5)));
/** A walking route from s to t: out to the street, along the promenades, in to t. */
export function route(s: P, t: P): P[] {
  const sb = `${blockOf(s.x)},${blockOf(s.z)}`, tb = `${blockOf(t.x)},${blockOf(t.z)}`;
  if (sb === tb) {
    if (sb === '0,0' && Math.abs(s.z - t.z) > 2) { const side = s.x >= 0 ? 1 : -1; return [{ x: side * 20, z: s.z }, { x: side * 20, z: t.z }, t]; } // round the stalls
    return [t];
  }
  const a = curb(s), b = curb(t), pts: P[] = [...a.via, a.pt];
  if (a.axis === 'z' && b.axis === 'z') {                 // both on north-south streets
    if (a.line === b.line) pts.push(b.pt);
    else { const h = lineAt(nearestLine((a.pt.z + b.pt.z) / 2)); pts.push({ x: a.pt.x, z: h }, { x: b.pt.x, z: h }, b.pt); }
  } else if (a.axis === 'x' && b.axis === 'x') {
    if (a.line === b.line) pts.push(b.pt);
    else { const v = lineAt(nearestLine((a.pt.x + b.pt.x) / 2)); pts.push({ x: v, z: a.pt.z }, { x: v, z: b.pt.z }, b.pt); }
  } else if (a.axis === 'z') pts.push({ x: a.pt.x, z: b.pt.z }, b.pt);
  else pts.push({ x: b.pt.x, z: a.pt.z }, b.pt);
  pts.push(...[...b.via].reverse(), t);
  return pts;
}
/** Keep a clicked point inside downtown. */
export const clampDowntown = (p: P) => ({ x: clampDT(p.x), z: clampDT(p.z) });
/** The zone a point is in, for presence and senses. */
export function zoneAt(p: P): keyof typeof ZONES | 'home' {
  const b = placeAt(blockOf(p.x), blockOf(p.z));
  if (!b) return 'plaza';
  return ({ square: 'plaza', station: 'plaza', guild: 'market', workshop: 'workshop', bank: 'bank', library: 'library', cityhall: 'townhall',
    park: 'park', games: 'games', lodging: 'meadow', homes: 'meadow', tower: 'plaza' } as const)[b.kind];
}
