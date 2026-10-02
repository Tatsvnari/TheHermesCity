// Solana, read-only and keyless: the city reads the chain (mints, balances, transactions) and builds unsigned payment
// transactions for a buyer's own wallet to sign. It never holds a private key.
import { createPublicKey, verify } from 'node:crypto';
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Config } from './config.ts';
import { ApiError } from './types.ts';

// ---------- base58 ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes: Uint8Array): string {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}
export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) throw new Error('not base58'); n = n * 58n + BigInt(i); }
  const out: number[] = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of s) { if (ch !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
}
export const isAddress = (s: string) => { try { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && b58decode(s).length === 32; } catch { return false; } };

/** Did `address` (an ed25519 public key) sign `message`? The signature may be base58 or base64. */
export function verifySignature(address: string, message: string, signature: string) {
  const s = String(signature ?? '').trim(), tries: Buffer[] = [];
  try { tries.push(Buffer.from(b58decode(s))); } catch { /* not base58 */ }
  tries.push(Buffer.from(s, 'base64'));
  let key;
  try { key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(b58decode(address))]), format: 'der', type: 'spki' }); } catch { return false; }
  return tries.some((sig) => { try { return sig.length === 64 && verify(null, Buffer.from(message, 'utf8'), key, sig); } catch { return false; } });
}

// ---------- tokens ----------
export interface TokenInfo { symbol: 'USDC' | 'CITY'; mint: string; decimals: number; program: string }
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
let conn: Connection | null = null, connUrl = '';
const connection = (c: Config) => { if (!conn || connUrl !== c.solanaRpc) { conn = new Connection(c.solanaRpc, 'confirmed'); connUrl = c.solanaRpc; } return conn; };
/** Tests swap the chain for a stand-in. */
export let chain = {
  async mintInfo(c: Config, mint: string): Promise<{ decimals: number; program: string }> {
    const a = await connection(c).getParsedAccountInfo(new PublicKey(mint));
    const v: any = a.value; if (!v) throw new ApiError(502, 'chain', 'could not read the token mint');
    return { decimals: v.data.parsed.info.decimals, program: v.owner.toBase58() };
  },
  async blockhash(c: Config) { return (await connection(c).getLatestBlockhash('confirmed')).blockhash; },
  async signaturesFor(c: Config, address: string) { return connection(c).getSignaturesForAddress(new PublicKey(address), { limit: 10 }, 'confirmed'); },
  async transaction(c: Config, sig: string) { return connection(c).getParsedTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); },
};
export const setChain = (x: typeof chain) => { chain = x; };
const mints = new Map<string, { decimals: number; program: string }>();
export async function token(c: Config, symbol: string): Promise<TokenInfo> {
  const sym = String(symbol ?? '').toUpperCase() as TokenInfo['symbol'];
  const mint = sym === 'USDC' ? c.usdcMint : sym === 'CITY' ? c.cityMint : '';
  if (!mint) throw new ApiError(400, 'bad_token', 'pay in USDC or CITY');
  if (!mints.has(mint)) mints.set(mint, await chain.mintInfo(c, mint));
  return { symbol: sym, mint, ...mints.get(mint)! };
}
/** Whole tokens (e.g. "2.5") to base units, exactly. */
export function toBase(amount: string | number, decimals: number): bigint {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new ApiError(400, 'bad_amount', 'amount must be a positive number');
  const [w, f = ''] = s.split('.');
  if (f.length > decimals) throw new ApiError(400, 'bad_amount', `at most ${decimals} decimal places`);
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

// ---------- paying ----------
/** A Solana Pay transfer request: any Solana Pay wallet pays it by scanning or opening the link. */
export function payUrl(p: { to: string; amount: string; mint: string; reference: string; label: string; message: string; memo: string }) {
  const q = new URLSearchParams({ amount: p.amount, 'spl-token': p.mint, reference: p.reference, label: p.label, message: p.message, memo: p.memo });
  return `solana:${p.to}?${q.toString()}`;
}
/** The same payment as an unsigned transaction for the buyer's wallet to sign and send (the buyer pays the fee, and
 *  the seller's token account is created if it does not exist yet). */
export async function buildPayment(c: Config, p: { from: string; to: string; token: TokenInfo; amount: string; reference: string; memo: string }) {
  const programId = new PublicKey(p.token.program), mint = new PublicKey(p.token.mint), payer = new PublicKey(p.from), seller = new PublicKey(p.to);
  const fromAta = getAssociatedTokenAddressSync(mint, payer, true, programId), toAta = getAssociatedTokenAddressSync(mint, seller, true, programId);
  const transfer = createTransferCheckedInstruction(fromAta, mint, toAta, payer, toBase(p.amount, p.token.decimals), p.token.decimals, [], programId);
  transfer.keys.push({ pubkey: new PublicKey(p.reference), isSigner: false, isWritable: false });
  const tx = new Transaction({ feePayer: payer, recentBlockhash: await chain.blockhash(c) }).add(
    createAssociatedTokenAccountIdempotentInstruction(payer, toAta, seller, mint, programId),
    transfer,
    new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(p.memo, 'utf8') }),
  );
  return {
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    message: b58encode(tx.serializeMessage()), // for wallets that sign a message (Phantom's signAndSendTransaction request)
  };
}

/** Look for a payment carrying `reference` that moved at least `amount` of the token into the seller's wallet. */
export async function findPayment(c: Config, p: { reference: string; to: string; mint: string; decimals: number; amount: string }) {
  const need = toBase(p.amount, p.decimals);
  for (const s of await chain.signaturesFor(c, p.reference)) {
    if (s.err) continue;
    const tx: any = await chain.transaction(c, s.signature);
    if (!tx || tx.meta?.err) continue;
    const bal = (list: any[]) => (list ?? []).filter((b) => b.owner === p.to && b.mint === p.mint).reduce((t, b) => t + BigInt(b.uiTokenAmount.amount), 0n);
    const got = bal(tx.meta.postTokenBalances) - bal(tx.meta.preTokenBalances);
    if (got >= need) {
      const payer = tx.transaction?.message?.accountKeys?.find((k: any) => k.signer)?.pubkey?.toString?.() ?? null;
      return { signature: s.signature, received: got.toString(), payer };
    }
  }
  return null;
}
