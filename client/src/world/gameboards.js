// Drawing a table from the Games Court, for the player sitting at it (who can move) or anyone watching.
// renderTable(view, send) -> { html, bind(el) }. view is a table_view; send(move) makes a move (omit to just watch).
import { esc } from '../shared/common.js';

const SEAT_COL = ['#e2473a', '#f2c230', '#4f7cc9', '#4f9e6b', '#8a67c7', '#e0873d', '#3a9ea0', '#d6729c', '#9a6b45'];
const who = (v, i) => esc(v.seats[i]?.handle ?? `seat ${i}`);
const dot = (i) => `<span class="gb-dot" style="background:${SEAT_COL[i % SEAT_COL.length]}"></span>`;

function header(v) {
  const turn = v.status === 'playing' ? (v.your_move ? '<b class="gb-you">Your move</b>' : `Waiting for ${v.to_move.map((i) => who(v, i)).join(', ') || '…'}`) : '';
  const res = v.result ? `<div class="gb-result">${v.result.draw ? 'A draw' : `${v.result.winners.map(esc).join(' and ')} won`}${v.result.note ? ` · ${esc(v.result.note)}` : ''}${v.rated ? '' : ' · not rated'}</div>` : '';
  return `<div class="gb-seats">${v.seats.map((s, i) => `<span class="${v.to_move?.includes(i) ? 'on' : ''}">${dot(i)}${esc(s.handle)}${v.you === i ? ' (you)' : ''}</span>`).join('')}</div>
    <div class="gb-turn">${turn}${v.seconds_left !== null && v.status === 'playing' ? ` · <span class="gb-clock">${v.seconds_left}s</span>` : ''}</div>${res}`;
}

const R = {
  connect4(v, send) {
    const s = v.state, win = new Set((s.line ?? []).map(([r, c]) => `${r},${c}`));
    const html = `<div class="c4" style="--cols:7">${s.board.map((row, r) => row.map((x, c) => `<i data-col="${c}" class="${win.has(`${r},${c}`) ? 'win' : ''}${s.last && s.last[0] === r && s.last[1] === c ? ' last' : ''}">${x >= 0 ? `<b style="background:${SEAT_COL[x]}"></b>` : ''}</i>`).join('')).join('')}</div>`;
    return { html, bind: (el) => { if (send && v.your_move) el.querySelector('.c4').onclick = (e) => { const c = e.target.closest('[data-col]'); if (c) send({ col: Number(c.dataset.col) }); }; } };
  },
  dots(v, send) {
    const s = v.state, g = 50, o = 20, n = 4;
    let svg = `<svg class="gb-svg" viewBox="0 0 ${o * 2 + g * n} ${o * 2 + g * n}">`;
    s.boxes.forEach((row, r) => row.forEach((x, c) => { if (x >= 0) svg += `<rect x="${o + c * g + 3}" y="${o + r * g + 3}" width="${g - 6}" height="${g - 6}" rx="4" fill="${SEAT_COL[x]}" opacity="0.45"/>`; }));
    const line = (k, r, c, x1, y1, x2, y2, owner) => `<line data-line="${k},${r},${c}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${owner >= 0 ? 'on' : 'off'}" stroke="${owner >= 0 ? SEAT_COL[owner] : 'rgba(255,255,255,.12)'}"/>`;
    s.h.forEach((row, r) => row.forEach((x, c) => { svg += line('h', r, c, o + c * g, o + r * g, o + (c + 1) * g, o + r * g, x); }));
    s.v.forEach((row, r) => row.forEach((x, c) => { svg += line('v', r, c, o + c * g, o + r * g, o + c * g, o + (r + 1) * g, x); }));
    for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) svg += `<circle cx="${o + c * g}" cy="${o + r * g}" r="4.5" fill="#fff"/>`;
    svg += '</svg>';
    return { html: `<div class="gb-score">${s.score.map((x, i) => `${dot(i)}${who(v, i)} ${x}`).join(' · ')}</div>${svg}`,
      bind: (el) => { if (send && v.your_move) el.querySelector('svg').onclick = (e) => { const l = e.target.closest('line.off'); if (l) send({ line: l.dataset.line }); }; } };
  },
  checkers(v, send) {
    const s = v.state, legal = (v.legal ?? []).map((m) => m.path);
    let sel = [];
    const draw = (el) => {
      const starts = new Set(legal.map((p) => `${p[0][0]},${p[0][1]}`));
      const nexts = new Set(legal.filter((p) => sel.length && sel.every((q, i) => p[i] && p[i][0] === q[0] && p[i][1] === q[1])).map((p) => p[sel.length]).filter(Boolean).map((q) => `${q[0]},${q[1]}`));
      const lastSet = new Set((s.last ?? []).map(([r, c]) => `${r},${c}`));
      el.querySelector('.ck').innerHTML = s.board.map((row, r) => row.map((x, c) => {
        const k = `${r},${c}`, dark = (r + c) % 2 === 1;
        const cls = [dark ? 'd' : 'l', sel.some((q) => q[0] === r && q[1] === c) ? 'sel' : '', nexts.has(k) ? 'next' : '', !sel.length && starts.has(k) && v.your_move ? 'can' : '', lastSet.has(k) ? 'last' : ''].join(' ');
        return `<i data-sq="${k}" class="${cls}">${x ? `<b class="p${x}">${x === 2 || x === 4 ? '♛' : ''}</b>` : ''}</i>`;
      }).join('')).join('');
    };
    return { html: `<div class="ck"></div><p class="gb-note">${v.you === 0 ? 'You play dark, moving up.' : v.you === 1 ? 'You play light, moving down.' : ''} Jumps are compulsory.</p>`,
      bind: (el) => {
        draw(el);
        if (!(send && v.your_move)) return;
        el.querySelector('.ck').onclick = (e) => {
          const sq = e.target.closest('[data-sq]'); if (!sq) return;
          const [r, c] = sq.dataset.sq.split(',').map(Number);
          const cand = [...sel, [r, c]];
          const matches = legal.filter((p) => cand.every((q, i) => p[i] && p[i][0] === q[0] && p[i][1] === q[1]));
          if (!matches.length) { sel = legal.some((p) => p[0][0] === r && p[0][1] === c) ? [[r, c]] : []; draw(el); return; }
          sel = cand;
          const done = matches.find((p) => p.length === sel.length);
          if (done && matches.length === 1) { send({ path: done }); sel = []; } else draw(el);
        };
      } };
  },
  liarsdice(v, send) {
    const s = v.state, pip = (d) => (d ? '⚀⚁⚂⚃⚄⚅'[d - 1] : '▢');
    const mine = v.you !== null ? s.dice[v.you] : [];
    const bid = s.bid ? `${s.bid.qty} × ${pip(s.bid.face)} (${s.bid.qty} ${s.bid.face}s) by ${who(v, s.bid.by)}` : 'no bid yet';
    const rev = s.reveal ? `<div class="gb-reveal">Last call: the bid was ${s.reveal.bid.qty} × ${s.reveal.bid.face}s and there were <b>${s.reveal.count}</b>. ${who(v, s.reveal.loser)} lost a die.<div>${s.reveal.dice.map((d, i) => `${dot(i)}${d.map(pip).join('')}`).join(' ')}</div></div>` : '';
    return { html: `${rev}<div class="gb-cups">${s.counts.map((n, i) => `<span>${dot(i)}${who(v, i)}: ${i === v.you ? `<b class="ld-mine">${mine.map(pip).join('')}</b>` : `${n} ${n === 1 ? 'die' : 'dice'}`}</span>`).join('')}</div>
      <p>Round ${s.round} · ${s.total} dice in play · current bid: <b>${bid}</b></p>
      ${send && v.your_move ? `<div class="ps-row"><input class="pw-in" id="ld-q" type="number" min="1" max="${s.total}" value="${s.bid ? s.bid.qty : 1}" style="width:80px"/> of <select class="pw-in" id="ld-f" style="width:90px">${[1, 2, 3, 4, 5, 6].map((f) => `<option value="${f}" ${s.bid?.face === f ? 'selected' : ''}>${f}s</option>`).join('')}</select><button class="ps-go" id="ld-bid">Bid</button>${s.bid ? '<button id="ld-call">Call liar!</button>' : ''}</div><p class="gb-note">Ones are wild unless you bid on ones.</p>` : ''}`,
      bind: (el) => {
        if (!(send && v.your_move)) return;
        el.querySelector('#ld-q').addEventListener('keydown', (e) => e.stopPropagation());
        el.querySelector('#ld-bid').onclick = () => send({ qty: Number(el.querySelector('#ld-q').value), face: Number(el.querySelector('#ld-f').value) });
        el.querySelector('#ld-call')?.addEventListener('click', () => send({ call: true }));
      } };
  },
  werewolf(v, send) {
    const s = v.state, me = s.you, role = me?.role;
    const act = s.phase === 'night' ? (role === 'wolf' ? 'kill' : role === 'seer' ? 'inspect' : null) : 'vote';
    const can = send && v.your_move && me?.alive && act;
    const roleLine = me ? `<div class="ww-role r-${role}">You are ${role === 'wolf' ? `a <b>wolf</b>${me.wolves?.length > 1 ? ` (with ${me.wolves.filter((i) => i !== me.seat).map((i) => who(v, i)).join(', ')})` : ''}` : role === 'seer' ? 'the <b>seer</b>' : 'a <b>villager</b>'}${me.alive ? '' : ' · out of the game'}</div>` : '';
    const seen = me?.inspected ? Object.entries(me.inspected).map(([i, r]) => `${who(v, Number(i))} is ${r === 'wolf' ? 'a WOLF' : `a ${r}`}`).join('; ') : '';
    return { html: `${roleLine}<p>${s.winner ? '' : s.phase === 'night' ? `Night ${s.day}. ${role === 'villager' ? 'You sleep.' : ''}` : `Day ${s.day}: talk in the table chat, then vote. ${s.votes_cast} voted.`}</p>
      ${seen ? `<p class="gb-note">You have seen: ${seen}</p>` : ''}
      <div class="ww-list">${s.alive.map((a, i) => `<div class="${a ? '' : 'out'}">${dot(i)}${who(v, i)}${s.roles ? ` · ${s.roles[i]}` : ''}${can && a && i !== me.seat && !(act === 'kill' && me.wolves?.includes(i)) ? `<button data-t="${i}">${act === 'kill' ? 'Choose' : act === 'inspect' ? 'Look' : 'Vote'}</button>` : ''}</div>`).join('')}</div>
      ${can && act === 'vote' ? '<div class="ps-row"><button data-t="-1">Abstain</button></div>' : ''}
      <div class="ww-log">${s.log.slice(-6).map((l) => `<div>${esc(l)}</div>`).join('')}</div>`,
      bind: (el) => { if (can) el.onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) send({ [act]: Number(b.dataset.t) }); }; } };
  },
  wordhunt(v, send) {
    const s = v.state, me = s.you, mine = me && v.your_move;
    const giveClue = mine && me.spymaster && s.phase === 'clue', guess = mine && !me.spymaster && s.phase === 'guess';
    return { html: `<div class="wh-top"><span class="wh-red">Red ${s.left.red} left</span> · <span class="wh-blue">Blue ${s.left.blue} left</span> · ${s.winner ? '' : `${s.team} team ${s.phase === 'clue' ? 'is thinking of a clue' : `is guessing: <b>${esc(s.clue?.word ?? '')} ${s.clue?.count ?? ''}</b>`}`}</div>
      <div class="wh">${s.words.map((w, i) => `<i data-g="${i}" class="${s.shown[i] ? 'shown ' : ''}${s.colours[i] ? `c-${s.colours[i]}` : ''}${guess && !s.shown[i] ? ' can' : ''}">${esc(w)}</i>`).join('')}</div>
      ${me ? `<p class="gb-note">You are on the ${me.team} team${me.spymaster ? ' (spymaster: you see the key)' : ''}.</p>` : ''}
      ${giveClue ? '<div class="ps-row"><input class="pw-in" id="wh-c" placeholder="one-word clue" style="flex:1"/><input class="pw-in" id="wh-n" type="number" min="1" max="9" value="2" style="width:70px"/><button class="ps-go" id="wh-go">Give clue</button></div>' : ''}
      ${guess ? '<div class="ps-row"><button id="wh-pass">Pass</button></div>' : ''}`,
      bind: (el) => {
        if (giveClue) { el.querySelector('#wh-c').addEventListener('keydown', (e) => e.stopPropagation()); el.querySelector('#wh-go').onclick = () => send({ clue: el.querySelector('#wh-c').value.trim(), count: Number(el.querySelector('#wh-n').value) }); }
        if (guess) { el.querySelector('.wh').onclick = (e) => { const c = e.target.closest('.can'); if (c) send({ guess: Number(c.dataset.g) }); }; el.querySelector('#wh-pass').onclick = () => send({ pass: true }); }
      } };
  },
  trivia(v, send) {
    const s = v.state, q = s.question;
    return { html: `${q ? `<p class="tv-q">Question ${s.q + 1} of ${s.of}: <b>${esc(q.text)}</b></p><div class="tv-a">${q.choices.map((c, i) => `<button data-a="${i}" ${send && v.your_move ? '' : 'disabled'}>${'ABCD'[i]}. ${esc(c)}</button>`).join('')}</div>
      <p class="gb-note">${s.answered} answered${send && !v.your_move && v.status === 'playing' ? ' · you have answered' : ''}</p>` : ''}
      ${s.log.length ? `<div class="ww-log">${s.log.map((l) => `<div>${esc(l.q)} <b>${esc(l.answer)}</b></div>`).join('')}</div>` : ''}
      <div class="gb-score">${s.scores.map((x, i) => `${dot(i)}${who(v, i)} ${x}`).join(' · ')}</div>`,
      bind: (el) => { if (send && v.your_move) el.querySelector('.tv-a').onclick = (e) => { const b = e.target.closest('[data-a]'); if (b) send({ answer: Number(b.dataset.a) }); }; } };
  },
};

export function renderTable(v, send) {
  if (!v.state) return { html: `${header(v)}<p class="ps-muted">${v.status === 'open' ? `Waiting for players (${v.seats.length} seated).` : 'This table was cleared away.'}</p>`, bind() {} };
  const r = R[v.game](v, send);
  return { html: `${header(v)}${r.html}`, bind: r.bind };
}
