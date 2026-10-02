// Task generators and graders for the outer-ring skills. Five tiers each, same contract as tasks.ts:
// every task comes from a seed, the key never leaves the server, and every answer is checked exactly.
import type { Gen } from './tasks.ts';
import { Rng, NAMES, WORDS } from './rng.ts';

const str = (a: unknown) => (typeof a === 'string' ? a : a && typeof a === 'object' && 'answer' in (a as any) ? String((a as any).answer) : JSON.stringify(a ?? ''));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const asNum = (a: unknown) => { const m = str(a).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : NaN; };
const asInt = (a: unknown) => { const n = asNum(a); return Number.isInteger(n) ? n : NaN; };
const near = (a: unknown, v: number, tol = 0.01) => Math.abs(asNum(a) - v) <= tol;
const list = (a: unknown): string[] => {
  const raw = Array.isArray(a) ? a : Array.isArray((a as any)?.answer) ? (a as any).answer : str(a).replace(/^\[|\]$/g, '').split(/[\s,;]+/);
  return raw.map((x: unknown) => String(x).replace(/["']/g, '').trim()).filter(Boolean);
};
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));
const reduce = (n: number, d: number) => { const g = gcd(n, d) || 1; return [n / g, d / g] as const; };
const fracText = (n: number, d: number) => { const [a, b] = reduce(n, d); return b === 1 ? String(a) : `${a}/${b}`; };
/** Exact comparison of a fractional answer ("3/8", "0", "1") with n/d. */
function fracEq(a: unknown, n: number, d: number) {
  const s = str(a).trim().replace(/\s+/g, '');
  const m = s.match(/^(-?\d+)\/(\d+)$/);
  if (m) return Number(m[1]) * d === n * Number(m[2]) && Number(m[2]) !== 0;
  const x = Number(s);
  return Number.isFinite(x) && Math.abs(x - n / d) < 1e-9;
}

// ======================= calendar =======================
const WD = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY = 86_400_000;
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const wday = (d: Date) => WD[(d.getUTCDay() + 6) % 7];
const plus = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const anyDate = (r: Rng, y0: number, y1: number) => plus(utc(y0, 1, 1), r.int(0, Math.round((utc(y1, 12, 31).getTime() - utc(y0, 1, 1).getTime()) / DAY)));
const calendar: Gen = {
  make(r, tier) {
    if (tier === 1) {
      const d = anyDate(r, 1950, 2050);
      return { task: { title: 'Name the day', data: { date: ymd(d) }, instructions: 'On what day of the week does this date fall?', answer_format: 'weekday name, e.g. Tuesday' }, key: { t: 'wd', v: wday(d) } };
    }
    if (tier === 2) {
      const a = anyDate(r, 1990, 2040), n = r.int(10, 1500);
      return { task: { title: 'Count the days', data: { from: ymd(a), to: ymd(plus(a, n)) },
        instructions: 'How many days is it from the first date to the second? (From 2024-01-01 to 2024-01-03 is 2.)', answer_format: 'integer' }, key: { t: 'int', v: n } };
    }
    if (tier === 3) {
      const a = anyDate(r, 1950, 2050); let n = r.int(1, 2000); if (r.chance(0.4)) n = -n;
      return { task: { title: 'Count forward', data: { date: ymd(a), days: n },
        instructions: `What date is ${Math.abs(n)} days ${n > 0 ? 'after' : 'before'} this date?`, answer_format: 'YYYY-MM-DD' }, key: { t: 'date', v: ymd(plus(a, n)) } };
    }
    if (tier === 4) {
      const a = anyDate(r, 2000, 2040), n = r.int(20, 150);
      let c = 0; for (let i = 0; i <= n; i++) if ((plus(a, i).getUTCDay() + 6) % 7 < 5) c++;
      return { task: { title: 'Count the working days', data: { from: ymd(a), to: ymd(plus(a, n)) },
        instructions: 'How many weekdays (Monday to Friday) fall between the two dates, counting both ends? Ignore holidays.', answer_format: 'integer' }, key: { t: 'int', v: c } };
    }
    const y = r.int(1990, 2040), m = r.int(1, 12), w = r.int(0, 6), which = r.pick(['first', 'second', 'third', 'fourth', 'last'] as const);
    let d: Date;
    if (which === 'last') { d = utc(y, m + 1, 0); while ((d.getUTCDay() + 6) % 7 !== w) d = plus(d, -1); }
    else { d = utc(y, m, 1); while ((d.getUTCDay() + 6) % 7 !== w) d = plus(d, 1); d = plus(d, 7 * ['first', 'second', 'third', 'fourth'].indexOf(which)); }
    return { task: { title: 'Find the date', data: { year: y, month: MONTHS[m - 1], weekday: WD[w], which },
      instructions: `What is the date of the ${which} ${WD[w]} of ${MONTHS[m - 1]} ${y}?`, answer_format: 'YYYY-MM-DD' }, key: { t: 'date', v: ymd(d) } };
  },
  grade(_t, k, a) {
    if (k.t === 'wd') return norm(str(a)).slice(0, 3) === k.v.slice(0, 3).toLowerCase() && norm(str(a)).length >= 3;
    if (k.t === 'int') return asInt(a) === k.v;
    return (str(a).match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '') === k.v;
  },
  reveal: (k) => k.v,
};

// ======================= geometry =======================
type Pt = [number, number];
const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const shoelace = (p: Pt[]) => Math.abs(p.reduce((s, q, i) => s + q[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * q[1], 0)) / 2;
function starPolygon(r: Rng, n: number, rmin: number, rmax: number): Pt[] {
  for (;;) {
    const angs = Array.from({ length: n }, () => r.next() * Math.PI * 2).sort((a, b) => a - b);
    const pts = angs.map((a) => { const d = r.int(rmin, rmax); return [Math.round(Math.cos(a) * d), Math.round(Math.sin(a) * d)] as Pt; });
    // points sorted by angle around the origin, all angles distinct: always a simple polygon
    const sorted = [...pts].sort((p, q) => Math.atan2(p[1], p[0]) - Math.atan2(q[1], q[0]));
    const distinct = new Set(sorted.map((p) => Math.atan2(p[1], p[0]).toFixed(9))).size === n;
    if (distinct && shoelace(sorted) > 10) return sorted;
  }
}
function onSegment(p: Pt, a: Pt, b: Pt) { return cross(a, b, p) === 0 && Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]); }
function inside(p: Pt, poly: Pt[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function hull(ps: Pt[]): Pt[] {
  const p = [...ps].sort((a, b) => a[0] - b[0] || a[1] - b[1]), lo: Pt[] = [], up: Pt[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
const geometry: Gen = {
  make(r, tier) {
    const P = (lo: number, hi: number): Pt => [r.int(lo, hi), r.int(lo, hi)];
    if (tier === 1) {
      const a = P(-20, 20); let b = P(-20, 20); while (b[0] === a[0] && b[1] === a[1]) b = P(-20, 20);
      return { task: { title: 'Measure the distance', data: { a, b }, instructions: 'What is the straight-line distance between points a and b?', answer_format: 'number rounded to 2 decimals' },
        key: { v: Math.hypot(a[0] - b[0], a[1] - b[1]) } };
    }
    if (tier === 2) {
      let t: Pt[]; do t = [P(-15, 15), P(-15, 15), P(-15, 15)]; while (cross(t[0], t[1], t[2]) === 0);
      return { task: { title: 'Area of a triangle', data: { vertices: t }, instructions: 'What is the area of the triangle with these vertices?', answer_format: 'number (exact, e.g. 12.5)' },
        key: { v: Math.abs(cross(t[0], t[1], t[2])) / 2 } };
    }
    if (tier === 3) {
      const poly = starPolygon(r, r.int(5, 7), 4, 15);
      return { task: { title: 'Area of a plot', data: { vertices: poly }, instructions: 'The vertices of a simple polygon are listed in order around its edge. What is its area?', answer_format: 'number (exact, e.g. 97.5)' },
        key: { v: shoelace(poly) } };
    }
    if (tier === 4) {
      const poly = starPolygon(r, r.int(6, 8), 6, 18), pts: Pt[] = [];
      while (pts.length < 8) { const q = P(-18, 18); if (poly.some((v, i) => onSegment(q, v, poly[(i + 1) % poly.length]))) continue; pts.push(q); }
      return { task: { title: 'Who is inside the fence?', data: { fence: poly, points: pts },
        instructions: 'The fence is a simple polygon, vertices in order. How many of the points lie inside it? (No point lies on the fence.)', answer_format: 'integer' },
        key: { v: pts.filter((q) => inside(q, poly)).length, int: true } };
    }
    const pts: Pt[] = []; while (pts.length < r.int(10, 14)) { const q = P(-20, 20); if (!pts.some((x) => x[0] === q[0] && x[1] === q[1])) pts.push(q); }
    return { task: { title: 'Fence the posts', data: { points: pts }, instructions: 'What is the area of the smallest convex polygon that contains every point (the convex hull)?', answer_format: 'number (exact, e.g. 312.5)' },
      key: { v: shoelace(hull(pts)) } };
  },
  grade: (_t, k, a) => (k.int ? asInt(a) === k.v : near(a, k.v)),
  reveal: (k) => (k.int ? k.v : Math.round(k.v * 100) / 100),
};

// ======================= probability =======================
function diceCounts(n: number): Map<number, number> {
  let m = new Map([[0, 1]]);
  for (let i = 0; i < n; i++) { const next = new Map<number, number>(); for (const [s, c] of m) for (let f = 1; f <= 6; f++) next.set(s + f, (next.get(s + f) ?? 0) + c); m = next; }
  return m;
}
const choose = (n: number, k: number) => { let x = 1; for (let i = 1; i <= k; i++) x = (x * (n - k + i)) / i; return Math.round(x); };
const probability: Gen = {
  make(r, tier) {
    const task = (instructions: string, data: object, n: number, d: number) => ({
      task: { title: 'Work out the odds', data, instructions, answer_format: 'exact fraction in lowest terms, e.g. 5/36' }, key: { n, d } });
    if (tier === 1) {
      const k = r.int(2, 12), c = diceCounts(2).get(k)!;
      return task(`Two fair six-sided dice are rolled. What is the probability that they sum to exactly ${k}?`, { dice: 2, kind: 'sum_equals', target: k }, c, 36);
    }
    if (tier === 2) {
      const n = r.int(2, 3), k = r.int(n + 1, 6 * n), c = [...diceCounts(n)].filter(([s]) => s >= k).reduce((x, [, v]) => x + v, 0);
      return task(`${n} fair six-sided dice are rolled. What is the probability that the total is at least ${k}?`, { dice: n, kind: 'sum_at_least', target: k }, c, 6 ** n);
    }
    if (tier === 3) {
      const bag = { red: r.int(2, 6), blue: r.int(2, 6), green: r.int(2, 6) }, T = bag.red + bag.blue + bag.green, pairs = choose(T, 2);
      const kind = r.pick(['same_colour', 'exactly_one_red', 'at_least_one_blue'] as const);
      const fav = kind === 'same_colour' ? choose(bag.red, 2) + choose(bag.blue, 2) + choose(bag.green, 2)
        : kind === 'exactly_one_red' ? bag.red * (T - bag.red) : pairs - choose(T - bag.blue, 2);
      const q = { same_colour: 'both balls are the same colour', exactly_one_red: 'exactly one of them is red', at_least_one_blue: 'at least one of them is blue' }[kind];
      return task(`A bag holds ${bag.red} red, ${bag.blue} blue and ${bag.green} green balls. Two are drawn at random without replacement. What is the probability that ${q}?`, { bag, draws: 2, kind }, fav, pairs);
    }
    if (tier === 4) {
      if (r.chance(0.5)) {
        const n = r.int(4, 10), k = r.int(1, n - 1);
        return task(`A fair coin is flipped ${n} times. What is the probability of exactly ${k} heads?`, { flips: n, kind: 'exactly_heads', target: k }, choose(n, k), 2 ** n);
      }
      const n = r.int(2, 5);
      return task(`A fair die is rolled ${n} times. What is the probability of rolling at least one six?`, { rolls: n, kind: 'at_least_one_six' }, 6 ** n - 5 ** n, 6 ** n);
    }
    const n = r.int(3, 4);
    if (r.chance(0.5)) {
      const k = r.int(2, 6);
      return task(`${n} fair six-sided dice are rolled. What is the probability that the highest number rolled is exactly ${k}?`, { dice: n, kind: 'max_equals', target: k }, k ** n - (k - 1) ** n, 6 ** n);
    }
    let fav = 1; for (let i = 0; i < n; i++) fav *= 6 - i;
    return task(`${n} fair six-sided dice are rolled. What is the probability that all of them show different numbers?`, { dice: n, kind: 'all_different' }, fav, 6 ** n);
  },
  grade: (_t, k, a) => fracEq(a, k.n, k.d),
  reveal: (k) => fracText(k.n, k.d),
};

// ======================= sequences =======================
const sequences: Gen = {
  make(r, tier) {
    const nz = (lo: number, hi: number) => { let x = 0; while (!x) x = r.int(lo, hi); return x; };
    let terms: number[], next: number, rule: string;
    if (tier === 1) {
      const a = r.int(-20, 20), d = nz(-9, 9); terms = Array.from({ length: 7 }, (_, i) => a + d * i); next = a + d * 7;
      rule = 'Each term adds the same amount to the one before.';
    } else if (tier === 2) {
      const a = nz(-9, 9), q = r.pick([2, 3, 4, -2, -3]); terms = Array.from({ length: 6 }, (_, i) => a * q ** i); next = a * q ** 6;
      rule = 'Each term multiplies the one before by the same whole number.';
    } else if (tier === 3) {
      const a = nz(-3, 3), b = r.int(-9, 9), c = r.int(-20, 20), f = (n: number) => a * n * n + b * n + c;
      terms = Array.from({ length: 7 }, (_, i) => f(i)); next = f(7);
      rule = 'The differences between consecutive terms themselves go up (or down) by the same amount each time.';
    } else if (tier === 4) {
      for (;;) {
        const p = nz(-3, 3), q = nz(-3, 3); terms = [r.int(-5, 5), nz(-5, 5)];
        for (let i = 2; i < 8; i++) terms.push(p * terms[i - 1] + q * terms[i - 2]);
        next = p * terms[7] + q * terms[6];
        if (Math.abs(next) < 1e6 && new Set(terms).size > 4) break;
      }
      rule = 'Each term is p × (previous term) + q × (the term before that), for some fixed small whole numbers p and q.';
    } else {
      const a = r.int(-10, 10), d = nz(-6, 6), b = nz(-4, 4), q = r.pick([2, 3, -2]);
      terms = Array.from({ length: 9 }, (_, i) => (i % 2 === 0 ? a + d * (i / 2) : b * q ** ((i - 1) / 2)));
      next = b * q ** 4;
      rule = 'Two sequences are interleaved: the 1st, 3rd, 5th… terms add a fixed amount each time; the 2nd, 4th, 6th… terms multiply by a fixed whole number.';
    }
    return { task: { title: 'What comes next?', data: { terms }, instructions: `${rule} What is the next term?`, answer_format: 'integer' }, key: next };
  },
  grade: (_t, k, a) => asInt(a) === k,
  reveal: (k) => k,
};

// ======================= networks =======================
const NODES = 'ABCDEFGHIJKLMN'.split('');
type Edge = [string, string, number?];
function graph(r: Rng, n: number, m: number, connected: boolean, weighted: boolean): { nodes: string[]; edges: Edge[] } {
  const nodes = NODES.slice(0, n), key = (a: string, b: string) => (a < b ? `${a}${b}` : `${b}${a}`), seen = new Set<string>(), edges: Edge[] = [];
  const add = (a: string, b: string) => { if (a === b || seen.has(key(a, b))) return false; seen.add(key(a, b)); edges.push(weighted ? [a, b, r.int(1, 20)] : [a, b]); return true; };
  if (connected) { const order = r.shuffle([...nodes]); for (let i = 1; i < n; i++) add(order[i], order[r.int(0, i - 1)]); }
  let guard = 0; while (edges.length < m && guard++ < 500) add(r.pick(nodes), r.pick(nodes));
  return { nodes, edges: r.shuffle(edges) };
}
function comps(nodes: string[], edges: Edge[]) {
  const up = new Map(nodes.map((x) => [x, x])); const f = (x: string): string => (up.get(x) === x ? x : (up.set(x, f(up.get(x)!)), up.get(x)!));
  for (const [a, b] of edges) up.set(f(a), f(b));
  return up;
}
function dijkstra(nodes: string[], edges: Edge[], s: string) {
  const dist = new Map(nodes.map((x) => [x, Infinity])); dist.set(s, 0); const done = new Set<string>();
  while (done.size < nodes.length) {
    const u = nodes.filter((x) => !done.has(x)).sort((a, b) => dist.get(a)! - dist.get(b)!)[0]; done.add(u);
    for (const [a, b, w = 1] of edges) for (const [x, y] of [[a, b], [b, a]]) if (x === u && dist.get(u)! + w < dist.get(y)!) dist.set(y, dist.get(u)! + w);
  }
  return dist;
}
const networks: Gen = {
  make(r, tier) {
    if (tier === 1) {
      const g = graph(r, r.int(6, 8), r.int(4, 6), false, false), [s, t] = r.sample(g.nodes, 2), c = comps(g.nodes, g.edges);
      const root = (x: string): string => (c.get(x) === x ? x : root(c.get(x)!)), yes = root(s) === root(t);
      return { task: { title: 'Is there a line?', data: { ...g, from: s, to: t }, instructions: 'Each edge is a two-way telegraph line. Can a message get from "from" to "to"?', answer_format: 'yes or no' }, key: yes ? 'yes' : 'no' };
    }
    if (tier === 2) {
      const g = graph(r, r.int(8, 10), r.int(4, 9), false, false), c = comps(g.nodes, g.edges);
      const root = (x: string): string => (c.get(x) === x ? x : root(c.get(x)!));
      return { task: { title: 'Count the networks', data: g, instructions: 'How many separate networks (connected components) are there, counting lone stations?', answer_format: 'integer' },
        key: new Set(g.nodes.map(root)).size };
    }
    if (tier <= 4) {
      const weighted = tier === 4, g = graph(r, r.int(7, 10), r.int(9, 13), true, weighted);
      let s = '', t = '', d = 0;
      for (let i = 0; i < 20; i++) { [s, t] = r.sample(g.nodes, 2); d = dijkstra(g.nodes, g.edges, s).get(t)!; if (weighted || d >= 2) break; }
      return { task: { title: weighted ? 'The cheapest route' : 'Fewest hops', data: { ...g, from: s, to: t },
        instructions: weighted ? 'Edges are two-way lines [a, b, cost]. What is the lowest total cost to send a message from "from" to "to"?' : 'Edges are two-way lines. What is the fewest number of lines a message must cross to get from "from" to "to"?',
        answer_format: 'integer' }, key: d };
    }
    const g = graph(r, r.int(7, 9), r.int(12, 16), true, true);
    const c = new Map(g.nodes.map((x) => [x, x])); const root = (x: string): string => (c.get(x) === x ? x : root(c.get(x)!));
    let total = 0; for (const [a, b, w] of [...g.edges].sort((x, y) => x[2]! - y[2]!)) if (root(a) !== root(b)) { c.set(root(a), root(b)); total += w!; }
    return { task: { title: 'Wire the city', data: g, instructions: 'Edges are possible two-way lines [a, b, cost]. What is the lowest total cost of a set of lines that connects every station (a minimum spanning tree)?', answer_format: 'integer' }, key: total };
  },
  grade: (_t, k, a) => (typeof k === 'string' ? norm(str(a)).split(' ')[0] === k : asInt(a) === k),
  reveal: (k) => k,
};

// ======================= bookkeeping =======================
const bookkeeping: Gen = {
  make(r, tier) {
    if (tier === 1) {
      let bal = r.int(100, 900); const opening = bal, tx: { kind: string; amount: number }[] = [];
      for (let i = 0; i < 6; i++) { const dep = r.chance(0.5) || bal < 150; const amt = r.int(10, dep ? 400 : Math.min(400, bal - 20)); bal += dep ? amt : -amt; tx.push({ kind: dep ? 'deposit' : 'withdrawal', amount: amt }); }
      return { task: { title: 'Balance the book', data: { opening_balance: opening, transactions: tx }, instructions: 'What is the closing balance after every transaction?', answer_format: 'integer' }, key: bal };
    }
    const accts = r.sample(NAMES, tier === 2 ? 3 : 4), bal = new Map(accts.map((a) => [a, r.int(200, 1500)] as [string, number])), opening = Object.fromEntries(bal);
    if (tier <= 3) {
      const transfers: { from: string; to: string; amount: number }[] = [];
      for (let i = 0; i < (tier === 2 ? 6 : 9); i++) { const [f, t] = r.sample(accts, 2), amt = r.int(10, 300); bal.set(f, bal.get(f)! - amt); bal.set(t, bal.get(t)! + amt); transfers.push({ from: f, to: t, amount: amt }); }
      if (tier === 2) {
        const who = r.pick(accts);
        return { task: { title: 'Follow the money', data: { opening_balances: opening, transfers, account: who }, instructions: `What is ${who}'s balance after all the transfers?`, answer_format: 'integer' }, key: bal.get(who)! };
      }
      const top = [...bal].sort((x, y) => y[1] - x[1]);
      if (top[0][1] === top[1][1]) return bookkeeping.make(r, tier);
      return { task: { title: 'Who ends up richest?', data: { opening_balances: opening, transfers }, instructions: 'Which account has the highest balance after all the transfers?', answer_format: 'account name' }, key: top[0][0] };
    }
    if (tier === 4) {
      const accounts = ['Cash', 'Obols on hand', 'Tools', 'Rent', 'Sales', 'Wages', 'Supplies'];
      const entries = Array.from({ length: 6 }, (_, i) => {
        const amt = r.int(20, 900), [d, c] = r.sample(accounts, 2);
        const lines = [{ account: d, debit: amt, credit: 0 }, { account: c, debit: 0, credit: amt }];
        if (r.chance(0.5)) { const split = r.int(5, amt - 5); lines[1] = { account: c, debit: 0, credit: split }; lines.push({ account: r.pick(accounts.filter((x) => x !== d && x !== c)), debit: 0, credit: amt - split }); }
        return { id: `E${i + 1}`, lines };
      });
      const bad = r.pick(entries), line = r.pick(bad.lines), delta = r.pick([1, 9, 10, 90, 100]) * (r.chance(0.5) ? 1 : -1);
      if (line.debit) line.debit = Math.max(1, line.debit + delta); else line.credit = Math.max(1, line.credit + delta);
      return { task: { title: 'Find the broken entry', data: { entries }, instructions: 'In double-entry bookkeeping every entry\'s debits equal its credits. Exactly one entry does not balance. Which one?', answer_format: 'entry id, e.g. E3' }, key: bad.id };
    }
    for (;;) {
      const entries = Array.from({ length: 8 }, (_, i) => ({ id: `L${i + 1}`, amount: r.int(12, 998) * (r.chance(0.35) ? -1 : 1) }));
      const bad = r.pick(entries), digits = String(Math.abs(bad.amount)).split('');
      if (digits.length < 2) continue;
      const j = r.int(0, digits.length - 2); if (digits[j] === digits[j + 1]) continue;
      const swapped = [...digits]; [swapped[j], swapped[j + 1]] = [swapped[j + 1], swapped[j]];
      if (swapped[0] === '0') continue;
      const trueAmt = Math.sign(bad.amount) * Number(swapped.join('')), bank = entries.reduce((s, e) => s + (e === bad ? trueAmt : e.amount), 0);
      const total = entries.reduce((s, e) => s + e.amount, 0);
      const fits = entries.filter((e) => { const ds = String(Math.abs(e.amount)).split(''); for (let k = 0; k < ds.length - 1; k++) { if (ds[k] === ds[k + 1]) continue; const s2 = [...ds]; [s2[k], s2[k + 1]] = [s2[k + 1], s2[k]]; if (s2[0] !== '0' && total - e.amount + Math.sign(e.amount) * Number(s2.join('')) === bank) return true; } return false; });
      if (fits.length !== 1) continue;
      return { task: { title: 'Reconcile the month', data: { ledger: entries, bank_statement_total: bank },
        instructions: 'The ledger should add up to the bank statement total, but one entry was copied with two neighbouring digits swapped (for example 452 written as 425). Which entry?', answer_format: 'entry id, e.g. L5' }, key: bad.id };
    }
  },
  grade: (_t, k, a) => (typeof k === 'number' ? asInt(a) === k : norm(str(a)).replace(/ /g, '') === norm(String(k)).replace(/ /g, '')),
  reveal: (k) => k,
};

// ======================= wordplay =======================
const PLAIN = WORDS.filter((w) => w.length >= 4);
function lev(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function lcs(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] + 1 : Math.max(d[i - 1][j], d[i][j - 1]);
  return d[a.length][b.length];
}
const sorted = (s: string) => s.split('').sort().join('');
const wordplay: Gen = {
  make(r, tier) {
    if (tier === 1) {
      const sentence = Array.from({ length: r.int(6, 10) }, () => r.pick(PLAIN)).join(' '), ch = r.pick(sentence.replace(/ /g, '').split(''));
      return { task: { title: 'Count the letters', data: { sentence, letter: ch }, instructions: `How many times does the letter "${ch}" appear in the sentence?`, answer_format: 'integer' }, key: sentence.split(ch).length - 1 };
    }
    if (tier === 2) {
      const target = r.pick(PLAIN.filter((w) => w.length >= 5)), letters = target.split('');
      let right = target; while (right === target) right = r.shuffle([...letters]).join('');
      const opts = [right];
      while (opts.length < 5) {
        const w = r.shuffle([...letters]); w[r.int(0, w.length - 1)] = r.pick('abcdefghijklmnopqrstuvwxyz'.split('')); const s = w.join('');
        if (sorted(s) !== sorted(target) && !opts.includes(s)) opts.push(s);
      }
      const shuffled = r.shuffle(opts.map((s, i) => ({ s, right: i === 0 }))), candidates = shuffled.map((o, i) => ({ id: `W${i + 1}`, text: o.s }));
      return { task: { title: 'Find the anagram', data: { word: target, candidates }, instructions: 'Which candidate uses exactly the same letters as the word (an anagram)?', answer_format: 'candidate id, e.g. W2' },
        key: `W${shuffled.findIndex((o) => o.right) + 1}` };
    }
    if (tier === 3) {
      const words = r.sample(PLAIN, 8), key = [...words].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
      return { task: { title: 'Sort the words', data: { words }, instructions: 'Sort the words by length, shortest first; words of the same length go in alphabetical order.', answer_format: 'the words in order, comma-separated' }, key };
    }
    if (tier === 4) {
      const a = r.pick(PLAIN.filter((w) => w.length >= 5)); let b = a.split('');
      for (let i = r.int(2, 4); i > 0; i--) {
        const op = r.int(0, 2), at = r.int(0, b.length - 1), c = r.pick('abcdefghijklmnopqrstuvwxyz'.split(''));
        if (op === 0) b[at] = c; else if (op === 1) b.splice(at, 0, c); else if (b.length > 3) b.splice(at, 1);
      }
      const bs = b.join('');
      return { task: { title: 'Edit distance', data: { a, b: bs }, instructions: 'What is the smallest number of single-letter insertions, deletions or substitutions that turns a into b (the Levenshtein distance)?', answer_format: 'integer' }, key: lev(a, bs) };
    }
    const gen = () => Array.from({ length: r.int(10, 14) }, () => r.pick(['a', 'b', 'c', 'd'])).join(''), a = gen(), b = gen();
    return { task: { title: 'Common thread', data: { a, b }, instructions: 'What is the length of the longest common subsequence of a and b? (Letters in the same order, not necessarily next to each other.)', answer_format: 'integer' }, key: lcs(a, b) };
  },
  grade(_t, k, a) {
    if (Array.isArray(k)) { const got = list(a).map((x) => x.toLowerCase()); return got.length === k.length && got.every((x, i) => x === k[i]); }
    if (typeof k === 'string') return norm(str(a)).replace(/ /g, '') === k.toLowerCase();
    return asInt(a) === k;
  },
  reveal: (k) => (Array.isArray(k) ? k.join(', ') : k),
};

// ======================= encoding =======================
const MORSE: Record<string, string> = { a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....', i: '..', j: '.---', k: '-.-', l: '.-..', m: '--',
  n: '-.', o: '---', p: '.--.', q: '--.-', r: '.-.', s: '...', t: '-', u: '..-', v: '...-', w: '.--', x: '-..-', y: '-.--', z: '--..' };
const encoding: Gen = {
  make(r, tier) {
    if (tier === 1) {
      const n = r.int(5, 255);
      return r.chance(0.5)
        ? { task: { title: 'To binary', data: { decimal: n }, instructions: 'Write this number in binary.', answer_format: 'binary digits, e.g. 101101' }, key: { t: 'bin', v: n } }
        : { task: { title: 'From binary', data: { binary: n.toString(2) }, instructions: 'What is this binary number in decimal?', answer_format: 'integer' }, key: { t: 'int', v: n } };
    }
    if (tier === 2) {
      const n = r.int(16, 65535);
      return r.chance(0.5)
        ? { task: { title: 'To hex', data: { decimal: n }, instructions: 'Write this number in hexadecimal.', answer_format: 'hex digits, e.g. 1f4a' }, key: { t: 'hex', v: n } }
        : { task: { title: 'From hex', data: { hex: n.toString(16) }, instructions: 'What is this hexadecimal number in decimal?', answer_format: 'integer' }, key: { t: 'int', v: n } };
    }
    if (tier === 3) {
      const text = Array.from({ length: r.int(1, 3) }, () => r.pick(PLAIN)).join(' ');
      return { task: { title: 'Decode base64', data: { base64: Buffer.from(text).toString('base64') }, instructions: 'Decode this base64 text.', answer_format: 'the decoded text' }, key: { t: 'text', v: text } };
    }
    if (tier === 4) {
      const text = Array.from({ length: r.int(2, 3) }, () => r.pick(PLAIN)).join(' ');
      const code = text.split(' ').map((w) => w.split('').map((c) => MORSE[c]).join(' ')).join(' / ');
      return { task: { title: 'Read the telegraph', data: { morse: code }, instructions: 'Decode this International Morse code. Letters are separated by spaces and words by " / ".', answer_format: 'the decoded text in lowercase' }, key: { t: 'text', v: text } };
    }
    const a = r.int(0, 4095), b = r.int(0, 4095), c = r.int(0, 4095), k = r.int(1, 4);
    const [expr, v] = r.pick([[`(${a} ^ ${b}) & ${c}`, (a ^ b) & c], [`(${a} | ${b}) >> ${k}`, (a | b) >> k], [`(${a} << ${k}) ^ ${b}`, (a << k) ^ b], [`(${a} & ${b}) | (${c} >> ${k})`, (a & b) | (c >> k)]] as [string, number][]);
    return { task: { title: 'Bitwise', data: { expression: expr }, instructions: 'Evaluate this expression on non-negative integers. & is AND, | is OR, ^ is XOR, << and >> are shifts.', answer_format: 'integer (decimal)' }, key: { t: 'int', v } };
  },
  grade(_t, k, a) {
    const s = str(a).trim().toLowerCase();
    if (k.t === 'bin') return /^(0b)?[01]+$/.test(s.replace(/\s/g, '')) && parseInt(s.replace(/\s|^0b/g, ''), 2) === k.v;
    if (k.t === 'hex') return /^(0x)?[0-9a-f]+$/.test(s.replace(/\s/g, '')) && parseInt(s.replace(/\s|^0x/g, ''), 16) === k.v;
    if (k.t === 'int') return asInt(a) === k.v;
    return norm(s) === k.v;
  },
  reveal: (k) => (k.t === 'bin' ? k.v.toString(2) : k.t === 'hex' ? k.v.toString(16) : k.v),
};

// ======================= puzzles (sudoku) =======================
const SIZES = [null, [4, 2, 2, 6], [4, 2, 2, 10], [6, 2, 3, 15], [6, 2, 3, 21], [9, 3, 3, 44]] as const; // n, box rows, box cols, blanks
function solvedGrid(r: Rng, n: number, br: number, bc: number) {
  const bands = r.shuffle(Array.from({ length: n / br }, (_, i) => i)), stacks = r.shuffle(Array.from({ length: n / bc }, (_, i) => i));
  const rows = bands.flatMap((b) => r.shuffle(Array.from({ length: br }, (_, i) => b * br + i)));
  const cols = stacks.flatMap((s) => r.shuffle(Array.from({ length: bc }, (_, i) => s * bc + i)));
  const digits = r.shuffle(Array.from({ length: n }, (_, i) => i + 1));
  const base = (y: number, x: number) => (bc * (y % br) + Math.floor(y / br) + x) % n;
  return rows.map((y) => cols.map((x) => digits[base(y, x)]));
}
function parseGrid(a: unknown, n: number): number[][] | null {
  const raw = Array.isArray(a) ? a : Array.isArray((a as any)?.answer) ? (a as any).answer : str(a).split(/[\n;|]+|,(?=\s*["\d]{2,})/);
  const rows = raw.map((x: unknown) => (Array.isArray(x) ? x.join('') : String(x)).replace(/[^1-9]/g, '')).filter((x: string) => x.length);
  if (rows.length === 1 && rows[0].length === n * n) return Array.from({ length: n }, (_, i) => rows[0].slice(i * n, i * n + n).split('').map(Number));
  return rows.length === n && rows.every((x: string) => x.length === n) ? rows.map((x: string) => x.split('').map(Number)) : null;
}
const puzzles: Gen = {
  make(r, tier) {
    const [n, br, bc, blanks] = SIZES[tier]!, sol = solvedGrid(r, n, br, bc);
    const cells = r.sample(Array.from({ length: n * n }, (_, i) => i), blanks), grid = sol.map((row) => row.map(String));
    for (const c of cells) grid[Math.floor(c / n)][c % n] = '.';
    return { task: { title: `${n}×${n} grid`, data: { size: n, box: [br, bc], grid: grid.map((row) => row.join('')) },
      instructions: `Fill every "." with a digit 1-${n} so that each row, each column and each ${br}×${bc} box contains every digit exactly once. Keep the given digits. Any valid completion passes.`,
      answer_format: `the completed grid as ${n} strings of ${n} digits, e.g. ["${sol[0].join('')}", ...]` },
      key: { n, br, bc, sol: sol.map((row) => row.join('')) } };
  },
  grade(t, k, a) {
    const g = parseGrid(a, k.n); if (!g) return false;
    const given = (t.data as any).grid as string[];
    for (let y = 0; y < k.n; y++) for (let x = 0; x < k.n; x++) { if (!(g[y][x] >= 1 && g[y][x] <= k.n)) return false; if (given[y][x] !== '.' && Number(given[y][x]) !== g[y][x]) return false; }
    const full = (xs: number[]) => new Set(xs).size === k.n;
    for (let i = 0; i < k.n; i++) if (!full(g[i]) || !full(g.map((row) => row[i]))) return false;
    for (let by = 0; by < k.n; by += k.br) for (let bx = 0; bx < k.n; bx += k.bc) {
      const box: number[] = []; for (let y = by; y < by + k.br; y++) for (let x = bx; x < bx + k.bc; x++) box.push(g[y][x]);
      if (!full(box)) return false;
    }
    return true;
  },
  reveal: (k) => k.sol,
};

// ======================= patterns (regular expressions) =======================
const LET = 'abcdefgh'.split(''), DIG = '0123456789'.split('');
interface Piece { re: string; gen(r: Rng): string }
const lit = (c: string): Piece => ({ re: c, gen: () => c });
const cls = (r: Rng): Piece => { const i = r.int(0, 5), j = r.int(i + 1, 7); return { re: `[${LET[i]}-${LET[j]}]`, gen: (q) => LET[q.int(i, j)] }; };
const dig: Piece = { re: '\\d', gen: (q) => q.pick(DIG) };
const quant = (p: Piece, lo: number, hi: number, re: string): Piece => ({ re: p.re.length > 1 && !p.re.startsWith('[') && !p.re.startsWith('\\') && !p.re.startsWith('(') ? `(?:${p.re})${re}` : `${p.re}${re}`, gen: (q) => Array.from({ length: q.int(lo, hi) }, () => p.gen(q)).join('') });
function patternFor(r: Rng, tier: number): { pieces: Piece[]; groups?: boolean } {
  const L = () => lit(r.pick(LET));
  if (tier === 1) return { pieces: [L(), L(), { re: '.', gen: (q) => q.pick([...LET, ...DIG]) }, L()] };
  if (tier === 2) return { pieces: [cls(r), dig, L(), r.chance(0.5) ? cls(r) : dig] };
  if (tier === 3) return { pieces: [quant(L(), 1, 3, '+'), quant(cls(r), 0, 2, '*'), quant(L(), 0, 1, '?'), quant(dig, 2, 2, '{2}')] };
  if (tier === 4) {
    const w1 = r.sample(LET, 3).join(''), w2 = r.sample(LET, 2).join('');
    return { pieces: [{ re: `(?:${w1}|${w2})`, gen: (q) => (q.chance(0.5) ? w1 : w2) }, quant(lit('-'), 0, 1, '?'), quant(dig, 2, 3, '{2,3}'), quant(cls(r), 1, 2, '+')] };
  }
  const c = cls(r);
  return { pieces: [{ re: `(${c.re}+)`, gen: (q) => Array.from({ length: q.int(1, 3) }, () => c.gen(q)).join('') }, lit('@'), { re: '(\\d{2,3})', gen: (q) => Array.from({ length: q.int(2, 3) }, () => q.pick(DIG)).join('') }], groups: true };
}
function mutate(r: Rng, s: string) {
  const c = s.split(''), at = r.int(0, Math.max(0, c.length - 1)), ch = r.pick([...LET, ...DIG, '-', 'x', 'z']);
  const op = r.int(0, 3);
  if (op === 0 && c.length) c[at] = ch; else if (op === 1) c.splice(at, 0, ch); else if (op === 2 && c.length > 1) c.splice(at, 1); else c.push(ch);
  return c.join('');
}
const patterns: Gen = {
  make(r, tier) {
    for (;;) {
      const { pieces, groups } = patternFor(r, tier);
      const re = pieces.map((p) => p.re).join(''), pos: string[] = [];
      for (let i = 0; i < 6; i++) pos.push(pieces.map((p) => p.gen(r)).join(''));
      const rx = new RegExp(`^(?:${re})$`), strs = new Set<string>();
      for (const p of r.sample(pos, 3)) strs.add(p);
      let guard = 0; while (strs.size < 8 && guard++ < 200) strs.add(mutate(r, r.pick(pos)));
      const items = r.shuffle([...strs]).slice(0, 8).map((s, i) => ({ id: `S${i + 1}`, text: s }));
      const hits = items.filter((x) => rx.test(x.text));
      if (hits.length < 2 || hits.length > 6) continue;
      if (groups) {
        const key = hits.map((x) => x.text.match(rx)![1]);
        return { task: { title: 'Pull out the matches', data: { pattern: re, strings: items },
          instructions: 'The pattern is a regular expression (Python and JavaScript agree on this syntax). For each string that matches the whole pattern, in order, give what capture group 1 matched.',
          answer_format: 'array of strings, e.g. ["abc", "d"]' }, key: { kind: 'groups', v: key } };
      }
      return { task: { title: 'Which strings match?', data: { pattern: re, strings: items },
        instructions: 'The pattern is a regular expression (Python and JavaScript agree on this syntax). Which strings match the whole pattern, from first character to last?',
        answer_format: 'array of string ids, e.g. ["S1", "S4"]' }, key: { kind: 'ids', v: hits.map((x) => x.id) } };
    }
  },
  grade(_t, k, a) {
    const got = list(a);
    if (k.kind === 'ids') { const g = new Set(got.map((x) => x.toUpperCase())); return g.size === k.v.length && k.v.every((x: string) => g.has(x)); }
    return got.length === k.v.length && got.every((x, i) => x === k.v[i]);
  },
  reveal: (k) => k.v,
};

export const GENERATORS2 = { calendar, geometry, probability, sequences, networks, bookkeeping, wordplay, encoding, puzzles, patterns };
