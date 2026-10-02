// Playing on another device. A player makes a one-time code on the device they play on (it comes with a link that
// carries it) and enters the code, or opens the link, on the other device to carry on as the same player there. The
// code works once, for 15 minutes, and the first device stays signed in. For those minutes the server keeps the
// player's key encrypted under the code and a server secret: neither the database nor the code alone opens it.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import type { Ctx } from './config.ts';
import type { AgentRow } from './agents.ts';
import { authenticate } from './agents.ts';
import { ApiError } from './types.ts';

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O, 1/I/L: easy to read off one screen and type on another
const LEN = 8, MINUTES = 15;
const idOf = (code: string) => createHash('sha256').update(`device:${code}`).digest('hex');
const keyOf = (ctx: Ctx, code: string) => createHmac('sha256', ctx.config.joinSalt).update(`device:${code}`).digest();
const tidy = (raw: unknown) => String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** A fresh code for this player (any earlier one stops working). `key` is the key the request came with. */
export async function createLink(ctx: Ctx, agent: AgentRow, key: string) {
  if (agent.role !== 'player') throw new ApiError(403, 'not_player', 'device codes are for players; an agent keeps its own api_key');
  const code = Array.from({ length: LEN }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', keyOf(ctx, code), iv);
  const enc = Buffer.concat([c.update(key, 'utf8'), c.final()]), tag = c.getAuthTag();
  await ctx.db.query('delete from device_links where agent_id = $1 or expires_at < now()', [agent.id]);
  await ctx.db.query('insert into device_links (id, agent_id, iv, tag, enc, expires_at) values ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))',
    [idOf(code), agent.id, iv, tag, enc, MINUTES]);
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_in_minutes: MINUTES };
}

/** Trade a code for the player's key, once. */
export async function redeem(ctx: Ctx, raw: unknown) {
  const code = tidy(raw);
  if (code.length !== LEN) throw new ApiError(400, 'bad_code', 'enter the 8-character code shown on your other device');
  const row = (await ctx.db.query('delete from device_links where id = $1 returning *', [idOf(code)])).rows[0];
  if (!row || new Date(row.expires_at) < new Date()) throw new ApiError(404, 'no_code', 'that code has expired or was already used: make a new one on your other device (Me, then Play on another device)');
  let key: string;
  try {
    const d = createDecipheriv('aes-256-gcm', keyOf(ctx, code), row.iv);
    d.setAuthTag(row.tag);
    key = Buffer.concat([d.update(row.enc), d.final()]).toString('utf8');
  } catch { throw new ApiError(404, 'no_code', 'that code does not work any more: make a new one on your other device'); }
  const agent = await authenticate(ctx.db, key); // the key may have been rotated or revoked since
  return { id: agent.id, handle: agent.handle, api_key: key };
}
