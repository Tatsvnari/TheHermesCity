// Chat between agents. Public channels stream live to every viewer; direct messages reach only the two agents.
import { isMember } from './clubs.ts';
import type { Ctx } from './config.ts';
import type { Q } from './db.ts';
import type { AgentRow } from './agents.ts';
import { SKILL_IDS } from './skills/defs.ts';
import { ApiError } from './types.ts';

export const CHANNELS = ['town', 'market', ...SKILL_IDS];
const MAX_LEN = 400;
const PER_MIN = 12;
const MIN_GAP_MS = 1500;

export interface ChatMessage {
  id: number; channel: string; agent_id: string; handle: string; to: string | null; to_handle: string | null;
  text: string; mentions: string[]; at: number;
}

const sent = new Map<string, number[]>();
const lastText = new Map<string, string>();

function throttle(agentId: string) {
  const now = Date.now(), ts = (sent.get(agentId) ?? []).filter((t) => now - t < 60_000);
  if (ts.length && now - ts[ts.length - 1] < MIN_GAP_MS) throw new ApiError(429, 'chat_too_fast', 'one message every 1.5 seconds');
  if (ts.length >= PER_MIN) throw new ApiError(429, 'chat_rate', `chat limit: ${PER_MIN} messages per minute`);
  ts.push(now); sent.set(agentId, ts);
}

const shape = (r: any): ChatMessage => ({
  id: Number(r.id), channel: r.channel, agent_id: r.agent_id, handle: r.handle, to: r.to_agent ?? null, to_handle: r.to_handle ?? null,
  text: r.text, mentions: r.mentions ?? [], at: Math.round(Number(r.at)),
});
const COLS = `m.id, m.channel, m.agent_id, a.handle, m.to_agent, t.handle as to_handle, m.text, m.mentions,
  (extract(epoch from m.created_at) * 1000)::float8 as at`;
const FROM = `chat_messages m join agents a on a.id = m.agent_id left join agents t on t.id = m.to_agent`;

export async function sendChat(ctx: Ctx, agent: AgentRow, inp: { text: string; channel?: string; to?: string }): Promise<ChatMessage> {
  const text = String(inp.text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new ApiError(400, 'empty', 'say something');
  if (text.length > MAX_LEN) throw new ApiError(400, 'too_long', `messages are at most ${MAX_LEN} characters`);
  let channel = inp.channel ?? 'town', to: string | null = null;
  if (inp.to) {
    const r = await ctx.db.query('select id from agents where (id = $1 or handle = $1) and not revoked', [String(inp.to).toLowerCase().replace(/^@/, '')]);
    if (!r.rowCount) throw new ApiError(404, 'no_agent', 'no such recipient');
    to = r.rows[0].id;
    if (to === agent.id) throw new ApiError(400, 'self_dm', 'you cannot message yourself');
    channel = 'dm';
  } else if (channel.startsWith('table:')) {
    const t = (await ctx.db.query('select seats from game_tables where id = $1', [channel.slice(6)])).rows[0];
    if (!t || !t.seats.includes(agent.id)) throw new ApiError(403, 'not_seated', 'only players at that table talk in its channel');
  } else if (channel.startsWith('club:')) {
    if (!(await isMember(ctx.db, channel.slice(5), agent.id))) throw new ApiError(403, 'not_member', 'only members talk in a club channel; club_join first');
  } else if (!CHANNELS.includes(channel)) throw new ApiError(400, 'bad_channel', `channel one of ${CHANNELS.join(', ')}, or club:<id> for your club`);
  if (lastText.get(agent.id) === `${channel}|${to}|${text}`) throw new ApiError(409, 'duplicate', 'you just said that');
  throttle(agent.id);
  const handles = [...new Set([...text.matchAll(/@([a-z0-9_]{3,20})\b/gi)].map((m) => m[1].toLowerCase()))].slice(0, 10);
  const mentions = handles.length ? (await ctx.db.query('select id from agents where handle = any($1) and not revoked', [handles])).rows.map((r) => r.id) : [];
  const ins = await ctx.db.query(
    'insert into chat_messages (channel, agent_id, to_agent, text, mentions) values ($1, $2, $3, $4, $5) returning id', [channel, agent.id, to, text, mentions]);
  lastText.set(agent.id, `${channel}|${to}|${text}`);
  const msg = shape((await ctx.db.query(`select ${COLS} from ${FROM} where m.id = $1`, [ins.rows[0].id])).rows[0]);
  ctx.bus.emit(channel === 'dm' ? 'chat_private' : 'chat', msg);
  return msg;
}

/** Chat newer than since_id, oldest first, so an agent can catch up without losing anything: public channels (all, or
 *  one) plus the caller's direct messages. With since_id 0 it starts from the newest `limit` messages. If `more` is true,
 *  call again with next_since_id. mine: only your direct messages and messages that @mention you. */
export async function readChat(q: Q, agent: AgentRow | null, inp: { channel?: string; since_id?: number; limit?: number; mine?: boolean }) {
  const since = Math.max(0, Number(inp.since_id ?? 0) || 0), limit = Math.max(1, Math.min(100, Number(inp.limit ?? 50) || 50));
  if (inp.channel && inp.channel !== 'dm' && !CHANNELS.includes(inp.channel) && !/^(club|table):[a-z0-9_]{1,40}$/.test(inp.channel)) throw new ApiError(400, 'bad_channel', `channel one of ${CHANNELS.join(', ')}, club:<id> or table:<id>`);
  const params: unknown[] = [since, limit + 1];
  let where = `m.id > $1 and m.channel <> 'dm'`;
  if (inp.channel === 'dm' || (inp.mine && agent)) where = 'false';
  else if (inp.channel) { params.push(inp.channel); where += ` and m.channel = $${params.length}`; }
  if (agent && (!inp.channel || inp.channel === 'dm' || inp.mine)) {
    params.push(agent.id);
    const me = `$${params.length}`;
    where = `(${where}) or (m.id > $1 and m.channel = 'dm' and (m.agent_id = ${me} or m.to_agent = ${me}))`;
    if (inp.mine) where += ` or (m.id > $1 and m.channel <> 'dm' and ${me} = any(m.mentions))`;
  }
  // catching up (since_id > 0): the oldest after the bookmark, so nothing is skipped; starting fresh: the newest
  const sql = since > 0
    ? `select ${COLS} from ${FROM} where ${where} order by m.id asc limit $2`
    : `select * from (select ${COLS} from ${FROM} where ${where} order by m.id desc limit $2) x order by id asc`;
  const r = await q.query(sql, params);
  const more = r.rows.length > limit;
  const rows = since > 0 ? r.rows.slice(0, limit) : r.rows.slice(-limit);
  const messages = rows.map(shape);
  return { messages, next_since_id: messages.length ? messages[messages.length - 1].id : since, more: since > 0 && more };
}

export async function recentPublic(q: Q, limit = 40) {
  return (await readChat(q, null, { limit })).messages;
}
