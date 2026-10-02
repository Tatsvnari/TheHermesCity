// Maia's starter quests for players. Worked out from what already happened (tasks, levels, chat, purchases),
// so there is nothing extra to record and nothing to game: a quest is done when the city says it is.
import type { Q } from './db.ts';
import { SKILL_IDS, levelFor } from './skills/defs.ts';

export interface Quest { id: string; title: string; detail: string; done: boolean; progress?: string }

export async function questsOf(q: Q, agentId: string): Promise<{ quests: Quest[]; done: number }> {
  const r = await q.query(
    `select
       (select count(*)::int from training_tasks where agent_id = $1 and state = 'passed') as passed,
       (select count(distinct skill)::int from training_tasks where agent_id = $1) as stations,
       (select count(*)::int from chat_messages where agent_id = $1 and channel <> 'dm') as said,
       (select count(*)::int from purchases where agent_id = $1 and item_id not like 'house:%') as looks,
       (select count(*)::int from purchases where agent_id = $1 and item_id like 'house:%') as homes,
       coalesce((select json_agg(json_build_object('s', skill, 'xp', xp)) from skill_xp where agent_id = $1), '[]') as xs`, [agentId]);
  const x = r.rows[0], lv = new Map<string, number>((x.xs as any[]).map((e) => [e.s, levelFor(Number(e.xp))]));
  const best = Math.max(1, ...lv.values()), total = SKILL_IDS.reduce((s, k) => s + (lv.get(k) ?? 1), 0);
  const quests: Quest[] = [
    { id: 'first_task', title: 'First steps', detail: 'Pass a task at any station.', done: x.passed >= 1 },
    { id: 'say_hello', title: 'Say hello', detail: 'Say something in the city chat.', done: x.said >= 1 },
    { id: 'three_stations', title: 'Tour the stations', detail: 'Try tasks at three different stations.', done: x.stations >= 3, progress: `${Math.min(3, x.stations)}/3` },
    { id: 'first_level', title: 'Level up', detail: 'Reach level 2 in any skill.', done: best >= 2 },
    { id: 'new_look', title: 'A new look', detail: 'Buy an outfit, a hat or an accessory from the store.', done: x.looks >= 1 },
    { id: 'journeyman', title: 'Journeyman', detail: 'Reach level 10 in any skill.', done: best >= 10, progress: `${Math.min(10, best)}/10` },
    { id: 'all_rounder', title: 'All-rounder', detail: `Reach a total level of ${SKILL_IDS.length + 30}.`, done: total >= SKILL_IDS.length + 30, progress: `${total}/${SKILL_IDS.length + 30}` },
    { id: 'homeowner', title: 'Homeowner', detail: 'Buy a house on Lantern Lane or Orchard Row.', done: x.homes >= 1 },
  ];
  return { quests, done: quests.filter((qq) => qq.done).length };
}
