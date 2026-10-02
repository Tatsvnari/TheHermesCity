// Task generators and graders for the inner-ring skills (the outer ring is in tasks2.ts). Five tiers each.
// Every task is generated from a seed; the answer key never leaves the server.
import { Rng, NAMES, TOWNS, JOBS, PETS, PET_NAMES, COLOURS, CITIES, ITEMS, WORDS, CIPHER_KEYS } from './rng.ts';
import type { SkillId } from './defs.ts';
import { GENERATORS2 } from './tasks2.ts';

export interface Task { title: string; instructions: string; data: unknown; answer_format: string }
export interface Made { task: Task; key: any }
export interface Gen {
  make(r: Rng, tier: number): Made;
  grade(task: Task, key: any, answer: unknown): boolean;
  reveal(key: any): unknown;          // shown after a failed attempt
}

const str = (a: unknown) => (typeof a === 'string' ? a : a && typeof a === 'object' && 'answer' in (a as any) ? String((a as any).answer) : JSON.stringify(a ?? ''));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ======================= wrangling =======================

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  row.push(cell); rows.push(row);
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ''));
}
const toCsv = (rows: (string | number)[][]) => rows.map((r) => r.join(',')).join('\n');
const variant = (r: Rng, s: string) => {
  let v = r.chance(0.5) ? s.toUpperCase() : r.chance(0.5) ? s.toLowerCase() : s;
  if (r.chance(0.6)) v = ' '.repeat(r.int(1, 2)) + v;
  if (r.chance(0.6)) v = v + ' '.repeat(r.int(1, 2));
  return v;
};
function dedupe(rows: string[][]) {
  const seen = new Set<string>(), out: string[][] = [];
  for (const row of rows) { const k = row.map((c) => c.trim().toLowerCase()).join('\u0001'); if (!seen.has(k)) { seen.add(k); out.push(row.map((c) => c.trim())); } }
  return out;
}
function withDupes(r: Rng, base: string[][], n: number, messy: boolean) {
  const rows = base.map((x) => [...x]);
  for (let d = 0; d < n; d++) {
    const src = r.int(0, rows.length - 1);
    const copy = rows[src].map((c) => (messy ? variant(r, c.trim()) : c.trim()));
    rows.splice(r.int(src + 1, rows.length), 0, copy);
  }
  return rows;
}
const cmp = (a: string, b: string) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);

const wrangling: Gen = {
  make(r, tier) {
    const dedupeRule = 'Two rows are duplicates when every cell matches after trimming spaces, ignoring letter case. Keep the first occurrence (trimmed) and drop later ones.';
    if (tier === 5) {
      const custs = r.sample(NAMES, 5).map((n, i) => [`C${i + 1}`, n, r.pick(CITIES)]);
      const orders: string[][] = [];
      for (let i = 0; i < 10; i++) orders.push([`O${100 + i}`, r.pick(custs)[0], String(r.int(1, 20))]);
      const messy = withDupes(r, orders, 3, false);
      const tot = new Map<string, number>();
      for (const [, c, q] of dedupe(messy)) tot.set(c, (tot.get(c) ?? 0) + Number(q));
      const out = custs.filter((c) => tot.has(c[0])).map((c) => [c[1], String(tot.get(c[0]))])
        .sort((a, b) => Number(b[1]) - Number(a[1]) || cmp(a[0], b[0]));
      return {
        task: {
          title: 'Join orders to customers', data: {
            orders_csv: toCsv([['order_id', 'customer_id', 'qty'], ...messy]),
            customers_csv: toCsv([['customer_id', 'name', 'city'], ...custs]),
          },
          instructions: `${dedupeRule} Deduplicate the orders, join them to customers on customer_id, and return one row per customer that has orders with the total qty. Header: name,total_qty. Sort by total_qty descending, then name ascending.`,
          answer_format: 'CSV text (string) including the header row',
        }, key: [['name', 'total_qty'], ...out],
      };
    }
    const n = [0, 5, 7, 8, 9][tier];
    const seen = new Set<string>(); const base: string[][] = [];
    while (base.length < n) {
      const nm = r.pick(NAMES), city = r.pick(CITIES);
      if (seen.has(nm + city)) continue; seen.add(nm + city);
      base.push([nm, city, String(r.int(1, 40))]);
    }
    const messy = withDupes(r, base, r.int(2, 4), tier > 1);
    const clean = dedupe(messy);
    let key: string[][]; let instr = dedupeRule; const header = ['name', 'city', 'qty'];
    if (tier === 1) { key = [header, ...clean]; instr += ' Keep the original row order.'; }
    else if (tier === 2) {
      key = [header, ...clean.map((x, i) => [x, i] as const).sort((a, b) => Number(a[0][2]) - Number(b[0][2]) || a[1] - b[1]).map((x) => x[0])];
      instr += ' Then sort by qty ascending (numeric); rows with equal qty keep their order.';
    } else if (tier === 3) {
      const t = r.int(10, 25);
      key = [header, ...clean.filter((x) => Number(x[2]) >= t).sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]))];
      instr += ` Then keep only rows with qty >= ${t} and sort by name ascending, then city ascending.`;
    } else {
      const g = new Map<string, number>();
      for (const x of clean) { const k = x[1]; g.set(k, (g.get(k) ?? 0) + Number(x[2])); }
      key = [['city', 'total'], ...[...g].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([c, t]) => [c, String(t)])];
      instr += ' Then group by city and sum qty. Header: city,total. Sort by total descending, then city ascending.';
    }
    return { task: { title: 'Clean the table', data: { csv: toCsv([header, ...messy]) }, instructions: instr, answer_format: 'CSV text (string) including the header row' }, key };
  },
  grade(_t, key: string[][], ans) {
    const text = typeof ans === 'string' ? ans : (ans as any)?.csv ?? '';
    const got = parseCsv(String(text));
    if (got.length !== key.length) return false;
    return key.every((row, i) => row.length === got[i].length && row.every((c, j) => {
      const g = got[i][j];
      return /^-?\d+(\.\d+)?$/.test(c) && /^-?\d+(\.\d+)?$/.test(g) ? Number(c) === Number(g) : c.toLowerCase() === g.toLowerCase();
    }));
  },
  reveal: (key) => toCsv(key),
};

// ======================= arithmetic =======================

const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };
class Frac {
  n: bigint; d: bigint;
  constructor(n: bigint, d: bigint = 1n) {
    if (d === 0n) throw new Error('div0');
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d) || 1n; this.n = n / g; this.d = d / g;
  }
  add(o: Frac) { return new Frac(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o: Frac) { return new Frac(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o: Frac) { return new Frac(this.n * o.n, this.d * o.d); }
  div(o: Frac) { return new Frac(this.n * o.d, this.d * o.n); }
  pow(e: number) { let r = new Frac(1n); for (let i = 0; i < e; i++) r = r.mul(this); return r; }
  eq(o: Frac) { return this.n === o.n && this.d === o.d; }
  toString() { return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`; }
}
type AE = { k: 'n'; v: Frac } | { k: 'op'; op: '+' | '-' | '*' | '/'; a: AE; b: AE } | { k: 'pow'; a: AE; e: number };
const aEval = (x: AE): Frac => x.k === 'n' ? x.v : x.k === 'pow' ? aEval(x.a).pow(x.e)
  : x.op === '+' ? aEval(x.a).add(aEval(x.b)) : x.op === '-' ? aEval(x.a).sub(aEval(x.b)) : x.op === '*' ? aEval(x.a).mul(aEval(x.b)) : aEval(x.a).div(aEval(x.b));
const aRender = (x: AE, top = true): string => {
  if (x.k === 'n') return x.v.d !== 1n ? `(${x.v})` : x.v.n < 0n ? `(${x.v})` : `${x.v}`;
  if (x.k === 'pow') return `${aRender(x.a, false)}^${x.e}`;
  const s = `${aRender(x.a, false)} ${x.op === '/' ? '÷' : x.op === '*' ? '×' : x.op} ${aRender(x.b, false)}`;
  return top ? s : `(${s})`;
};
function aTree(r: Rng, depth: number, fracs: boolean, pow: boolean, neg: boolean): AE {
  if (depth === 0) {
    const v = BigInt(r.int(neg ? -15 : 1, 30) || 7);
    return { k: 'n', v: fracs && r.chance(0.5) ? new Frac(BigInt(r.int(1, 9)), BigInt(r.int(2, 9))) : new Frac(v) };
  }
  if (pow && r.chance(0.3)) return { k: 'pow', a: aTree(r, depth - 1, fracs, false, neg), e: r.int(2, 3) };
  const ops: ('+' | '-' | '*' | '/')[] = fracs ? ['+', '-', '*', '/'] : ['+', '-', '*'];
  return { k: 'op', op: r.pick(ops), a: aTree(r, Math.max(0, depth - 1 - (r.chance(0.3) ? 1 : 0)), fracs, pow, neg), b: aTree(r, depth - 1, fracs, pow, neg) };
}
function modpow(b: bigint, e: bigint, m: bigint) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }
function parseFrac(s: string): Frac | null {
  const m = s.replace(/\s+/g, '').replace(/−/g, '-').match(/^(-?\d+)(?:\/(-?\d+))?$/);
  if (!m) return null;
  try { return new Frac(BigInt(m[1]), BigInt(m[2] ?? '1')); } catch { return null; }
}
const arithmetic: Gen = {
  make(r, tier) {
    if (tier === 1) {
      const a = r.int(2, 60), b = r.int(2, 30), c = r.int(2, 30), o1 = r.pick(['+', '-']), o2 = r.pick(['+', '-', '*']);
      const v = o2 === '*' ? (o1 === '+' ? a + b * c : a - b * c) : o1 === '+' ? (o2 === '+' ? a + b + c : a + b - c) : (o2 === '+' ? a - b + c : a - b - c);
      const expr = `${a} ${o1} ${b} ${o2 === '*' ? '×' : o2} ${c}`;
      return { task: { title: 'Evaluate', data: { expression: expr }, instructions: 'Evaluate the expression with the usual precedence (× before + and −).', answer_format: 'integer' }, key: String(v) };
    }
    if (tier === 4) {
      const a = r.int(2, 999), b = r.int(100, 9999), m = r.pick([97, 101, 257, 409, 997, 1009, 4099, 7919, 9973]), c = r.int(2, 99), d = r.int(10, 999);
      const v = (modpow(BigInt(a), BigInt(b), BigInt(m)) + modpow(BigInt(c), BigInt(d), BigInt(m))) % BigInt(m);
      return { task: { title: 'Modular arithmetic', data: { expression: `(${a}^${b} + ${c}^${d}) mod ${m}` }, instructions: 'Compute the value exactly. ^ is exponentiation; mod gives the non-negative remainder.', answer_format: 'integer' }, key: String(v) };
    }
    for (;;) {
      const tree = tier === 2 ? aTree(r, 2, false, false, true) : tier === 3 ? aTree(r, 2, true, false, false) : aTree(r, 3, true, true, true);
      try {
        const v = aEval(tree);
        if (v.n > 10n ** 12n || v.n < -(10n ** 12n) || v.d > 10n ** 9n) continue;
        return {
          task: { title: 'Evaluate exactly', data: { expression: aRender(tree) }, answer_format: tier === 2 ? 'integer' : 'integer or reduced fraction like -7/12',
            instructions: '× is multiplication, ÷ is exact division, ^ is a power. Give the exact value' + (tier === 2 ? '.' : ' as an integer or a fraction in lowest terms.') },
          key: v.toString(),
        };
      } catch { /* division by zero: draw again */ }
    }
  },
  grade(_t, key: string, ans) { const got = parseFrac(str(ans)); const want = parseFrac(key); return !!got && !!want && got.eq(want); },
  reveal: (k) => k,
};

// ======================= logic (knights and knaves) =======================

interface Stmt { text: string; truth: (k: boolean[]) => boolean }
function statement(r: Rng, n: number, i: number, names: string[], tier: number): Stmt {
  const other = () => { let j = r.int(0, n - 1); while (j === i) j = r.int(0, n - 1); return j; };
  const kinds = ['is', 'is', 'same', 'count'];
  if (tier >= 3) kinds.push('if', 'or');
  const kind = r.pick(kinds);
  if (kind === 'is' || n < 2) { const j = other(), kn = r.chance(0.5); return { text: `${names[j]} is a ${kn ? 'knight' : 'knave'}.`, truth: (k) => k[j] === kn }; }
  if (kind === 'same') {
    const j = other();
    let l = r.chance(0.4) ? i : other();
    for (let g = 0; l === j && g < 10; g++) l = other();
    if (l === j) l = i; // only one other person exists
    const same = r.chance(0.5), kind2 = same ? 'the same kind' : 'different kinds';
    return { text: l === i ? `${names[j]} and I are ${kind2}.` : `${names[j]} and ${names[l]} are ${kind2}.`, truth: (k) => (k[j] === k[l]) === same };
  }
  if (kind === 'count') {
    const c = r.int(1, n - 1), knights = r.chance(0.5), exact = r.chance(0.5);
    return { text: `${exact ? 'Exactly' : 'At least'} ${c} of us ${c === 1 ? 'is a' : 'are'} ${knights ? 'knight' : 'knave'}${c === 1 ? '' : 's'}.`,
      truth: (k) => { const m = k.filter((x) => x === knights).length; return exact ? m === c : m >= c; } };
  }
  const j = other(); let l = other(); let guard = 0; while (l === j && guard++ < 10) l = other();
  if (kind === 'if') return { text: `If ${names[j]} is a knight, then ${names[l]} is a knave.`, truth: (k) => !k[j] || !k[l] };
  return { text: `${names[j]} is a knave or ${names[l]} is a knave.`, truth: (k) => !k[j] || !k[l] };
}
const logic: Gen = {
  make(r, tier) {
    const n = tier + 1;
    for (;;) {
      const names = r.sample(NAMES, n);
      const truth = names.map(() => r.chance(0.5));
      const said: { by: number; s: Stmt }[] = [];
      const addFor = (i: number) => {
        for (let t = 0; t < 60; t++) { const s = statement(r, n, i, names, tier); if (s.truth(truth) === truth[i]) { said.push({ by: i, s }); return true; } }
        return false;
      };
      if (!names.every((_, i) => addFor(i))) continue;
      const solutions = () => {
        let c = 0;
        for (let m = 0; m < 1 << n; m++) {
          const k = names.map((_, b) => !!(m & (1 << b)));
          if (said.every(({ by, s }) => s.truth(k) === k[by])) c++;
        }
        return c;
      };
      let sols = solutions(), extra = 0;
      while (sols > 1 && extra++ < n * 2) { addFor(r.int(0, n - 1)); sols = solutions(); }
      if (sols !== 1) continue;
      const order = r.shuffle(said.map((x, idx) => ({ ...x, idx })));
      return {
        task: {
          title: 'Knights and knaves',
          instructions: 'Each person is a knight (always tells the truth) or a knave (always lies). Exactly one assignment is consistent with everything said. "Us" means all the people listed.',
          data: { people: names, statements: order.map((x) => `${names[x.by]} says: "${x.s.text}"`) },
          answer_format: 'object mapping each name to "knight" or "knave", e.g. {"Ada": "knight", "Bram": "knave"}',
        },
        key: Object.fromEntries(names.map((nm, i) => [nm, truth[i] ? 'knight' : 'knave'])),
      };
    }
  },
  grade(_t, key: Record<string, string>, ans) {
    let got: Record<string, string> = {};
    if (ans && typeof ans === 'object') got = Object.fromEntries(Object.entries(ans as any).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]));
    else for (const m of String(ans ?? '').matchAll(/([A-Za-z]+)\s*(?:is|:|=|-)?\s*(?:a\s+)?(knight|knave)/gi)) got[m[1].toLowerCase()] = m[2].toLowerCase();
    return Object.entries(key).every(([nm, v]) => got[nm.toLowerCase()] === v);
  },
  reveal: (k) => k,
};

// ======================= ciphers =======================

const shift = (s: string, k: number) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + k + 260) % 26) + 97));
const atbash = (s: string) => s.replace(/[a-z]/g, (c) => String.fromCharCode(219 - c.charCodeAt(0)));
const vig = (s: string, key: string, dir: 1 | -1) => { let i = 0; return s.replace(/[a-z]/g, (c) => shift(c, dir * (key.charCodeAt(i++ % key.length) - 97))); };
const letters = (s: string) => s.toLowerCase().replace(/[^a-z ]+/g, '').replace(/\s+/g, ' ').trim();
const ciphers: Gen = {
  make(r, tier) {
    const words = Array.from({ length: r.int(5, 5 + tier), }, () => r.pick(WORDS.filter((w) => w.length > 2)));
    const plain = words.join(' ');
    let ct: string, instr: string; const data: any = {};
    if (tier === 1) { const k = r.int(1, 25); ct = shift(plain, k); data.shift = k; instr = `Caesar cipher: each letter was shifted forward ${k} places (z wraps to a). Recover the plaintext.`; }
    else if (tier === 2) { ct = shift(plain, r.int(1, 25)); instr = 'Caesar cipher with an unknown shift. The plaintext is ordinary English words. Recover it.'; }
    else if (tier === 3) { const k = r.int(1, 25); ct = atbash(shift(plain, k)); data.shift = k; instr = `The plaintext was Caesar-shifted forward ${k} places and then Atbash was applied (a↔z, b↔y, ...). Recover the plaintext.`; }
    else if (tier === 4) { const key = r.pick(CIPHER_KEYS); ct = vig(plain, key, 1); data.key = key; instr = `Vigenère cipher with key "${key}". The key advances on letters only; spaces are kept. Recover the plaintext.`; }
    else { const cands = r.sample(CIPHER_KEYS, 8); const key = r.pick(cands); ct = vig(plain, key, 1); data.candidate_keys = cands; instr = 'Vigenère cipher (key advances on letters only; spaces kept). The key is one of the candidate keys; the plaintext is ordinary English words. Recover it.'; }
    data.ciphertext = ct;
    return { task: { title: 'Decode the message', instructions: instr, data, answer_format: 'plaintext string (lowercase letters and spaces)' }, key: plain };
  },
  grade: (_t, key: string, ans) => letters(str(ans)) === letters(key),
  reveal: (k) => k,
};

// ======================= pathfinding =======================

const DIRS: Record<string, [number, number]> = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
function maze(r: Rng, w: number, h: number, loops: number): string[][] {
  const g = Array.from({ length: h }, () => Array(w).fill('#'));
  const stack: [number, number][] = [[1, 1]]; g[1][1] = '.';
  while (stack.length) {
    const [x, y] = stack[stack.length - 1];
    const next = r.shuffle([[2, 0], [-2, 0], [0, 2], [0, -2]]).map(([dx, dy]) => [x + dx, y + dy, x + dx / 2, y + dy / 2])
      .filter(([nx, ny]) => nx > 0 && ny > 0 && nx < w - 1 && ny < h - 1 && g[ny][nx] === '#');
    if (!next.length) { stack.pop(); continue; }
    const [nx, ny, mx, my] = next[0]; g[my][mx] = '.'; g[ny][nx] = '.'; stack.push([nx, ny]);
  }
  for (let i = 0; i < loops; i++) {
    const x = r.int(1, w - 2), y = r.int(1, h - 2);
    if (g[y][x] === '#' && ((g[y][x - 1] === '.' && g[y][x + 1] === '.') || (g[y - 1][x] === '.' && g[y + 1][x] === '.'))) g[y][x] = '.';
  }
  return g;
}
const cellCost = (c: string) => (c >= '1' && c <= '9' ? Number(c) : 1);
function cheapest(g: string[][], sx: number, sy: number, gx: number, gy: number): number | null {
  const h = g.length, w = g[0].length, dist = Array.from({ length: h }, () => Array(w).fill(Infinity));
  dist[sy][sx] = 0; const pq: [number, number, number][] = [[0, sx, sy]];
  while (pq.length) {
    pq.sort((a, b) => a[0] - b[0]); const [d, x, y] = pq.shift()!;
    if (d > dist[y][x]) continue;
    if (x === gx && y === gy) return d;
    for (const [dx, dy] of Object.values(DIRS)) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || g[ny][nx] === '#') continue;
      const nd = d + cellCost(g[ny][nx]);
      if (nd < dist[ny][nx]) { dist[ny][nx] = nd; pq.push([nd, nx, ny]); }
    }
  }
  return null;
}
const pathfinding: Gen = {
  make(r, tier) {
    for (;;) {
      let g: string[][];
      const weighted = tier >= 4;
      if (!weighted) { const s = [0, 9, 13, 17][tier]; g = maze(r, s, s, tier === 3 ? 18 : 0); }
      else {
        const s = tier === 4 ? 12 : 16;
        g = Array.from({ length: s }, () => Array.from({ length: s }, () => (r.chance(tier === 4 ? 0.15 : 0.22) ? '#' : String(r.int(1, 9)))));
      }
      const h = g.length, w = g[0].length;
      const [sx, sy, gx, gy] = weighted ? [0, 0, w - 1, h - 1] : [1, 1, w - 2, h - 2];
      g[sy][sx] = 'S'; g[gy][gx] = 'G';
      const best = cheapest(g, sx, sy, gx, gy);
      if (best === null) continue;
      return {
        task: {
          title: weighted ? 'Cheapest route' : 'Shortest route through the maze',
          instructions: weighted
            ? 'Move from S to G with U/D/L/R steps (U = up a row). # is impassable. Entering a digit cell costs that digit; entering G costs 1. Return a route with the minimum total cost.'
            : 'Move from S to G with U/D/L/R steps (U = up a row). # is a wall. Return a shortest route.',
          data: { grid: g.map((row) => row.join('')) },
          answer_format: 'string of moves, e.g. "RRDDL"',
        }, key: { best, sx, sy },
      };
    }
  },
  grade(t, key, ans) {
    const g = (t.data as any).grid.map((row: string) => row.split(''));
    const moves = str(ans).toUpperCase().replace(/[^UDLR]/g, '');
    let x = key.sx, y = key.sy, cost = 0;
    for (const m of moves) {
      const [dx, dy] = DIRS[m]; x += dx; y += dy;
      if (y < 0 || x < 0 || y >= g.length || x >= g[0].length || g[y][x] === '#') return false;
      cost += cellCost(g[y][x]);
    }
    return g[y][x] === 'G' && cost === key.best;
  },
  reveal: (k) => ({ optimal_cost: k.best }),
};

// ======================= planning =======================

const ids = (ans: unknown): string[] => {
  const raw = Array.isArray(ans) ? ans : Array.isArray((ans as any)?.ids) ? (ans as any).ids : String(str(ans)).split(/[\s,;]+/);
  return raw.map((x: unknown) => String(x).trim().toUpperCase()).filter(Boolean);
};
const planning: Gen = {
  make(r, tier) {
    if (tier <= 2) {
      const n = tier === 1 ? 6 : 10;
      const ms = Array.from({ length: n }, (_, i) => { const s = r.int(0, 90), d = r.int(5, 30); return { id: `M${i + 1}`, start: s, end: s + d }; });
      let count = 0, end = -1;
      for (const m of [...ms].sort((a, b) => a.end - b.end)) if (m.start >= end) { count++; end = m.end; }
      return {
        task: { title: 'Book the most meetings', data: { room: 'one room', meetings: ms },
          instructions: 'Choose as many meetings as possible for one room with no overlaps. A meeting may start exactly when the previous one ends.',
          answer_format: 'array of meeting ids, e.g. ["M1", "M4"]' }, key: { kind: 'sched', best: count },
      };
    }
    const n = [0, 0, 0, 7, 11, 16][tier];
    const items = r.sample(ITEMS, n).map((nm, i) => ({ id: `I${i + 1}`, name: nm, weight: r.int(2, tier === 5 ? 30 : 15), value: r.int(3, 60) }));
    const cap = Math.floor(items.reduce((s, x) => s + x.weight, 0) * 0.4);
    const dp = Array(cap + 1).fill(0);
    for (const it of items) for (let c = cap; c >= it.weight; c--) dp[c] = Math.max(dp[c], dp[c - it.weight] + it.value);
    return {
      task: { title: 'Pack the knapsack', data: { capacity: cap, items },
        instructions: 'Choose items with total weight at most the capacity and the greatest possible total value. Each item at most once.',
        answer_format: 'array of item ids, e.g. ["I2", "I5"]' }, key: { kind: 'knap', best: dp[cap] },
    };
  },
  grade(t, key, ans) {
    const chosen = ids(ans); if (new Set(chosen).size !== chosen.length) return false;
    const d = t.data as any;
    if (key.kind === 'sched') {
      const ms = chosen.map((id) => d.meetings.find((m: any) => m.id === id)); if (ms.some((m) => !m)) return false;
      ms.sort((a: any, b: any) => a.start - b.start);
      for (let i = 1; i < ms.length; i++) if (ms[i].start < ms[i - 1].end) return false;
      return ms.length === key.best;
    }
    const its = chosen.map((id) => d.items.find((x: any) => x.id === id)); if (its.some((x) => !x)) return false;
    return its.reduce((s: number, x: any) => s + x.weight, 0) <= d.capacity && its.reduce((s: number, x: any) => s + x.value, 0) === key.best;
  },
  reveal: (k) => ({ optimal: k.best }),
};

// ======================= code (trace a Python program) =======================

type E = { k: 'n'; v: number } | { k: 'v'; n: string } | { k: 'b'; op: '+' | '-' | '*' | '//' | '%'; a: E; b: E };
const fdiv = (a: number, b: number) => Math.floor(a / b);
const pmod = (a: number, b: number) => a - b * fdiv(a, b);
const ev = (e: E, env: Record<string, number>): number => e.k === 'n' ? e.v : e.k === 'v' ? env[e.n]
  : e.op === '+' ? ev(e.a, env) + ev(e.b, env) : e.op === '-' ? ev(e.a, env) - ev(e.b, env) : e.op === '*' ? ev(e.a, env) * ev(e.b, env)
  : e.op === '//' ? fdiv(ev(e.a, env), ev(e.b, env)) : pmod(ev(e.a, env), ev(e.b, env));
const rd = (e: E, top = true): string => e.k === 'n' ? String(e.v) : e.k === 'v' ? e.n : top ? `${rd(e.a, false)} ${e.op} ${rd(e.b, false)}` : `(${rd(e.a, false)} ${e.op} ${rd(e.b, false)})`;
function rexpr(r: Rng, vars: string[], depth: number): E {
  if (depth <= 0 || r.chance(0.25)) return vars.length && r.chance(0.65) ? { k: 'v', n: r.pick(vars) } : { k: 'n', v: r.int(2, 20) };
  const op = r.pick(['+', '-', '*', '//', '%'] as const);
  return { k: 'b', op, a: rexpr(r, vars, depth - 1), b: op === '//' || op === '%' ? { k: 'n', v: r.int(2, 9) } : rexpr(r, vars, depth - 1) };
}
const pyList = (xs: number[]) => `[${xs.join(', ')}]`;
const VARS = ['a', 'b', 'c', 'x', 'y', 'n', 'm', 'k', 'p', 'q'];
function codeProgram(r: Rng, tier: number): { src: string; out: string } {
  const L: string[] = [], O: string[] = [], env: Record<string, number> = {};
  const vs = r.sample(VARS, 4);
  const setup = (count: number) => {
    for (let i = 0; i < count; i++) { const e = rexpr(r, vs.slice(0, i), i === 0 ? 0 : 2); env[vs[i]] = ev(e, env); L.push(`${vs[i]} = ${rd(e)}`); }
  };
  if (tier === 1) {
    setup(3);
    const re = rexpr(r, vs.slice(0, 3), 2); env[vs[0]] = ev(re, env); L.push(`${vs[0]} = ${rd(re)}`);
    for (let i = 0; i < 2; i++) {
      if (r.chance(0.5)) { const e = rexpr(r, vs.slice(0, 3), 2); L.push(`print(${rd(e)})`); O.push(String(ev(e, env))); }
      else { const [u, w] = r.sample(vs.slice(0, 3), 2); L.push(`print(${u}, ${w})`); O.push(`${env[u]} ${env[w]}`); }
    }
  } else if (tier === 2) {
    setup(2);
    const v = vs[0], m = r.int(2, 5), c = r.int(5, 40);
    const eA = rexpr(r, vs.slice(0, 2), 1), eB = rexpr(r, vs.slice(0, 2), 1), eC = rexpr(r, vs.slice(0, 2), 1);
    L.push(`if ${v} % ${m} == 0:`, `    print(${rd(eA)})`, `elif ${v} > ${c}:`, `    print(${rd(eB)})`, `else:`, `    print(${rd(eC)})`);
    O.push(String(ev(pmod(env[v], m) === 0 ? eA : env[v] > c ? eB : eC, env)));
    const w = vs[1], d = r.int(2, 30);
    L.push(`if ${w} < ${d}:`, `    ${w} = ${w} * 2 + 1`, `print(${w} - ${v})`);
    if (env[w] < d) env[w] = env[w] * 2 + 1;
    O.push(String(env[w] - env[v]));
  } else if (tier === 3) {
    const t = r.int(0, 2);
    if (t === 0) {
      const lo = r.int(0, 5), hi = r.int(10, 30), st = r.pick([1, 1, 2, 3]), m = r.int(2, 5), k = r.int(1, 4);
      L.push('total = 0', `for i in range(${lo}, ${hi}${st > 1 ? `, ${st}` : ''}):`, `    if i % ${m} == 0:`, '        total += i', '    else:', `        total -= ${k}`, 'print(total)');
      let tot = 0; for (let i = lo; i < hi; i += st) tot += pmod(i, m) === 0 ? i : -k; O.push(String(tot));
    } else if (t === 1) {
      let n = r.int(200, 5000); const c = r.int(1, 9), d = r.int(2, 4);
      L.push(`n = ${n}`, 'count = 0', `while n > ${c}:`, `    n = n // ${d}`, '    count += 1', 'print(count, n)');
      let cnt = 0; while (n > c) { n = fdiv(n, d); cnt++; } O.push(`${cnt} ${n}`);
    } else {
      const k = r.int(5, 12), c = r.int(1, 9), m = r.int(11, 97);
      L.push('p = 1', `for i in range(1, ${k}):`, `    p = (p * i + ${c}) % ${m}`, 'print(p)');
      let p = 1; for (let i = 1; i < k; i++) p = pmod(p * i + c, m); O.push(String(p));
    }
  } else if (tier === 4) {
    const t = r.int(0, 2);
    if (t === 0) {
      const xs = Array.from({ length: r.int(5, 8) }, () => r.int(1, 30)), a = r.int(2, 4), b = r.int(2, 3);
      L.push(`xs = ${pyList(xs)}`, 'ys = []', 'for v in xs:', '    if v % 2 == 1:', `        ys.append(v * ${a})`, '    else:', `        ys.append(v // ${b})`, 'print(ys)', 'print(sum(ys), len(ys))');
      const ys = xs.map((v) => (v % 2 === 1 ? v * a : fdiv(v, b))); O.push(pyList(ys), `${ys.reduce((s, v) => s + v, 0)} ${ys.length}`);
    } else if (t === 1) {
      const p = r.int(4, 9), q = r.int(6, 12), m = r.int(3, 7);
      L.push('count = 0', `for i in range(1, ${p}):`, `    for j in range(i, ${q}):`, `        if (i + j) % ${m} == 0:`, '            count += 1', 'print(count)');
      let c = 0; for (let i = 1; i < p; i++) for (let j = i; j < q; j++) if ((i + j) % m === 0) c++; O.push(String(c));
    } else {
      const xs = Array.from({ length: r.int(6, 9) }, () => r.int(-20, 40));
      L.push(`xs = ${pyList(xs)}`, 'best = xs[0]', 'where = 0', 'for i in range(len(xs)):', '    if xs[i] > best:', '        best = xs[i]', '        where = i', 'print(best, where)', 'print(xs[where - 1] + xs[-1])');
      let best = xs[0], where = 0; xs.forEach((v, i) => { if (v > best) { best = v; where = i; } });
      O.push(`${best} ${where}`, String(xs[(where - 1 + xs.length) % xs.length] + xs[xs.length - 1]));
    }
  } else {
    const t = r.int(0, 2);
    if (t === 0) {
      const vals = Array.from({ length: 3 }, () => r.int(3, 40));
      L.push('def f(n):', '    steps = 0', '    while n != 1:', '        if n % 2 == 0:', '            n = n // 2', '        else:', '            n = 3 * n + 1', '        steps += 1', '    return steps', '',
        `for k in ${pyList(vals)}:`, '    print(k, f(k))');
      for (const v of vals) { let n = v, s = 0; while (n !== 1) { n = n % 2 === 0 ? n / 2 : 3 * n + 1; s++; } O.push(`${v} ${s}`); }
    } else if (t === 1) {
      const vals = Array.from({ length: 3 }, () => r.int(100, 99999));
      L.push('def digits(n):', '    s = 0', '    while n > 0:', '        s += n % 10', '        n = n // 10', '    return s', '', 'total = 0', `for v in ${pyList(vals)}:`, '    d = digits(v)', '    total += d', '    print(d)', 'print(total)');
      let tot = 0; for (const v of vals) { let n = v, s = 0; while (n > 0) { s += n % 10; n = fdiv(n, 10); } tot += s; O.push(String(s)); } O.push(String(tot));
    } else {
      const pairs = Array.from({ length: 3 }, () => [r.int(12, 400), r.int(12, 400)]);
      L.push('def g(a, b):', '    while b:', '        a, b = b, a % b', '    return a', '', `for x, y in [${pairs.map(([a, b]) => `(${a}, ${b})`).join(', ')}]:`, '    print(g(x, y), x * y // g(x, y))');
      for (const [a0, b0] of pairs) { let a = a0, b = b0; while (b) [a, b] = [b, a % b]; O.push(`${a} ${fdiv(a0 * b0, a)}`); }
    }
  }
  return { src: L.join('\n'), out: O.join('\n') };
}
const outNorm = (s: string) => s.replace(/\r/g, '').split('\n').map((l) => l.trim()).join('\n').trim();
const code: Gen = {
  make(r, tier) {
    for (;;) {
      const p = codeProgram(r, tier);
      if (/\d{10,}/.test(p.out)) continue;
      return { task: { title: 'What does it print?', data: { language: 'python3', program: p.src },
        instructions: 'Give the exact output of this Python 3 program, one line per print call.', answer_format: 'output text (string), lines separated by \\n' }, key: p.out };
    }
  },
  grade: (_t, key: string, ans) => outNorm(str(ans)) === outNorm(key),
  reveal: (k) => k,
};

// ======================= reading =======================

const reading: Gen = {
  make(r, tier) {
    const nPeople = tier + 3, towns = r.sample(TOWNS, Math.min(4, 2 + Math.ceil(tier / 2)));
    const founded = new Map(towns.map((t, i) => [t, 1600 + i * 37 + r.int(0, 30)] as const));
    r.shuffle(towns);
    const people = r.sample(NAMES, nPeople).map((name, i) => ({
      name, job: JOBS[i % JOBS.length], town: towns[i % towns.length], born: 0, pet: r.pick(PETS), petName: '', colour: r.pick(COLOURS),
    }));
    const years = r.sample(Array.from({ length: 50 }, (_, i) => 1950 + i), nPeople); people.forEach((p, i) => { p.born = years[i]; });
    const pnames = r.sample(PET_NAMES, nPeople); people.forEach((p, i) => { p.petName = pnames[i]; });
    r.shuffle(people);
    const facts: string[] = [];
    for (const t of towns) facts.push(`${t} was founded in ${founded.get(t)}.`);
    for (const p of people) facts.push(
      `${p.name} works as a ${p.job} in ${p.town}.`, `${p.name} was born in ${p.born}.`,
      `${p.name} keeps a ${p.pet} called ${p.petName}.`, `The favourite colour of ${p.name} is ${p.colour}.`);
    const passage = r.shuffle(facts).join(' ');
    const P = r.pick(people); let q: string, a: string;
    const byTown = (t: string) => people.filter((x) => x.town === t);
    if (tier === 1) { [q, a] = r.pick([[`What is ${P.name}'s job?`, P.job], [`In which town does ${P.name} work?`, P.town], [`What is ${P.name}'s favourite colour?`, P.colour]]); }
    else if (tier === 2) { const T = r.pick(towns); [q, a] = r.pick([[`Who keeps a ${P.pet} called ${P.petName}?`, P.name], [`Which town was founded in ${founded.get(T)}?`, T], [`Who works as a ${P.job}?`, P.name]]); }
    else if (tier === 3) { [q, a] = r.pick([[`In which town does the ${P.job} work?`, P.town], [`What is the name of the ${P.job}'s ${P.pet}?`, P.petName], [`What is the job of the person who keeps ${P.petName}?`, P.job]]); }
    else if (tier === 4) {
      const T = towns.find((t) => byTown(t).length >= 2)!;
      const oldest = byTown(T).sort((x, y) => x.born - y.born)[0];
      const [A, B] = r.sample(people, 2);
      [q, a] = r.pick([[`Who is the oldest person working in ${T}?`, oldest.name],
        [`Of ${A.name} and ${B.name}, who was born later?`, A.born > B.born ? A.name : B.name],
        [`In which year was the city where ${P.name} works founded?`, String(founded.get(P.town))]]);
    } else {
      const ys = [...founded.values()].sort((x, y) => x - y), cut = ys[r.int(1, ys.length - 1)];
      const pet = r.pick(people).pet, yr = r.int(1960, 1990);
      const oldestTown = [...founded].sort((x, y) => x[1] - y[1])[0][0];
      const youngest = byTown(oldestTown).sort((x, y) => y.born - x.born)[0];
      const opts: [string, string][] = [[`How many people work in towns founded before ${cut}?`, String(people.filter((x) => founded.get(x.town)! < cut).length)],
        [`How many people born after ${yr} keep a ${pet}?`, String(people.filter((x) => x.born > yr && x.pet === pet).length)]];
      if (youngest) opts.push([`What is the favourite colour of the youngest person working in the oldest town?`, youngest.colour]);
      [q, a] = r.pick(opts);
    }
    return { task: { title: 'Read and answer', data: { passage, question: q }, instructions: 'Answer the question using only the passage.',
      answer_format: 'short answer string (a name, place, word or number)' }, key: a };
  },
  grade: (_t, key: string, ans) => norm(str(ans)) === norm(key) || norm(str(ans)).replace(/^(the|a|an) /, '') === norm(key),
  reveal: (k) => k,
};

// ======================= markets =======================

const r2 = (x: number) => Math.round(x * 100) / 100;
const sma = (xs: number[], k: number, t: number) => (t + 1 < k ? null : xs.slice(t + 1 - k, t + 1).reduce((s, v) => s + v, 0) / k);
const markets: Gen = {
  make(r, tier) {
    const n = [0, 10, 20, 30, 40, 60][tier]; let p = r.int(20, 200); const closes: number[] = [];
    for (let i = 0; i < n; i++) { p = Math.max(1, p * (1 + (r.next() + r.next() + r.next() - 1.5) * 0.06)); closes.push(r2(p)); }
    const data: any = { ticker: r.pick(['SEED', 'LNTN', 'ORCH', 'BRDG', 'CPPR', 'MDOW']), closes };
    let q: string, key: number, fmt = 'number rounded to 2 decimals';
    if (tier === 1) { q = 'Percent return from the first close to the last close.'; key = r2((closes[n - 1] / closes[0] - 1) * 100); }
    else if (tier === 2) { const k = r.int(5, 10); q = `Simple moving average of the last ${k} closes.`; key = r2(sma(closes, k, n - 1)!); data.window = k; }
    else if (tier === 3) { let peak = closes[0], dd = 0; for (const c of closes) { peak = Math.max(peak, c); dd = Math.max(dd, (peak - c) / peak); } q = 'Maximum drawdown in percent (largest peak-to-later-trough fall, relative to the peak).'; key = r2(dd * 100); }
    else if (tier === 4) { let lo = closes[0], best = 0; for (const c of closes) { best = Math.max(best, c - lo); lo = Math.min(lo, c); } q = 'Largest profit per share from buying on one day and selling on a later day (0 if none).'; key = r2(best); }
    else {
      const s = r.int(3, 5), l = r.int(8, 15); let c = 0;
      for (let t = 1; t < n; t++) { const a0 = sma(closes, s, t - 1), b0 = sma(closes, l, t - 1), a1 = sma(closes, s, t), b1 = sma(closes, l, t); if (a0 != null && b0 != null && a1 != null && b1 != null && a0 <= b0 && a1 > b1) c++; }
      q = `Count the golden crosses: days t where SMA(${s}) at t-1 <= SMA(${l}) at t-1 and SMA(${s}) at t > SMA(${l}) at t. Only days where both averages exist at t-1 count.`;
      key = c; fmt = 'integer'; Object.assign(data, { short: s, long: l });
    }
    return { task: { title: 'Read the chart', data, instructions: q, answer_format: fmt }, key: { v: key, int: tier === 5 } };
  },
  grade(_t, key, ans) {
    const g = Number(String(str(ans)).replace(/[%\s,]/g, ''));
    return Number.isFinite(g) && (key.int ? g === key.v : Math.abs(g - key.v) <= 0.011);
  },
  reveal: (k) => k.v,
};

export const GENERATORS: Partial<Record<SkillId, Gen>> = { wrangling, arithmetic, logic, ciphers, pathfinding, planning, code, reading, markets, ...GENERATORS2 };
