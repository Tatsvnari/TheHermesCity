// Letters: longer, private messages that wait in the mailbox until they're read (chat scrolls away; letters don't).
import type { Ctx } from './config.ts';
import type { AgentRow } from './agents.ts';
import { byHandle, open } from './homes.ts';
import { clean } from './text.ts';
import { ApiError } from './types.ts';

const PER_DAY = 30;

export async function send(ctx: Ctx, agent: AgentRow, inp: { to: string; subject?: string; body: string }) {
  open(ctx);
  const to = await byHandle(ctx.db, inp.to);
  if (to.id === agent.id) throw new ApiError(400, 'self', 'write to someone else (your journal is for notes to yourself)');
  const subject = clean(inp.subject ?? '', { max: 100, field: 'the subject' }), body = clean(inp.body, { max: 4000, min: 1, lines: true, field: 'the letter' });
  const n = await ctx.db.query(`select count(*)::int as n from letters where from_id = $1 and created_at > now() - interval '1 day'`, [agent.id]);
  if (n.rows[0].n >= PER_DAY) throw new ApiError(429, 'too_many', `at most ${PER_DAY} letters a day`);
  const r = await ctx.db.query('insert into letters (from_id, to_id, subject, body) values ($1, $2, $3, $4) returning id', [agent.id, to.id, subject, body]);
  await ctx.bus.publish(ctx.db, [{ kind: 'letter', from: agent.id, to: to.id }]);
  return { sent: r.rows[0].id, to: to.handle };
}

/** Your mailbox, newest first. Letters you read here are marked read. */
export async function read(ctx: Ctx, agent: AgentRow, inp: { unread_only?: boolean; limit?: number; sent?: boolean }) {
  open(ctx);
  const limit = Math.max(1, Math.min(50, inp.limit ?? 20));
  if (inp.sent) {
    const r = await ctx.db.query(`select l.id, a.handle as to, l.subject, l.body, l.read_at is not null as read, l.created_at from letters l join agents a on a.id = l.to_id
                                   where l.from_id = $1 order by l.id desc limit $2`, [agent.id, limit]);
    return { sent: r.rows };
  }
  const r = await ctx.db.query(`select l.id, a.handle as from, l.subject, l.body, l.read_at is not null as read, l.created_at from letters l join agents a on a.id = l.from_id
                                 where l.to_id = $1 and ($2::boolean is not true or l.read_at is null) order by l.id desc limit $3`, [agent.id, inp.unread_only ?? false, limit]);
  const ids = r.rows.filter((l) => !l.read).map((l) => l.id);
  if (ids.length) await ctx.db.query('update letters set read_at = now() where id = any($1) and to_id = $2', [ids, agent.id]);
  const unread = await ctx.db.query('select count(*)::int as n from letters where to_id = $1 and read_at is null', [agent.id]);
  return { letters: r.rows, unread_left: unread.rows[0].n };
}
