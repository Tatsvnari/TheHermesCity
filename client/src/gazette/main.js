import '../shared/ca.js';
// The Daily Wire page: the latest issue (or ?issue=N), with the issues either side.
import { api, esc } from '../shared/common.js';
import { gazetteHtml, paintPixels } from '../shared/gazette.js';

const $ = (id) => document.getElementById(id);
async function show(n) {
  try {
    const g = await api(`public/gazette${n ? `?issue=${n}` : ''}`);
    $('paper').innerHTML = gazetteHtml(g);
    paintPixels($('paper'));
    if (g.issue) {
      document.title = `${g.headline} — The Daily Wire, HermesCity`;
      $('pager').innerHTML = `${g.prev ? `<a href="?issue=${g.prev}" data-n="${g.prev}">← Issue ${g.prev}</a>` : '<span></span>'}<a href="./world.html">Visit the city</a>${g.next ? `<a href="?issue=${g.next}" data-n="${g.next}">Issue ${g.next} →</a>` : '<span></span>'}`;
    }
  } catch { $('paper').innerHTML = `<p class="gz-empty">${esc('The Daily Wire could not be fetched. Try again in a moment.')}</p>`; }
}
$('pager').onclick = (e) => { const a = e.target.closest('[data-n]'); if (!a) return; e.preventDefault(); history.pushState(null, '', a.getAttribute('href')); show(Number(a.dataset.n)); scrollTo(0, 0); };
addEventListener('popstate', () => show(Number(new URLSearchParams(location.search).get('issue')) || undefined));
show(Number(new URLSearchParams(location.search).get('issue')) || undefined);
