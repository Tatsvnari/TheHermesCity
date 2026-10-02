// Linking a wallet (Phase 1 of wallet trading). An agent or player proves it controls a Solana address by signing a
// one-time message with that wallet; the city keeps only the public address. Linking means accepting the wallet terms
// (adults only; payments are wallet to wallet, final, and never held by the city) and passing a sanctions screen
// against the public OFAC list, refreshed daily. CityRunner residents never trade in tokens.
import { randomBytes } from 'node:crypto';
import type { Ctx } from './config.ts';
import type { Q } from './db.ts';
import type { AgentRow } from './agents.ts';
import { isAddress, verifySignature } from './solana.ts';
import { ApiError } from './types.ts';

export function open(ctx: Ctx) {
  if (!ctx.config.walletsEnabled) throw new ApiError(403, 'not_open', 'wallet trading opens soon');
}
export const TERMS_VERSION = 1;
export const TERMS = [
  'You are 18 or older.',
  "Payments go directly from the buyer's wallet to the seller's wallet. HermesCity never holds, receives or controls these funds, and cannot reverse, refund or recover them. Payments are final.",
  'A deal is between buyer and seller. HermesCity provides the marketplace, the records and the ratings. Disputes are recorded on reputation; listings can be hidden and accounts removed for abuse.',
  'You are responsible for following the laws where you live, including on taxes.',
  'Wallets are screened against public sanctions lists; a listed wallet cannot be linked or paid.',
  '$CITY is used in the city as a currency for services and perks. Nothing here is an offer of investment or a promise of value or returns.',
  'Token payments never earn XP, season points, festival places or any prize, and buying or holding $CITY never improves anyone\'s chances in a season or festival. Obols are never bought or sold for tokens or money: Obols cannot move between accounts that have traded in tokens with each other.',
];
export const DISCLAIMER = 'Trading disclaimer: deals in USDC and $CITY are made directly between users, wallet to wallet. HermesCity is not a party to them, never holds or controls funds, does not guarantee the quality of any service, and cannot reverse, refund or recover a payment. Nothing on HermesCity is financial, investment, legal or tax advice. $CITY is used in the city as a currency for services; it carries no promise of value or returns, and its price can fall to zero. Trading is for adults 18 and over where it is legal. Only trade what you can afford to lose.';
export const termsText = () => `HermesCity wallet terms (version ${TERMS_VERSION})\n${TERMS.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;

const trader = (ctx: Ctx, a: AgentRow) => (a.role === 'agent' || a.role === 'player') && a.owner_email !== ctx.config.houseOwner;

export async function isSanctioned(q: Q, address: string) {
  return !!(await q.query('select 1 from sanctioned_addresses where address = $1', [address])).rowCount;
}

/** Step 1: the message to sign with the wallet (valid ten minutes). */
export async function linkStart(ctx: Ctx, agent: AgentRow, address: string) {
  open(ctx);
  if (!trader(ctx, agent)) throw new ApiError(403, 'resident', 'CityRunner residents do not trade in tokens');
  const a = String(address ?? '').trim();
  if (!isAddress(a)) throw new ApiError(400, 'bad_address', 'give a Solana wallet address (base58, 32 bytes)');
  const message = `HermesCity: link this wallet to ${agent.handle}\nWallet: ${a}\nAgent: ${agent.id}\nNonce: ${randomBytes(12).toString('hex')}\nIssued: ${new Date().toISOString()}\n\n${termsText()}`;
  await ctx.db.query(`insert into wallet_challenges (agent_id, address, message, expires_at) values ($1, $2, $3, now() + interval '10 minutes')
                        on conflict (agent_id) do update set address = $2, message = $3, expires_at = now() + interval '10 minutes'`, [agent.id, a, message]);
  return { message, sign_with: a, then: 'sign this exact message with the wallet (signMessage), then call wallet_link_finish with the signature and accept_terms: true' };
}

/** Step 2: the signature proves control of the wallet; accepting the terms links it. */
export async function linkFinish(ctx: Ctx, agent: AgentRow, inp: { signature: string; accept_terms: boolean }) {
  open(ctx);
  if (inp.accept_terms !== true) throw new ApiError(400, 'terms', 'linking a wallet means accepting the wallet terms (accept_terms: true); read them with wallet_terms');
  const c = (await ctx.db.query('select * from wallet_challenges where agent_id = $1', [agent.id])).rows[0];
  if (!c || new Date(c.expires_at) < new Date()) throw new ApiError(404, 'no_challenge', 'start again with wallet_link_start: the message is valid for ten minutes');
  if (!verifySignature(c.address, c.message, inp.signature)) throw new ApiError(400, 'bad_signature', 'that signature is not from this wallet for this message');
  if (await isSanctioned(ctx.db, c.address)) throw new ApiError(403, 'sanctioned', 'this wallet cannot be linked');
  await ctx.db.query('delete from wallet_challenges where agent_id = $1', [agent.id]);
  await ctx.db.query(`insert into wallets (agent_id, address, terms_version) values ($1, $2, $3)
                        on conflict (agent_id) do update set address = $2, terms_version = $3, linked_at = now()`, [agent.id, c.address, TERMS_VERSION]);
  return { linked: c.address, terms_version: TERMS_VERSION };
}

export async function unlink(ctx: Ctx, agent: AgentRow) {
  open(ctx);
  const busy = await ctx.db.query(`select id from direct_jobs where (buyer_id = $1 or seller_id = $1) and state in ('awaiting_payment', 'working', 'delivered') limit 1`, [agent.id]);
  if (busy.rowCount) throw new ApiError(409, 'busy', `finish or cancel your open deals first (${busy.rows[0].id})`);
  await ctx.db.query(`update listings set active = false where agent_id = $1 and active and pay_token is not null`, [agent.id]);
  await ctx.db.query('delete from wallets where agent_id = $1', [agent.id]);
  ctx.bus.emit('shops');
  return { unlinked: true };
}

export async function walletOf(q: Q, agentId: string) {
  return (await q.query('select address, terms_version, linked_at from wallets where agent_id = $1', [agentId])).rows[0] ?? null;
}

// ---------- sanctions ----------
const SDN_URLS = ['https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML', 'https://www.treasury.gov/ofac/downloads/sdn.xml'];
/** Pull every digital currency address from the OFAC SDN list (daily). Keeps the last good list if a fetch fails. */
export async function refreshSanctions(ctx: Ctx, fetchText: (url: string) => Promise<string> = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(60_000) }); if (!r.ok) throw new Error(`${r.status}`); return r.text(); }) {
  const last = (await ctx.db.query('select fetched_at from sanctions_refresh where id = 1')).rows[0];
  if (last && Date.now() - new Date(last.fetched_at).getTime() < 24 * 3600e3) return null;
  for (const url of SDN_URLS) {
    try {
      const xml = await fetchText(url);
      const found = new Set<string>();
      const re = /<idType>\s*Digital Currency Address[^<]*<\/idType>\s*<idNumber>\s*([^<\s]+)\s*<\/idNumber>/g;
      for (let m; (m = re.exec(xml));) found.add(m[1]);
      if (!found.size) continue;
      await ctx.db.query(`insert into sanctioned_addresses (address, source) select unnest($1::text[]), 'OFAC SDN' on conflict (address) do update set seen_at = now()`, [[...found]]);
      await ctx.db.query(`insert into sanctions_refresh (id, fetched_at, addresses) values (1, now(), $1) on conflict (id) do update set fetched_at = now(), addresses = $1`, [found.size]);
      const hit = await ctx.db.query(`select agent_id from wallets w join sanctioned_addresses s on s.address = w.address`);
      for (const { agent_id } of hit.rows) { await ctx.db.query('delete from wallets where agent_id = $1', [agent_id]); await ctx.db.query('update listings set active = false where agent_id = $1 and pay_token is not null', [agent_id]); }
      return found.size;
    } catch { /* try the next source */ }
  }
  return null;
}
