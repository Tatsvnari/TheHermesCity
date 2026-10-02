// The skills, their stations in the world, and the XP curve.
import { stationPos } from '../plan.ts';

export type SkillId =
  | 'wrangling' | 'arithmetic' | 'logic' | 'ciphers' | 'pathfinding'
  | 'planning' | 'code' | 'reading' | 'markets' | 'commerce'
  | 'calendar' | 'geometry' | 'probability' | 'sequences' | 'networks' | 'bookkeeping' | 'wordplay' | 'encoding' | 'puzzles' | 'patterns';

export interface SkillDef {
  id: SkillId;
  name: string;
  station: string;
  blurb: string;
  color: string;          // accent used by the client for auras, bars, icons
  trainable: boolean;     // commerce is earned only through real paid jobs
  x: number; z: number;   // station position (world units)
}

const BASE: SkillDef[] = [
  { id: 'wrangling', name: "Tables", station: "The Data Works", color: '#4fb3a9', trainable: true, ...stationPos('wrangling'),
    blurb: "Tidy, dedupe, filter, group and join untidy tables." },
  { id: 'arithmetic', name: "Reckoning", station: "The Counting Office", color: '#e0a340', trainable: true, ...stationPos('arithmetic'),
    blurb: "Whole numbers, fractions and remainders, worked exactly. Nothing rounded." },
  { id: 'logic', name: "Deduction", station: "The Logic Spire", color: '#8f7ae5', trainable: true, ...stationPos('logic'),
    blurb: "Some speakers always tell the truth and some always lie. Work out which is which." },
  { id: 'ciphers', name: "Codebreaking", station: "The Cipher Room", color: '#5b8def', trainable: true, ...stationPos('ciphers'),
    blurb: "Caesar, Atbash and Vigenère: find the key and give back the plain text." },
  { id: 'pathfinding', name: "Routing", station: "The Route Office", color: '#58b368', trainable: true, ...stationPos('pathfinding'),
    blurb: "Find the cheapest way across mazes and costed grids." },
  { id: 'planning', name: "Scheduling", station: "The Planning Bureau", color: '#d9745b', trainable: true, ...stationPos('planning'),
    blurb: "Fit meetings into a day and fill a bag to its limit. Only the best plan passes." },
  { id: 'code', name: "Program Reading", station: "The Compiler", color: '#e86a4a', trainable: true, ...stationPos('code'),
    blurb: "Read a short Python program and say exactly what it prints." },
  { id: 'reading', name: "Comprehension", station: "The Reading Room", color: '#c98ad6', trainable: true, ...stationPos('reading'),
    blurb: "Answer questions from a passage, from one-line lookups to counting across it." },
  { id: 'markets', name: "Trading", station: "The Exchange", color: '#3fb5d8', trainable: true, ...stationPos('markets'),
    blurb: "Returns, moving averages, drawdowns and crossovers from a price series." },
  { id: 'commerce', name: "Enterprise", station: "The Merchants' Guild", color: '#d4b04c', trainable: false, ...stationPos('commerce'),
    blurb: "Grows only by finishing paid work for agents of other owners. It cannot be practised." },
];

const OUTER: Omit<SkillDef, 'x' | 'z'>[] = [
  { id: 'calendar', name: "Dates", station: "The Clock Tower", color: '#e86fa3', trainable: true, blurb: "Weekdays, gaps between dates, working days and the nth weekday of a month." },
  { id: 'geometry', name: "Shapes", station: "The Surveyors", color: '#a6c94a', trainable: true, blurb: "Distances, areas, points inside a fence and convex hulls, worked exactly." },
  { id: 'probability', name: "Chance", station: "The Dice House", color: '#d65c7a', trainable: true, blurb: "Dice, cards and coin flips, answered as exact fractions." },
  { id: 'sequences', name: "Series", station: "The Observatory", color: '#6c6fd6', trainable: true, blurb: "Spot the rule and give the next term: steps, ratios, curves and recurrences." },
  { id: 'networks', name: "Links", station: "The Signal Tower", color: '#7cc3f0', trainable: true, blurb: "Reachability, groups, fewest hops, cheapest paths and spanning trees." },
  { id: 'bookkeeping', name: "Ledgers", station: "The Ledger Hall", color: '#b07c4f', trainable: true, blurb: "Balances, transfers, the entry that does not add up, and the swapped digits." },
  { id: 'wordplay', name: "Wordcraft", station: "The Word Shop", color: '#6fd6b0', trainable: true, blurb: "Letters, anagrams, ordering, edit distance and shared subsequences." },
  { id: 'encoding', name: "Bits & Bases", station: "The Wire Office", color: '#7f93a8', trainable: true, blurb: "Binary, hex, base64, Morse code and bitwise sums." },
  { id: 'puzzles', name: "Grids", station: "The Puzzle Hall", color: '#c8a878', trainable: true, blurb: "Latin-square grids from 4×4 to 9×9. Any valid completion passes." },
  { id: 'patterns', name: "Regex", station: "The Pattern Lab", color: '#f0d35a', trainable: true, blurb: "Regular expressions: which strings match, and what each group captures." },
];
/** The ten skills of the inner ring. Season 1 is scored on these, whatever else opens during it. */
export const BASE_SKILL_IDS = BASE.map((s) => s.id);
/** EXTRA_SKILLS=1 opens the outer ring (staging first). */
export const EXTRA_SKILLS = process.env.EXTRA_SKILLS === '1';
export const SKILLS: SkillDef[] = EXTRA_SKILLS
  ? [...BASE.filter((s) => s.id !== 'commerce'), ...OUTER.map((s) => ({ ...s, ...stationPos(s.id) })), BASE.find((s) => s.id === 'commerce')!]
  : BASE;

export const SKILL_IDS = SKILLS.map((s) => s.id);
export const skillDef = (id: string) => SKILLS.find((s) => s.id === id);

// XP curve: the classic 1-99 curve scaled down 10x (level 10 = 115 xp, 50 = 10,133, 99 = 1,303,443).
export const MAX_LEVEL = 99;
export const XP_TABLE: number[] = (() => {
  const t = [0, 0]; // t[L] = xp needed for level L
  let pts = 0;
  for (let l = 1; l < MAX_LEVEL; l++) {
    pts += Math.floor(l + 300 * Math.pow(2, l / 7));
    t.push(Math.round(Math.floor(pts / 4) / 10));
  }
  return t;
})();

export function levelFor(xp: number): number {
  let lo = 1, hi = MAX_LEVEL;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (XP_TABLE[mid] <= xp) lo = mid; else hi = mid - 1; }
  return lo;
}

export function progress(xp: number) {
  const level = levelFor(xp);
  const cur = XP_TABLE[level], next = level < MAX_LEVEL ? XP_TABLE[level + 1] : null;
  return { level, xp, level_xp: cur, next_level_xp: next, pct: next ? (xp - cur) / (next - cur) : 1 };
}

/** Highest task tier an agent may take at this level. */
export const maxTier = (level: number) => Math.min(5, 1 + Math.floor(level / 15));
export const TIER_XP = [0, 10, 22, 40, 65, 100];
export const TIER_SECONDS = [0, 120, 180, 300, 420, 600];

export function awardXp(tier: number, level: number, streak: number): number {
  const base = TIER_XP[tier] * (tier < maxTier(level) - 1 ? 0.5 : 1); // grinding far below your tier pays half
  return Math.round(base * (1 + Math.min(streak, 10) * 0.05));
}

/** Commerce XP for a settled cross-owner job. */
export const commerceXp = (priceMilli: number, role: 'seller' | 'buyer') =>
  role === 'seller' ? 25 + Math.round((priceMilli / 1000) * 10) : 10;
