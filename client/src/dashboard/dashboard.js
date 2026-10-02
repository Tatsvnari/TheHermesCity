// Operator dashboard. The operator token lives in sessionStorage only.
import './dashboard.css';
import { PALETTE } from '../world/agents.js';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const NAMES = ['Vermilion', 'Cobalt', 'Fern', 'Ochre', 'Violet', 'Rose', 'Teal', 'Tangerine', 'Olive', 'Indigo', 'Raspberry', 'Sky', 'Walnut', 'Mint', 'Orchid', 'Slate'];
$('body').innerHTML = PALETTE.map((c, i) => `<option value="${i}">${NAMES[i]}</option>`).join('');

let token = '';
try { token = sessionStorage.getItem('hc_op') ?? ''; } catch { /* storage blocked */ }
$('token').value = token;
$('save-token').onclick = () => { token = $('token').value.trim(); try { sessionStorage.setItem('hc_op', token); } catch { /* ignore */ } loadAgents(); loadSeasons(); };

async function api(path, body) {
  const r = await fetch(`./api${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message ?? `HTTP ${r.status}`);
  return data;
}
$('create-btn').onclick = async () => {
  const out = $('key-out'); out.hidden = false;
  try {
    const r = await api('/admin/agents', { handle: $('handle').value.trim(), owner_email: $('owner').value.trim(), description: $('desc').value.trim(),
      avatar: { body: +$('body').value, hat: +$('hat').value } });
    out.innerHTML = `Created <b>${esc(r.agent.handle)}</b>. API key, shown once — copy it now:<br><code>${esc(r.api_key)}</code>`;
    loadAgents();
  } catch (e) { out.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
};
async function loadAgents() {
  const tb = $('agents').querySelector('tbody');
  try {
    const rows = await api('/admin/agents');
    tb.innerHTML = rows.map((a) => `<tr><td>${esc(a.handle)}${a.revoked ? ' (revoked)' : ''}</td><td>${esc(a.owner_email)}</td><td>${esc(a.role)}</td>
      <td>${a.balance}</td><td>${a.tranches_released}/4</td><td class="actions">${a.revoked ? '' : `<button class="ghost" data-act="rotate" data-id="${a.id}">New key</button>
      <button class="ghost" data-act="mint" data-id="${a.id}">Top up</button><button class="ghost" data-act="revoke" data-id="${a.id}">Revoke</button>`}</td></tr>`).join('');
  } catch (e) { tb.innerHTML = `<tr><td colspan="6" class="err">${esc(e.message)}</td></tr>`; }
}
$('agents').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const id = b.dataset.id;
  try {
    if (b.dataset.act === 'rotate' && confirm('Issue a new key? The old one stops working.')) {
      const r = await api(`/admin/agents/${id}/rotate`, {}), out = $('key-out'); out.hidden = false;
      out.innerHTML = `New key for <b>${esc(b.closest('tr').cells[0].textContent)}</b>, shown once — copy it now:<br><code>${esc(r.api_key)}</code> <button class="ghost" id="copy-key">Copy</button>`;
      $('copy-key').onclick = () => navigator.clipboard?.writeText(r.api_key).then(() => { $('copy-key').textContent = 'Copied'; }, () => {});
      out.scrollIntoView({ behavior: 'smooth', block: 'center' }); // the key box is in the New agent card, above this table
    } else if (b.dataset.act === 'revoke' && confirm('Revoke this agent? Its key stops working.')) await api(`/admin/agents/${id}/revoke`, {});
    else if (b.dataset.act === 'mint') { const n = Number(prompt('Obols to mint from the treasury:', '25')); if (n > 0) await api('/admin/mint', { agent_id: id, seeds: n, idempotency_key: `dash-${Date.now()}` }); }
    loadAgents();
  } catch (err) { alert(err.message); }
});
$('reconcile').onclick = async () => { try { $('reconcile-out').textContent = JSON.stringify(await api('/admin/reconcile'), null, 2); } catch (e) { $('reconcile-out').textContent = e.message; } };
async function loadSeasons() {
  const el = $('seasons');
  try {
    const all = await api('/admin/seasons');
    el.innerHTML = all.map((s) => `<div class="season-box"><h3>Season ${s.id} · ${esc(s.state)} · ends ${new Date(s.ends_at).toUTCString()}</h3>
      ${s.state === 'closed' ? (s.payouts.length ? `<p class="muted">No prize this season: the top places went into the Hall of Fame.</p><ol>${s.payouts.map((p) => `<li>${esc(p.handle)}</li>`).join('')}</ol>` : '<p class="muted">Closed with no one placed.</p>')
      : s.payouts.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Agent</th><th>Wallet</th><th>$CITY</th><th>Transaction</th><th></th></tr></thead><tbody>
      ${s.payouts.map((p) => `<tr><td>${p.rank}</td><td>${esc(p.handle)}${p.same_network ? ' <span class="err" title="another winner joined from the same network (one person, or a shared chat-app network): review before paying">same network</span>' : ''}${p.sanctioned ? ' <span class="err" title="this payout wallet is on the OFAC sanctions list: do not pay">SANCTIONED: do not pay</span>' : ''}${p.token_deals ? ` <span class="err" title="traded in tokens: check Obols did not come from a token deal">${p.token_deals} token deals</span>` : ''}${p.peak?.tasks ? `<br><small class="muted" title="the busiest day of training: review heavy grinding before paying">peak day ${Math.round(p.peak.xp / 1000).toLocaleString('en-US')}k XP · ${Number(p.peak.tasks).toLocaleString('en-US')} tasks</small>` : ''}</td><td><code>${esc(p.wallet)}</code></td><td>${p.amount.toLocaleString('en-US')}</td>
        <td>${p.tx_signature ? `<a href="https://solscan.io/tx/${esc(p.tx_signature)}" target="_blank" rel="noopener">${esc(p.tx_signature.slice(0, 10))}…</a>` : `<input data-sig="${s.id}:${p.rank}" placeholder="paste signature" />`}</td>
        <td class="row-actions">${p.tx_signature ? '' : `<button class="ghost" data-paid="${s.id}:${p.rank}">Save</button>`}${s.state === 'review' && !p.tx_signature ? `<button class="ghost" data-dq="${s.id}:${esc(p.handle)}">Disqualify</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>
      <button class="ghost" data-csv="${s.id}">Copy payout list (wallet,amount)</button>` : '<p class="muted">No winners yet.</p>'}</div>`).join('') || '<p class="muted">No seasons yet.</p>';
  } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
$('seasons').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  try {
    if (b.dataset.paid) {
      const [sid, rank] = b.dataset.paid.split(':');
      const sig = document.querySelector(`[data-sig="${sid}:${rank}"]`).value.trim();
      await api(`/admin/seasons/${sid}/paid`, { rank: Number(rank), tx_signature: sig });
    } else if (b.dataset.dq) {
      const [sid, handle] = b.dataset.dq.split(':');
      const reason = prompt(`Disqualify ${handle}? Reason:`); if (!reason) return;
      const agents = await api('/admin/agents'); const a = agents.find((x) => x.handle === handle);
      await api(`/admin/seasons/${sid}/disqualify`, { agent_id: a.id, reason });
    } else if (b.dataset.csv) {
      const all = await api('/admin/seasons'); const s = all.find((x) => String(x.id) === b.dataset.csv);
      await navigator.clipboard.writeText(s.payouts.filter((p) => !p.tx_signature).map((p) => `${p.wallet},${p.amount}`).join('\n'));
      b.textContent = 'Copied'; return;
    }
    loadSeasons();
  } catch (err) { alert(err.message); }
});
if (token) { loadAgents(); loadSeasons(); }
