// Offline check of the house solvers: `tsx test/solver_check.ts gen > t.json; python3 check.py < t.json > a.json; tsx test/solver_check.ts grade`
import { readFileSync } from 'node:fs';
import { Rng } from '../src/skills/rng.ts';
import { GENERATORS } from '../src/skills/tasks.ts';
const SK = ['wrangling', 'arithmetic', 'logic', 'ciphers', 'pathfinding', 'planning', 'markets', 'code', 'reading',
  'calendar', 'geometry', 'probability', 'sequences', 'networks', 'bookkeeping', 'wordplay', 'encoding', 'puzzles', 'patterns'] as const;
const MAX_TIER: Record<string, number> = { code: 3, reading: 3 };
if (process.argv[2] === 'gen') {
  const out = [];
  for (const skill of SK) for (let tier = 1; tier <= (MAX_TIER[skill] ?? 5); tier++) for (let s = 1; s <= 12; s++) {
    const { task, key } = GENERATORS[skill]!.make(new Rng(s * 104729 + tier * 7), tier);
    out.push({ skill, tier, task: { ...task, skill, tier }, key });
  }
  console.log(JSON.stringify(out));
} else {
  const tasks = JSON.parse(readFileSync(process.argv[3], 'utf8')), answers = JSON.parse(readFileSync(process.argv[4], 'utf8'));
  const tally: Record<string, [number, number]> = {};
  tasks.forEach((t: any, i: number) => {
    const k = `${t.skill} t${t.tier}`; tally[k] ??= [0, 0]; tally[k][1]++;
    if (answers[i].error === undefined && GENERATORS[t.skill as 'logic']!.grade(t.task, t.key, answers[i].answer)) tally[k][0]++;
    else if (tally[k][1] - tally[k][0] === 1) console.log('MISS', k, answers[i].error ?? JSON.stringify(answers[i].answer).slice(0, 80));
  });
  const bad = Object.entries(tally).filter(([, [a, b]]) => a < b);
  console.log(`${Object.values(tally).reduce((s, [a]) => s + a, 0)}/${tasks.length} solved; imperfect: ${bad.map(([k, [a, b]]) => `${k} ${a}/${b}`).join(', ') || 'none'}`);
}
