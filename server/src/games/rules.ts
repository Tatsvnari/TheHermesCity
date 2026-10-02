// The rules of every game at the Games Court (Release C). Each game is a pure description: set up a state, say whose
// move it is, check and apply a move, show each seat only what it may see, decide what happens when the clock runs
// out, and say who won. The engine (games.ts) stores states, runs clocks and keeps ratings.
import { ApiError } from '../types.ts';
import { TRIVIA, WORD_THEMES } from './banks.ts';

export type Rnd = () => number;
export interface Result { winners: number[]; draw?: boolean; note?: string }
export interface Game<S = any> {
  id: string; name: string; min: number; max: number; blurb: string; how: string;
  /** seconds on the clock for the current turn or phase */
  clock(s: S): number;
  /** when the clock resets: a new value starts a fresh clock (default: every move) */
  phase?(s: S): string;
  setup(n: number, rnd: Rnd): S;
  toMove(s: S): number[];
  view(s: S, seat: number | null): unknown;
  legal(s: S, seat: number): unknown[] | null;
  move(s: S, seat: number, m: any, rnd: Rnd): S;
  timeout(s: S, rnd: Rnd): S;
  result(s: S): Result | null;
}
const bad = (msg: string) => new ApiError(400, 'illegal', msg);
const clone = <T>(x: T): T => structuredClone(x);
const pick = <T>(a: T[], rnd: Rnd) => a[Math.floor(rnd() * a.length)];
const shuffle = <T>(a: T[], rnd: Rnd) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

// ================= Connect Four =================
interface C4 { board: number[][]; turn: number; last: [number, number] | null; winner: number | null; draw: boolean; line: [number, number][] }
const c4win = (b: number[][], r: number, c: number) => {
  const p = b[r][c];
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const line: [number, number][] = [[r, c]];
    for (const s of [1, -1]) for (let k = 1; k < 4; k++) { const rr = r + dr * k * s, cc = c + dc * k * s; if (rr < 0 || rr > 5 || cc < 0 || cc > 6 || b[rr][cc] !== p) break; line.push([rr, cc]); }
    if (line.length >= 4) return line;
  }
  return null;
};
export const connect4: Game<C4> = {
  id: 'connect4', name: 'Connect Four', min: 2, max: 2, blurb: 'Drop discs; four in a row wins.',
  how: 'move: { col: 0-6 }. Discs fall to the lowest empty row. Four in a row (across, down or diagonal) wins.',
  clock: () => 90,
  setup: () => ({ board: Array.from({ length: 6 }, () => Array(7).fill(-1)), turn: 0, last: null, winner: null, draw: false, line: [] }),
  toMove: (s) => (s.winner !== null || s.draw ? [] : [s.turn]),
  view: (s) => s,
  legal: (s) => [0, 1, 2, 3, 4, 5, 6].filter((c) => s.board[0][c] === -1).map((col) => ({ col })),
  move(s0, seat, m) {
    const c = Number(m?.col);
    if (!(c >= 0 && c <= 6) || s0.board[0][c] !== -1) throw bad('pick a column 0-6 that is not full');
    const s = clone(s0);
    let r = 5; while (s.board[r][c] !== -1) r--;
    s.board[r][c] = seat; s.last = [r, c];
    const line = c4win(s.board, r, c);
    if (line) { s.winner = seat; s.line = line; } else if (s.board[0].every((x) => x !== -1)) s.draw = true;
    s.turn = 1 - seat;
    return s;
  },
  timeout(s, rnd) { return this.move(s, s.turn, pick(this.legal(s, s.turn)!, rnd), rnd); },
  result: (s) => (s.winner !== null ? { winners: [s.winner] } : s.draw ? { winners: [], draw: true } : null),
};

// ================= Dots and Boxes (4 x 4 boxes) =================
interface DB { h: number[][]; v: number[][]; boxes: number[][]; turn: number; score: number[]; last: string | null }
const N = 4;
const boxDone = (s: DB, r: number, c: number) => s.h[r][c] >= 0 && s.h[r + 1][c] >= 0 && s.v[r][c] >= 0 && s.v[r][c + 1] >= 0;
export const dots: Game<DB> = {
  id: 'dots', name: 'Dots and Boxes', min: 2, max: 2, blurb: 'Draw lines; close a box to claim it and go again.',
  how: 'move: { line: "h,r,c" } (horizontal, r 0-4, c 0-3) or { line: "v,r,c" } (vertical, r 0-3, c 0-4). Closing a box scores it and you move again. Most boxes wins.',
  clock: () => 90,
  setup: () => ({ h: Array.from({ length: N + 1 }, () => Array(N).fill(-1)), v: Array.from({ length: N }, () => Array(N + 1).fill(-1)), boxes: Array.from({ length: N }, () => Array(N).fill(-1)), turn: 0, score: [0, 0], last: null }),
  toMove: (s) => (s.score[0] + s.score[1] === N * N ? [] : [s.turn]),
  view: (s) => s,
  legal(s) {
    const out: { line: string }[] = [];
    s.h.forEach((row, r) => row.forEach((x, c) => { if (x < 0) out.push({ line: `h,${r},${c}` }); }));
    s.v.forEach((row, r) => row.forEach((x, c) => { if (x < 0) out.push({ line: `v,${r},${c}` }); }));
    return out;
  },
  move(s0, seat, m) {
    const [k, rs, cs] = String(m?.line ?? '').split(','), r = Number(rs), c = Number(cs);
    const grid = k === 'h' ? s0.h : k === 'v' ? s0.v : null;
    if (!grid || !(r >= 0 && r < grid.length && c >= 0 && c < grid[0].length) || grid[r][c] >= 0) throw bad('draw a line that is not drawn yet, like "h,0,2" or "v,1,4"');
    const s = clone(s0); (k === 'h' ? s.h : s.v)[r][c] = seat; s.last = `${k},${r},${c}`;
    const near = k === 'h' ? [[r - 1, c], [r, c]] : [[r, c - 1], [r, c]];
    let scored = 0;
    for (const [br, bc] of near) if (br >= 0 && br < N && bc >= 0 && bc < N && s.boxes[br][bc] < 0 && boxDone(s, br, bc)) { s.boxes[br][bc] = seat; scored++; }
    s.score[seat] += scored;
    if (!scored) s.turn = 1 - seat;
    return s;
  },
  timeout(s, rnd) { return this.move(s, s.turn, pick(this.legal(s, s.turn)!, rnd), rnd); },
  result: (s) => (s.score[0] + s.score[1] < N * N ? null : s.score[0] === s.score[1] ? { winners: [], draw: true } : { winners: [s.score[0] > s.score[1] ? 0 : 1] }),
};

// ================= Checkers (English draughts) =================
// 0 empty; 1 dark man, 2 dark king (seat 0, starts at the bottom and moves up); 3 light man, 4 light king (seat 1).
interface CK { board: number[][]; turn: number; quiet: number; winner: number | null; draw: boolean; last: number[][] | null }
const own = (p: number, seat: number) => (seat === 0 ? p === 1 || p === 2 : p === 3 || p === 4);
const king = (p: number) => p === 2 || p === 4;
const dirsFor = (p: number) => (king(p) ? [[-1, -1], [-1, 1], [1, -1], [1, 1]] : p === 1 ? [[-1, -1], [-1, 1]] : [[1, -1], [1, 1]]);
const inB = (r: number, c: number) => r >= 0 && r < 8 && c >= 0 && c < 8;
function jumps(b: number[][], r: number, c: number, p: number, seat: number): number[][][] {
  const out: number[][][] = [];
  for (const [dr, dc] of dirsFor(p)) {
    const mr = r + dr, mc = c + dc, tr = r + 2 * dr, tc = c + 2 * dc;
    if (!inB(tr, tc) || b[tr][tc] !== 0 || !b[mr][mc] || own(b[mr][mc], seat)) continue;
    const nb = b.map((row) => [...row]); nb[tr][tc] = p; nb[r][c] = 0; nb[mr][mc] = 0;
    const crowned = !king(p) && ((seat === 0 && tr === 0) || (seat === 1 && tr === 7));
    const more = crowned ? [] : jumps(nb, tr, tc, p, seat);
    if (more.length) for (const m of more) out.push([[r, c], ...m]); else out.push([[r, c], [tr, tc]]);
  }
  return out;
}
function ckLegal(b: number[][], seat: number) {
  const caps: number[][][] = [], steps: number[][][] = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = b[r][c]; if (!own(p, seat)) continue;
    caps.push(...jumps(b, r, c, p, seat));
    for (const [dr, dc] of dirsFor(p)) if (inB(r + dr, c + dc) && b[r + dr][c + dc] === 0) steps.push([[r, c], [r + dr, c + dc]]);
  }
  return caps.length ? caps : steps;
}
export const checkers: Game<CK> = {
  id: 'checkers', name: 'Checkers', min: 2, max: 2, blurb: 'English draughts: jumps are compulsory; reach the far side to crown a king.',
  how: 'move: { path: [[r,c],[r,c],...] }: the piece to move, then each square it lands on (several for a multi-jump). Seat 0 plays dark from rows 5-7 moving up; seat 1 light from rows 0-2 moving down. legal lists every allowed path.',
  clock: () => 120,
  setup: () => ({ board: Array.from({ length: 8 }, (_, r) => Array.from({ length: 8 }, (_, c) => ((r + c) % 2 === 1 ? (r < 3 ? 3 : r > 4 ? 1 : 0) : 0))), turn: 0, quiet: 0, winner: null, draw: false, last: null }),
  toMove: (s) => (s.winner !== null || s.draw ? [] : [s.turn]),
  view: (s) => s,
  legal: (s, seat) => ckLegal(s.board, seat).map((path) => ({ path })),
  move(s0, seat, m) {
    const path = (m?.path ?? []) as number[][];
    const want = JSON.stringify(path);
    if (!ckLegal(s0.board, seat).some((p) => JSON.stringify(p) === want)) throw bad('that is not a legal move; see legal (jumps are compulsory and must be finished)');
    const s = clone(s0), b = s.board;
    let p = b[path[0][0]][path[0][1]]; b[path[0][0]][path[0][1]] = 0;
    let captured = false;
    for (let i = 1; i < path.length; i++) {
      const [r0, c0] = path[i - 1], [r1, c1] = path[i];
      if (Math.abs(r1 - r0) === 2) { b[(r0 + r1) / 2][(c0 + c1) / 2] = 0; captured = true; }
    }
    const [er] = path[path.length - 1];
    if (p === 1 && er === 0) p = 2; if (p === 3 && er === 7) p = 4;
    b[path[path.length - 1][0]][path[path.length - 1][1]] = p;
    s.quiet = captured ? 0 : s.quiet + 1; s.last = path; s.turn = 1 - seat;
    if (!ckLegal(b, s.turn).length) s.winner = seat; else if (s.quiet >= 80) s.draw = true;
    return s;
  },
  timeout(s, rnd) { return this.move(s, s.turn, pick(this.legal(s, s.turn)!, rnd), rnd); },
  result: (s) => (s.winner !== null ? { winners: [s.winner] } : s.draw ? { winners: [], draw: true, note: '40 moves each without a capture' } : null),
};

// ================= Liar's Dice =================
interface LD { dice: number[][]; turn: number; bid: { qty: number; face: number; by: number } | null; history: { seat: number; qty?: number; face?: number; call?: boolean }[]; reveal: { dice: number[][]; bid: any; count: number; loser: number } | null; round: number }
const alive = (s: LD) => s.dice.map((d, i) => (d.length ? i : -1)).filter((i) => i >= 0);
const roll = (n: number, rnd: Rnd) => Array.from({ length: n }, () => 1 + Math.floor(rnd() * 6));
const nextSeat = (s: LD, from: number) => { const a = alive(s); for (let k = 1; k <= s.dice.length; k++) { const i = (from + k) % s.dice.length; if (a.includes(i)) return i; } return from; };
export const liarsdice: Game<LD> = {
  id: 'liarsdice', name: "Liar's Dice", min: 2, max: 6, blurb: 'Bid on the dice under everyone\'s cups, or call a liar.',
  how: "Each player has hidden dice. On your turn either raise the bid, move: { qty, face } (more dice, or the same number of a higher face), or call the last bid a lie, move: { call: true }. Ones are wild (they count as any face) unless the bid is on ones. If the bid holds, the caller loses a die; if not, the bidder does. Last player with dice wins.",
  clock: () => 90,
  setup: (n, rnd) => ({ dice: Array.from({ length: n }, () => roll(5, rnd)), turn: 0, bid: null, history: [], reveal: null, round: 1 }),
  toMove: (s) => (alive(s).length > 1 ? [s.turn] : []),
  view: (s, seat) => ({ ...s, dice: s.dice.map((d, i) => (i === seat ? d : d.map(() => 0))), counts: s.dice.map((d) => d.length), total: s.dice.reduce((t, d) => t + d.length, 0) }),
  legal: () => null,
  move(s0, seat, m, rnd) {
    const s = clone(s0), total = s.dice.reduce((t, d) => t + d.length, 0);
    if (m?.call) {
      if (!s.bid) throw bad('there is no bid to call yet; make one');
      const { qty, face, by } = s.bid;
      const count = s.dice.flat().filter((d) => d === face || (face !== 1 && d === 1)).length;
      const loser = count >= qty ? seat : by;
      s.reveal = { dice: clone(s.dice), bid: s.bid, count, loser };
      s.history.push({ seat, call: true });
      s.dice[loser] = s.dice[loser].slice(1);
      s.dice = s.dice.map((d) => roll(d.length, rnd));
      s.bid = null; s.history = []; s.round++;
      s.turn = s.dice[loser].length ? loser : nextSeat(s, loser);
      return s;
    }
    const qty = Number(m?.qty), face = Number(m?.face);
    if (!(Number.isInteger(qty) && qty >= 1 && qty <= total && Number.isInteger(face) && face >= 1 && face <= 6)) throw bad(`bid { qty: 1-${total}, face: 1-6 } or { call: true }`);
    if (s.bid && !(qty > s.bid.qty || (qty === s.bid.qty && face > s.bid.face))) throw bad(`raise the bid: more than ${s.bid.qty}, or ${s.bid.qty} of a face higher than ${s.bid.face}`);
    s.bid = { qty, face, by: seat }; s.history.push({ seat, qty, face }); s.reveal = s.reveal && s.history.length > 1 ? null : s.reveal;
    s.turn = nextSeat(s, seat);
    return s;
  },
  timeout(s, rnd) { return s.bid ? this.move(s, s.turn, { call: true }, rnd) : this.move(s, s.turn, { qty: 1, face: 2 + Math.floor(rnd() * 5) }, rnd); },
  result: (s) => { const a = alive(s); return a.length === 1 ? { winners: a } : null; },
};

// ================= Werewolf =================
type Role = 'wolf' | 'seer' | 'villager';
interface WW { roles: Role[]; alive: boolean[]; phase: 'night' | 'day'; day: number; kills: Record<number, number>; inspected: Record<number, Role>; seerDone: boolean; votes: Record<number, number>; log: string[]; winner: 'wolves' | 'village' | null }
const wolvesAlive = (s: WW) => s.roles.filter((r, i) => r === 'wolf' && s.alive[i]).length;
const villageAlive = (s: WW) => s.roles.filter((r, i) => r !== 'wolf' && s.alive[i]).length;
function wwCheck(s: WW) { if (!wolvesAlive(s)) s.winner = 'village'; else if (wolvesAlive(s) >= villageAlive(s)) s.winner = 'wolves'; }
function wwDawn(s: WW, rnd: Rnd) {
  const picks = Object.values(s.kills);
  const tally = new Map<number, number>(); for (const p of picks) tally.set(p, (tally.get(p) ?? 0) + 1);
  const max = Math.max(0, ...tally.values()), top = [...tally].filter(([, n]) => n === max).map(([p]) => p);
  let victim = top.length ? pick(top, rnd) : -1;
  if (victim < 0) { const pool = s.alive.map((a, i) => (a && s.roles[i] !== 'wolf' ? i : -1)).filter((i) => i >= 0); victim = pick(pool, rnd); }
  s.alive[victim] = false; s.log.push(`Night ${s.day}: seat ${victim} was taken by the wolves.`);
  s.phase = 'day'; s.kills = {}; s.votes = {}; s.seerDone = false;
  wwCheck(s);
}
function wwDusk(s: WW) {
  const tally = new Map<number, number>(); for (const v of Object.values(s.votes)) if (v >= 0) tally.set(v, (tally.get(v) ?? 0) + 1);
  const max = Math.max(0, ...tally.values()), top = [...tally].filter(([, n]) => n === max).map(([p]) => p);
  if (max > 0 && top.length === 1) { s.alive[top[0]] = false; s.log.push(`Day ${s.day}: the city voted out seat ${top[0]}, who was a ${s.roles[top[0]]}.`); }
  else s.log.push(`Day ${s.day}: the vote was split; no one was voted out.`);
  s.phase = 'night'; s.day++; s.votes = {};
  wwCheck(s);
}
export const werewolf: Game<WW> = {
  id: 'werewolf', name: 'Werewolf', min: 5, max: 9, blurb: 'A village, a seer, and wolves among them. Talk it out; vote someone out.',
  how: "Roles are secret. At night the wolves pick someone, move: { kill: seat }, and the seer looks at one player, move: { inspect: seat }. By day everyone talks in the table's chat channel (table:<id>) and votes, move: { vote: seat } (or -1 to abstain); a clear majority is voted out and their role shown. The village wins when the wolves are gone; the wolves win when they equal the rest.",
  clock: (s) => (s.phase === 'night' ? 75 : 180),
  phase: (s) => `${s.phase}${s.day}`,
  setup(n, rnd) {
    const wolves = n >= 7 ? 2 : 1;
    const roles = shuffle([...Array(wolves).fill('wolf'), 'seer', ...Array(n - wolves - 1).fill('villager')] as Role[], rnd);
    return { roles, alive: Array(n).fill(true), phase: 'night', day: 1, kills: {}, inspected: {}, seerDone: false, votes: {}, log: ['Night falls on the village.'], winner: null };
  },
  toMove(s) {
    if (s.winner) return [];
    if (s.phase === 'night') return s.roles.map((r, i) => (s.alive[i] && ((r === 'wolf' && !(i in s.kills)) || (r === 'seer' && !s.seerDone)) ? i : -1)).filter((i) => i >= 0);
    return s.alive.map((a, i) => (a && !(i in s.votes) ? i : -1)).filter((i) => i >= 0);
  },
  view(s, seat) {
    const over = !!s.winner, me = seat === null ? null : s.roles[seat];
    return {
      phase: s.phase, day: s.day, alive: s.alive, log: s.log, winner: s.winner,
      you: seat === null ? null : { seat, role: me, alive: s.alive[seat], wolves: me === 'wolf' ? s.roles.map((r, i) => (r === 'wolf' ? i : -1)).filter((i) => i >= 0) : undefined, inspected: me === 'seer' ? s.inspected : undefined },
      votes_cast: Object.keys(s.votes).length, roles: over ? s.roles : undefined,
    };
  },
  legal: () => null,
  move(s0, seat, m, rnd) {
    const s = clone(s0), target = Number(m?.kill ?? m?.inspect ?? m?.vote);
    if (!s.alive[seat]) throw bad('you are out of the game; watch the rest');
    const ok = (t: number) => Number.isInteger(t) && t >= 0 && t < s.alive.length && s.alive[t];
    if (s.phase === 'night') {
      if (s.roles[seat] === 'wolf' && m?.kill !== undefined) { if (!ok(target) || s.roles[target] === 'wolf') throw bad('pick a living player who is not a wolf'); s.kills[seat] = target; }
      else if (s.roles[seat] === 'seer' && m?.inspect !== undefined) { if (!ok(target) || target === seat) throw bad('look at another living player'); s.inspected[target] = s.roles[target]; s.seerDone = true; }
      else throw bad(s.roles[seat] === 'villager' ? 'villagers sleep through the night; wait for day' : `at night: ${s.roles[seat] === 'wolf' ? '{ kill: seat }' : '{ inspect: seat }'}`);
      if (!this.toMove(s).length) wwDawn(s, rnd);
      return s;
    }
    if (m?.vote === undefined) throw bad('by day: { vote: seat } or { vote: -1 } to abstain');
    if (target !== -1 && !ok(target)) throw bad('vote for a living player, or -1');
    s.votes[seat] = target;
    if (!this.toMove(s).length) wwDusk(s);
    return s;
  },
  timeout(s0, rnd) {
    const s = clone(s0);
    if (s.phase === 'night') { s.seerDone = true; wwDawn(s, rnd); } else wwDusk(s);
    return s;
  },
  result: (s) => (!s.winner ? null : { winners: s.roles.map((r, i) => ((s.winner === 'wolves') === (r === 'wolf') ? i : -1)).filter((i) => i >= 0), note: s.winner === 'wolves' ? 'the wolves won' : 'the village won' }),
};

// ================= Word Hunt (a Codenames-style team word game) =================
interface WH { words: string[]; theme: string[]; colours: ('red' | 'blue' | 'grey' | 'black')[]; shown: boolean[]; team: 'red' | 'blue'; phase: 'clue' | 'guess'; clue: { word: string; count: number } | null; guesses: number; log: string[]; winner: 'red' | 'blue' | null; n: number }
const teamOf = (seat: number) => (seat % 2 === 0 ? 'red' : 'blue');
const spymaster = (team: 'red' | 'blue') => (team === 'red' ? 0 : 1);
export const wordhunt: Game<WH> = {
  id: 'wordhunt', name: 'Word Hunt', min: 4, max: 8, blurb: 'Two teams, 25 words. Spymasters give one-word clues; teammates find their words.',
  how: "Seats alternate red (even) and blue (odd); seats 0 and 1 are the spymasters and see which words belong to whom. Spymaster: move: { clue: word, count: n } (one word, not on the board). Teammates: move: { guess: index } (0-24), up to count + 1 guesses, or { pass: true }. A wrong word ends your turn; the black word loses the game. First team to find all its words wins.",
  clock: (s) => (s.phase === 'clue' ? 150 : 120),
  phase: (s) => `${s.team}${s.phase}${s.log.length - s.guesses}`,
  setup(n, rnd) {
    const themes = shuffle(Object.keys(WORD_THEMES), rnd).slice(0, 6);
    const pool = shuffle(themes.flatMap((t) => WORD_THEMES[t].map((w) => [w, t] as [string, string])), rnd);
    const seen = new Set<string>(), chosen: [string, string][] = [];
    for (const wt of pool) { if (!seen.has(wt[0])) { seen.add(wt[0]); chosen.push(wt); } if (chosen.length === 25) break; }
    const colours = shuffle([...Array(9).fill('red'), ...Array(8).fill('blue'), ...Array(7).fill('grey'), 'black'] as WH['colours'], rnd);
    return { words: chosen.map((x) => x[0]), theme: chosen.map((x) => x[1]), colours, shown: Array(25).fill(false), team: 'red', phase: 'clue', clue: null, guesses: 0, log: [], winner: null, n };
  },
  toMove(s) {
    if (s.winner) return [];
    if (s.phase === 'clue') return [spymaster(s.team)];
    return Array.from({ length: s.n }, (_, i) => i).filter((i) => teamOf(i) === s.team && i !== spymaster(s.team));
  },
  view(s, seat) {
    const sees = s.winner || (seat !== null && seat <= 1);
    return { words: s.words, shown: s.shown, colours: s.colours.map((c, i) => (sees || s.shown[i] ? c : null)), team: s.team, phase: s.phase, clue: s.clue, guesses: s.guesses, log: s.log, winner: s.winner,
      you: seat === null ? null : { seat, team: teamOf(seat), spymaster: seat <= 1 }, left: { red: s.colours.filter((c, i) => c === 'red' && !s.shown[i]).length, blue: s.colours.filter((c, i) => c === 'blue' && !s.shown[i]).length } };
  },
  legal: () => null,
  move(s0, seat, m) {
    const s = clone(s0);
    if (s.phase === 'clue') {
      const word = String(m?.clue ?? '').trim().toLowerCase(), count = Number(m?.count);
      if (!/^[a-z]{2,20}$/.test(word)) throw bad('a clue is one word of letters');
      if (s.words.some((w) => !s.shown[s.words.indexOf(w)] && (w.includes(word) || word.includes(w)))) throw bad('the clue cannot be (or contain) a word on the board');
      if (!(Number.isInteger(count) && count >= 1 && count <= 9)) throw bad('count is 1-9');
      s.clue = { word, count }; s.phase = 'guess'; s.guesses = 0; s.log.push(`${s.team} clue: ${word} ${count}`);
      return s;
    }
    const endTurn = () => { s.team = s.team === 'red' ? 'blue' : 'red'; s.phase = 'clue'; s.clue = null; };
    if (m?.pass) { s.log.push(`${s.team} passed`); endTurn(); return s; }
    const i = Number(m?.guess);
    if (!(Number.isInteger(i) && i >= 0 && i < 25) || s.shown[i]) throw bad('guess the index (0-24) of a word not yet turned over, or { pass: true }');
    s.shown[i] = true; s.guesses++;
    const col = s.colours[i]; s.log.push(`${s.team} guessed ${s.words[i]}: ${col}`);
    const left = (t: string) => s.colours.filter((c, k) => c === t && !s.shown[k]).length;
    if (col === 'black') { s.winner = s.team === 'red' ? 'blue' : 'red'; return s; }
    if (!left('red')) { s.winner = 'red'; return s; } if (!left('blue')) { s.winner = 'blue'; return s; }
    if (col !== s.team || s.guesses > (s.clue?.count ?? 0)) endTurn();
    return s;
  },
  timeout(s0) { const s = clone(s0); s.log.push(`${s.team} ran out of time`); s.team = s.team === 'red' ? 'blue' : 'red'; s.phase = 'clue'; s.clue = null; return s; },
  result: (s) => (!s.winner ? null : { winners: Array.from({ length: s.n }, (_, i) => i).filter((i) => teamOf(i) === s.winner), note: `${s.winner} team won` }),
};

// ================= Trivia Night =================
interface TV { qs: number[]; q: number; answers: Record<number, { a: number; ms: number }>; asked: number; scores: number[]; log: { q: string; answer: string; right: number[] }[]; n: number }
export const QUESTIONS = 10;
export const trivia: Game<TV> = {
  id: 'trivia', name: 'Trivia Night', min: 2, max: 30, blurb: 'Ten questions, four choices each. Right and quick scores most.',
  how: 'Everyone answers at once: move: { answer: 0-3 }. 20 seconds a question; a right answer scores 100 plus up to 50 for speed.',
  clock: () => 20,
  phase: (s) => String(s.q),
  setup: (n, rnd) => ({ qs: shuffle(TRIVIA.map((_, i) => i), rnd).slice(0, QUESTIONS), q: 0, answers: {}, asked: Date.now(), scores: Array(n).fill(0), log: [], n }),
  toMove: (s) => (s.q >= QUESTIONS ? [] : Array.from({ length: s.n }, (_, i) => i).filter((i) => !(i in s.answers))),
  view: (s) => { const t = TRIVIA[s.qs[s.q]]; return { q: s.q, of: QUESTIONS, question: t ? { text: t[0], choices: t[1] } : null, scores: s.scores, answered: Object.keys(s.answers).length, log: s.log.slice(-3) }; },
  legal: () => [0, 1, 2, 3].map((answer) => ({ answer })),
  move(s0, seat, m) {
    const a = Number(m?.answer);
    if (!(Number.isInteger(a) && a >= 0 && a <= 3)) throw bad('answer 0, 1, 2 or 3');
    const s = clone(s0); s.answers[seat] = { a, ms: Date.now() - s.asked };
    return Object.keys(s.answers).length >= s.n ? next(s) : s;
  },
  timeout: (s) => next(clone(s)),
  result(s) {
    if (s.q < QUESTIONS) return null;
    const top = Math.max(...s.scores);
    return { winners: s.scores.map((x, i) => (x === top && top > 0 ? i : -1)).filter((i) => i >= 0), draw: top === 0 };
  },
};
function next(s: TV) {
  const t = TRIVIA[s.qs[s.q]], right: number[] = [];
  for (const [seat, { a, ms }] of Object.entries(s.answers)) if (a === t[2]) { s.scores[Number(seat)] += 100 + Math.max(0, Math.round(50 * (1 - ms / 20000))); right.push(Number(seat)); }
  s.log.push({ q: t[0], answer: t[1][t[2]], right });
  s.q++; s.answers = {}; s.asked = Date.now();
  return s;
}

export const GAMES: Record<string, Game> = { connect4, dots, checkers, liarsdice, werewolf, wordhunt, trivia };
