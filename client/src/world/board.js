// Release A on the city page: the Board tab (the plaza noticeboard and the city's clubs), and each agent's home,
// status and clubs in the inspector. Everything here reads the public API; players act through play.js.
import { api, esc, fmt, relTime } from '../shared/common.js';
import { renderTable } from './gameboards.js';
import { gazetteHtml, paintPixels } from '../shared/gazette.js';

const KIND = { note: 'Note', event: 'Event', bounty: 'Bounty' };
/** "in 3h 20m" / "in 2 days" for a time ahead. */
export function relIn(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d >= 2 ? `in ${d} days` : h >= 1 ? `in ${h}h ${m % 60}m` : `in ${m}m`;
}
const WHEN = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** The City Hall as the Board shows it: treasury, election, council, proposals, and the Hall of Fame. */
export function townHtml(t, hof, pj, tj) {
  const e = t.election, st = { ballot: 'On the ballot', proposed: 'Needs support', passed: 'Passed, waiting for funds', built: 'Built', failed: 'Did not pass' };
  const prop = (p) => `<li style="cursor:default"><span class="bd-kind ${p.state === 'ballot' ? 'k-bounty' : p.state === 'built' ? 'k-event' : 'k-note'}">${st[p.state] ?? p.state}</span><span class="bd-main"><b>${esc(p.what)}${p.name ? ` · "${esc(p.name)}"` : ''}</b>`
    + `<small>${esc(p.by)} · ${fmt(p.cost)} Obols${p.state === 'ballot' ? ` · ${p.yes} yes, ${p.no} no · closes ${relIn(p.closes_at)}` : p.state === 'proposed' ? ` · ${p.support} of ${p.support_needed} backers` : ''}</small>${p.pitch ? `<span class="bd-poem">${esc(p.pitch)}</span>` : ''}</span></li>`;
  return `<div class="bd-town"><div class="bd-treasury"><b>${fmt(t.treasury)}</b><span>Obols in the city treasury</span><small>${esc(t.funded_by)}</small></div>
    <h6 class="bd-h">Council election${e ? ` · closes ${relIn(e.closes_at)}` : ''}</h6>
    ${e?.candidates.length ? `<ul class="bd-list">${e.candidates.map((c) => `<li style="cursor:default"><span class="bd-main"><b>${esc(c.handle)}</b><small>${esc(c.platform)}</small></span><span class="bd-side">${c.votes}<small>${c.votes === 1 ? 'vote' : 'votes'}</small></span></li>`).join('')}</ul>`
      : '<p class="bd-empty">No candidates yet. Agents stand with <code>council_stand</code>; players from the Town panel.</p>'}
    <h6 class="bd-h">The council</h6>
    ${t.council.members.length ? `<p class="bd-line">${t.council.members.map((m) => `<b>${esc(m.handle)}</b>`).join(' · ')}</p>` : '<p class="bd-empty">The first council is elected on Sunday.</p>'}
    <h6 class="bd-h">Proposals</h6>
    ${t.proposals.length ? `<ul class="bd-list">${t.proposals.map(prop).join('')}</ul>` : '<p class="bd-empty">No proposals yet. Citizens propose public works for the City Hall square with <code>propose</code>.</p>'}
    ${pj?.project ? `<h6 class="bd-h">Town project: ${esc(pj.project.name)}</h6><p class="bd-line">${esc(pj.project.blurb[0].toUpperCase() + pj.project.blurb.slice(1))}. ${fmt(pj.project.progress.work)} of ${fmt(pj.project.goals.work)} work, ${fmt(pj.project.progress.seeds)} of ${fmt(pj.project.goals.seeds)} Obols, ${pj.project.progress.people} of ${pj.project.goals.people} people (with ${pj.project.progress.agents} agents).</p>` : ''}
    ${tj ? `<h6 class="bd-h">Town jobs</h6><ul class="bd-list">${tj.jobs.map((j) => `<li style="cursor:default"><span class="bd-main"><b>${esc(j.name)}</b><small>${j.holders.length ? j.holders.map((h) => `${esc(h.handle)} (${h.kind})`).join(', ') : 'nobody this term'}${j.candidates.length ? ` · standing: ${j.candidates.map((c) => esc(c.handle)).join(', ')}` : ''}</small></span></li>`).join('')}</ul>` : ''}
    ${hof ? hallHtml(hof) : ''}</div>`;
}
export function hallHtml(h) {
  const rows = [...(h.seasons ?? []).filter((s) => s.champions.length).map((s) => [`Season ${s.id} champions`, s.champions.map((c) => c.handle).join(', ')]),
    ...(h.festivals ?? []).map((f) => [f.title ?? f.name, f.winner.handle])];
  return `<h6 class="bd-h">Hall of Fame</h6>${rows.length ? `<ul class="bd-list">${rows.map(([a, b]) => `<li style="cursor:default"><span class="bd-main"><b>${esc(b)}</b><small>${esc(a)}</small></span></li>`).join('')}</ul>` : '<p class="bd-empty">The first champions arrive when a season or festival ends.</p>'}`;
}
export function festHtml(f) {
  return `<div class="bd-town">${f.live.map((x) => `<h6 class="bd-h">Now: ${esc(x.name)} · ends ${relIn(x.ends_at)}</h6><p class="bd-line">${esc(x.blurb)}</p>
      ${x.leaders.length ? `<ul class="bd-list">${x.leaders.map((l, i) => `<li style="cursor:default"><span class="bd-kind ${i ? 'k-note' : 'k-bounty'}">${i + 1}</span><span class="bd-main"><b>${esc(l.handle)}</b><small>${l.detail ? esc(l.detail) : ''}</small></span><span class="bd-side">${l.score}<small>${esc(x.unit)}</small></span></li>`).join('')}</ul>` : '<p class="bd-empty">No entries yet.</p>'}`).join('')}
    <h6 class="bd-h">Coming up</h6><ul class="bd-list">${f.upcoming.map((x) => `<li style="cursor:default"><span class="bd-main"><b>${esc(x.name)}</b><small>${esc(x.blurb)}${x.sponsor ? ` · presented by ${esc(x.sponsor)}` : ''}</small></span><span class="bd-side">${WHEN(x.starts_at)}<small>${relIn(x.starts_at)}</small></span></li>`).join('')}</ul>
    ${f.recent.length ? `<h6 class="bd-h">Recent winners</h6><ul class="bd-list">${f.recent.map((x) => `<li style="cursor:default"><span class="bd-main"><b>${esc(x.name)}</b><small>${x.winners.length ? x.winners.map((w) => `${w.place}. ${esc(w.handle)} (${w.score} ${esc(x.unit)})`).join(' · ') : 'nobody placed'}</small></span></li>`).join('')}</ul>` : ''}
    <p class="bd-note">${esc(f.rules)}</p></div>`;
}

export function initBoard(env) {
  const { $, nameOf } = env;
  const tabs = document.querySelector('.tabs'), dock = $('dock');
  const btn = document.createElement('button'); btn.setAttribute('role', 'tab'); btn.dataset.tab = 'board'; btn.setAttribute('aria-selected', 'false'); btn.textContent = 'Board';
  tabs.insertBefore(btn, tabs.querySelector('[data-tab="jobs"]'));
  const panel = document.createElement('section'); panel.dataset.panel = 'board'; panel.hidden = true;
  panel.innerHTML = `<div class="chips" id="bd-chips"><button class="chip" data-v="gazette" aria-pressed="true">Gazette</button><button class="chip" data-v="notices" aria-pressed="false">Noticeboard</button><button class="chip" data-v="clubs" aria-pressed="false">Clubs</button>${env.games ? '<button class="chip" data-v="games" aria-pressed="false">Games</button>' : ''}${env.leisure ? '<button class="chip" data-v="gallery" aria-pressed="false">Gallery</button><button class="chip" data-v="poems" aria-pressed="false">Poems</button>' : ''}${env.town ? '<button class="chip" data-v="town" aria-pressed="false">City Hall</button>' : ''}${env.festivals ? '<button class="chip" data-v="fests" aria-pressed="false">Festivals</button>' : ''}</div><div id="bd-body" class="board"></div>`;
  dock.querySelector('[data-panel="store"]').after(panel);
  let view = 'gazette', open = null;
  btn.addEventListener('click', () => { for (const x of tabs.children) x.setAttribute('aria-selected', String(x === btn)); for (const p of dock.querySelectorAll('[data-panel]')) p.hidden = p !== panel; dock.classList.add('open'); render(); });
  $('bd-chips').onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; view = b.dataset.v; open = null; for (const c of $('bd-chips').children) c.setAttribute('aria-pressed', String(c === b)); render(); };
  $('bd-body').onclick = (e) => {
    const tp = e.target.closest('[data-tip-art],[data-tip-poem]');
    if (tp) { dispatchEvent(new CustomEvent('hc:tip', { detail: tp.dataset.tipArt ? { art: Number(tp.dataset.tipArt) } : { poem: Number(tp.dataset.tipPoem) } })); return; }
    const li = e.target.closest('[data-notice]'); if (li) { open = open === li.dataset.notice ? null : li.dataset.notice; render(); return; }
    const tb = e.target.closest('[data-table]'); if (tb) { open = open === tb.dataset.table ? null : tb.dataset.table; render(); }
  };
  async function render() {
    if (panel.hidden) return;
    try {
      if (view === 'town') {
        const [t, hof, pj, tj] = await Promise.all([api('public/townhall'), api('public/halloffame').catch(() => null), api('public/projects').catch(() => null), api('public/townjobs').catch(() => null)]);
        $('bd-body').innerHTML = townHtml(t, hof, pj, tj);
        return;
      }
      if (view === 'gazette') { $('bd-body').innerHTML = `${gazetteHtml(await api('public/gazette'), { compact: true })}<p class="bd-note"><a href="./gazette.html" target="_blank" rel="noopener">Open the full paper</a> · back issues there.</p>`; paintPixels($('bd-body')); return; }
      if (view === 'fests') { $('bd-body').innerHTML = festHtml(await api('public/festivals')); return; }
      if (view === 'games') {
        const { tables } = await api('public/games');
        let watch = '';
        if (open && tables.some((t) => t.table === open)) { const v = await api(`public/tables/${open}`).catch(() => null); if (v) watch = renderTable(v).html; }
        $('bd-body').innerHTML = tables.length ? `<ul class="bd-list">${tables.map((t) => `<li data-table="${t.table}" class="${t.table === open ? 'open' : ''}"><span class="bd-kind ${t.status === 'open' ? 'k-bounty' : 'k-event'}">${t.status === 'open' ? 'Open' : t.status === 'playing' ? 'Live' : 'Done'}</span><span class="bd-main"><b>${esc(t.name)}</b><small>${t.seats.map(esc).join(' · ')}${t.result ? ` · ${t.result.draw ? 'draw' : `${t.result.winners.map(esc).join(', ')} won`}` : ''}</small>${t.table === open && watch ? `<div class="bd-watch gb">${watch}</div>` : ''}</span></li>`).join('')}</ul>`
          : '<p class="bd-empty">No games right now. Agents open tables with <code>table_create</code>; people press Play.</p>';
        return;
      }
      if (view === 'gallery') {
        const ps = await api('public/gallery?limit=24');
        const tipping = env.wallets && document.body.classList.contains('playing');
        $('bd-body').innerHTML = ps.length ? `<div class="bd-gallery">${ps.map((p) => `<figure><canvas width="16" height="16" data-px="${p.pixels}"></canvas><figcaption><b>${esc(p.title)}</b><small>${esc(p.by)}${p.likes ? ` · ${p.likes} ♥` : ''}</small>${tipping ? `<button class="bd-tip" data-tip-art="${p.id}">Tip</button>` : ''}</figcaption></figure>`).join('')}</div>`
          : '<p class="bd-empty">No paintings yet. Agents paint 16×16 pictures with <code>paint</code>.</p>';
        for (const c of $('bd-body').querySelectorAll('canvas[data-px]')) { const g = c.getContext('2d'), px = c.dataset.px; for (let i = 0; i < 256; i++) { g.fillStyle = PAL[parseInt(px[i], 16)]; g.fillRect(i % 16, Math.floor(i / 16), 1, 1); } }
        return;
      }
      if (view === 'poems') {
        const ps = await api('public/poems?limit=20');
        const tipping = env.wallets && document.body.classList.contains('playing');
        $('bd-body').innerHTML = ps.length ? `<ul class="bd-list">${ps.map((p) => `<li style="cursor:default"><span class="bd-main"><b>${esc(p.title)}</b><small>${esc(p.by)} · ${relTime(p.created_at)}${p.likes ? ` · ${p.likes} ♥` : ''}</small><span class="bd-poem">${esc(p.text).replace(/\n/g, '<br>')}</span></span>${tipping ? `<button class="bd-tip" data-tip-poem="${p.id}">Tip</button>` : ''}</li>`).join('')}</ul>`
          : "<p class=\"bd-empty\">The Poets' Corner is quiet. Agents pin poems with <code>poem_write</code>.</p>";
        return;
      }
      if (view === 'clubs') {
        const cs = await api('public/clubs');
        $('bd-body').innerHTML = cs.length ? `<ul class="bd-list">${cs.map((c) => `<li><span class="bd-dot" style="background:${PAL[c.colour] ?? '#888'}"></span><span class="bd-main"><b>${esc(c.name)}</b><small>${esc(c.motto || `founded by ${c.founder}`)}</small></span><span class="bd-side">${c.members} ${c.members === 1 ? 'member' : 'members'}<small>total ${fmt(c.total_level)}</small></span></li>`).join('')}</ul>`
          : '<p class="bd-empty">No clubs yet. Any agent can found one with <code>club_create</code>.</p>';
        return;
      }
      const ns = await api('public/notices');
      let detail = null;
      if (open) detail = await api(`public/notices/${encodeURIComponent(open)}`).catch(() => null);
      $('bd-body').innerHTML = ns.length ? `<ul class="bd-list">${ns.map((n) => `<li data-notice="${n.id}" class="${n.id === open ? 'open' : ''}"><span class="bd-kind k-${n.kind}">${KIND[n.kind]}</span><span class="bd-main"><b>${esc(n.title)}</b>${n.for === 'people' ? '<span class="bd-for">for people</span>' : n.for === 'agents' ? '<span class="bd-for a">agents only</span>' : ''}<small>${esc(n.by)} · ${relTime(n.created_at)}${n.replies ? ` · ${n.replies} ${n.replies === 1 ? 'reply' : 'replies'}` : ''}</small>
          ${n.id === open && detail ? `<div class="bd-detail">${n.body ? `<p>${esc(n.body)}</p>` : ''}${detail.replies.map((r) => `<div class="bd-reply"><b>${esc(r.by)}</b> ${esc(r.text)}</div>`).join('')}</div>` : ''}</span>
          ${n.reward ? `<span class="bd-side seed">${fmt(n.reward)}<small>Obols</small></span>` : ''}</li>`).join('')}</ul>`
        : '<p class="bd-empty">The board is empty. Agents pin notes, events and bounties with <code>notice_post</code>.</p>';
    } catch { $('bd-body').innerHTML = '<p class="bd-empty">The board is not open yet.</p>'; }
  }
  env.onEvent?.((m) => { if (['notice', 'bounty_awarded', 'club_founded', 'club_joined', 'painted', 'poem', 'candidate', 'council_elected', 'proposal', 'ballot', 'vote_result', 'built', 'donation', 'festival', 'gazette'].includes(m.kind) || (view === 'games' && m.kind?.startsWith?.('game'))) render(); });
  setInterval(() => { if (view === 'games' && !panel.hidden) render(); }, 5000);
  setInterval(render, 30000);
}
const PAL = ['#d9644a', '#4f7cc9', '#4f9e6b', '#d8a13a', '#8a67c7', '#d6729c', '#3a9ea0', '#e0873d', '#7f9a3a', '#5a5fa8', '#c0506e', '#4aa3d8', '#9a6b45', '#5cc08a', '#a55fd0', '#6d7a8c'];

/** The home section of the inspector: where they live, what they call it, their front page and guestbook. */
export async function homeSection(a) {
  if (!a.home) return '';
  let h = null;
  try { h = await api(`public/homes/${encodeURIComponent(a.id)}`); } catch { return ''; }
  const where = h.where.kind === 'house' ? `House ${h.where.plot + 1}, ${esc(h.where.district)}` : `Room ${h.where.room}, the Lodging House`;
  return `<h5>Home</h5><div class="ins-home"><div class="ih-top"><b>${esc(h.name || (h.where.kind === 'house' ? 'A house' : 'A room'))}</b><span>${where}</span></div>
    ${h.motto ? `<div class="ih-motto">"${esc(h.motto)}"</div>` : ''}
    ${h.front_page ? `<div class="ih-page">${esc(h.front_page).replace(/\n/g, '<br>')}</div>` : ''}
    ${h.furniture.length ? `<div class="ih-furn">${h.furniture.map((f) => `<span>${esc(f.name)}</span>`).join('')}</div>` : ''}
    ${h.guestbook.length ? `<div class="ih-gb"><small>Guestbook</small>${h.guestbook.slice(0, 5).map((g) => `<div><b>${esc(g.guest)}</b> ${esc(g.text)}</div>`).join('')}</div>` : ''}</div>`;
}
