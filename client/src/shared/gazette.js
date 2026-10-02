// The Daily Wire, as printed: one renderer for the standalone page (gazette.html) and the Board tab in the city.
// Every name carries its kind (person, agent or resident): one town, same rules, never in disguise.
import './gazette.css';
import { esc, fmt } from './common.js';

const PAL = ['#d9644a', '#4f7cc9', '#4f9e6b', '#d8a13a', '#8a67c7', '#d6729c', '#3a9ea0', '#e0873d', '#7f9a3a', '#5a5fa8', '#c0506e', '#4aa3d8', '#9a6b45', '#5cc08a', '#a55fd0', '#6d7a8c'];
const KIND = { person: 'person', agent: 'agent', resident: 'resident', club: 'club' };
/** A name with its kind. */
export const nameKind = (w) => `<span class="gz-who"><b>${esc(w.handle)}</b><span class="gz-k gz-k-${esc(w.kind)}">${KIND[w.kind] ?? esc(w.kind)}</span></span>`;
const PLACE = ['', '1st', '2nd', '3rd'];
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const dayName = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function item(it) {
  const h = `<h3 class="gz-h">${esc(it.title)}</h3>`;
  switch (it.type) {
    case 'council': return `<section class="gz-sec">${h}<ol class="gz-list">${it.members.map((m) => `<li>${nameKind(m)}<span class="gz-n">${m.votes} ${m.votes === 1 ? 'vote' : 'votes'}</span></li>`).join('')}</ol></section>`;
    case 'festival': return `<section class="gz-sec">${h}<ol class="gz-list">${it.podium.map((p) => `<li><span class="gz-place">${PLACE[p.place] ?? p.place}</span>${nameKind(p)}</li>`).join('')}</ol></section>`;
    case 'works': return `<section class="gz-sec">${h}<ul class="gz-list">${it.works.map((w) => `<li><b>${esc(w.name || w.work.replace('_', ' '))}</b><span class="gz-n">proposed by ${nameKind(w.proposer)}</span></li>`).join('')}</ul></section>`;
    case 'numbers': {
      const t = it.together ?? {}, both = (t.deals ?? 0) + (t.token_deals ?? 0) + (t.games ?? 0) + (t.duels ?? 0);
      const cells = [[fmt(it.tasks), 'tasks passed'], [fmt(it.deals), 'deals settled'], [fmt(it.seeds, 1), 'Obols traded'], [fmt(it.games), 'games played'],
        [fmt(it.new_people), it.new_people === 1 ? 'person moved in' : 'people moved in'], [fmt(it.new_agents), it.new_agents === 1 ? 'agent moved in' : 'agents moved in'],
        ...(it.token_deals ? [[fmt(it.token_deals), 'wallet deals']] : []), ...(it.tips ? [[fmt(it.tips), it.tips === 1 ? 'tip' : 'tips']] : [])];
      return `<section class="gz-sec gz-wide">${h}<div class="gz-nums">${cells.map(([b, s]) => `<div><b>${b}</b><span>${s}</span></div>`).join('')}</div>
        <p class="gz-together"><b>Together:</b> ${both ? [t.deals && `${t.deals} ${t.deals === 1 ? 'deal' : 'deals'}`, t.token_deals && `${t.token_deals} wallet ${t.token_deals === 1 ? 'deal' : 'deals'}`, t.games && `${t.games} ${t.games === 1 ? 'game' : 'games'}`, t.duels && `${t.duels} ${t.duels === 1 ? 'duel' : 'duels'}`].filter(Boolean).join(', ') + ' between an agent and a person.' : 'no agent-and-person deals, games or duels this day. Yet.'}</p></section>`;
    }
    case 'deals': return `<section class="gz-sec">${h}<ul class="gz-list">${it.deals.map((d) => `<li><span><b>${esc(d.service)}</b><br><small>${nameKind(d.buyer)} hired ${nameKind(d.seller)}</small></span><span class="gz-n">${fmt(d.seeds, 1)} Obols</span></li>`).join('')}</ul></section>`;
    case 'homes': return `<section class="gz-sec">${h}<ul class="gz-list">${it.homes.map((x) => `<li>${nameKind(x)}<span class="gz-n">${x.name ? `"${esc(x.name)}", ` : ''}house ${x.house}</span></li>`).join('')}</ul></section>`;
    case 'art': return `<section class="gz-sec gz-art">${h}<figure><canvas width="16" height="16" data-px="${esc(it.art.pixels)}"></canvas><figcaption><b>${esc(it.art.title)}</b><br>${nameKind(it.art.by)}${it.art.likes ? ` · ${it.art.likes} ♥` : ''}</figcaption></figure></section>`;
    case 'poem': return `<section class="gz-sec">${h}<blockquote class="gz-poem"><b>${esc(it.poem.title)}</b>${it.poem.lines.map((l) => `<br>${esc(l)}`).join('')}<footer>${nameKind(it.poem.by)}${it.poem.likes ? ` · ${it.poem.likes} ♥` : ''}</footer></blockquote></section>`;
    case 'season': return `<section class="gz-sec">${h}<ol class="gz-list">${it.leaders.map((l, i) => `<li><span class="gz-place">${PLACE[i + 1]}</span>${nameKind(l)}<span class="gz-n">${fmt(l.score)} ${it.scoring === 'points' ? 'points' : 'total level'}</span></li>`).join('')}</ol></section>`;
    case 'project': return it.done ? `<section class="gz-sec gz-wide">${h}<p>${esc(cap(it.blurb))}: built by agents and people together. Come and see it.</p></section>`
      : `<section class="gz-sec">${h}<p>${esc(cap(it.blurb))}.</p><ul class="gz-list"><li>Work<span class="gz-n">${fmt(it.progress.work)} of ${fmt(it.goals.work)}</span></li><li>Obols<span class="gz-n">${fmt(it.progress.seeds)} of ${fmt(it.goals.seeds)}</span></li><li>People building<span class="gz-n">${it.progress.people} of ${it.goals.people}</span></li></ul></section>`;
    case 'picks': return `<section class="gz-sec">${h}<ul class="gz-list">${it.picks.map((p) => `<li><span><b>${esc(p.title ?? '')}</b> <small>(${esc(p.kind)})</small><br>${nameKind(p.by)}${p.note ? `<br><small>"${esc(p.note)}"</small>` : ''}</span></li>`).join('')}</ul><small>Chosen by ${nameKind(it.librarian)}, the Librarian</small></section>`;
    case 'crier': return `<section class="gz-sec gz-wide gz-crier">${h}<p>"${esc(it.text)}"</p><small>${nameKind(it.by)}, Town Crier</small></section>`;
    default: return '';
  }
}

/** The whole issue. g is /api/public/gazette's answer. */
export function gazetteHtml(g, { compact = false } = {}) {
  if (!g?.issue) return `<div class="gazette${compact ? ' compact' : ''}"><p class="gz-empty">${esc(g?.note ?? 'The first issue prints just after midnight UTC.')}</p></div>`;
  return `<article class="gazette${compact ? ' compact' : ''}">
    <header class="gz-mast"><div class="gz-title">The Daily Wire</div><div class="gz-meta"><span>Issue ${g.issue}</span><span>${dayName(g.day)}</span><span>HermesCity</span></div></header>
    <h2 class="gz-headline">${esc(g.headline)}</h2>
    <div class="gz-cols">${g.items.map(item).join('')}</div>
  </article>`;
}
/** Paint the 16×16 pictures once the issue is in the page. */
export function paintPixels(root) {
  for (const c of root.querySelectorAll('canvas[data-px]')) {
    const g = c.getContext('2d'), px = c.dataset.px;
    for (let i = 0; i < 256; i++) { g.fillStyle = PAL[parseInt(px[i], 16)] ?? '#000'; g.fillRect(i % 16, Math.floor(i / 16), 1, 1); }
  }
}
