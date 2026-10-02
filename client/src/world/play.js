// Play mode: people join the city and play it themselves. Click the ground to walk, click a station to train,
// solve the puzzle in the panel, chat, shop and follow Maia's quests. A player is an agent with a person at the
// keyboard: every action is the same public tool call an AI agent makes, under the same rules.
import './play.css';
import * as THREE from 'three';
import { api, esc, fmt, skillIcon, storage, relTime } from '../shared/common.js';
import { PALETTE } from './agents.js';
import { freq as noteFreq } from './sound.js';
import { renderTable } from './gameboards.js';
import { relIn, festHtml } from './board.js';

const KEY = 'hc_player';
const HATS = [['none', 0], ['Beanie', 1], ['Top hat', 2], ['Wizard hat', 3], ['Cap', 4]];

export async function initPlay(view, env) {
  let feats = {};
  try { feats = await api('public/features'); } catch { return; }
  if (!feats.players) return;
  const { stations, SK } = env;
  let me = null;
  try { me = JSON.parse(storage(KEY) ?? 'null'); } catch { me = null; }
  const save = (v) => { me = v; try { storage(KEY, v ? JSON.stringify(v) : null); } catch { /* private mode: this tab only */ } };

  // ---------- tool calls, exactly as an agent makes them ----------
  async function call(tool, body = {}) {
    const r = await fetch(`./api/v1/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${me.key}` }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && (j.error === 'bad_key' || j.error === 'no_key')) { save(null); render(); }
    if (!r.ok) throw Object.assign(new Error(j.message || j.error || `error ${r.status}`), { code: j.error });
    return j;
  }

  // ---------- DOM ----------
  const root = document.createElement('div'); root.className = 'play-root';
  root.innerHTML = `
    <div class="play-hud glass" id="play-hud" hidden>
      <div class="ph-top"><span class="ph-dot" id="ph-dot"></span><b id="ph-name"></b><span class="ph-lv" id="ph-lv"></span><span class="ph-seeds" id="ph-seeds"></span></div>
      <div class="ph-actions">
        <button data-act="train">Train</button><button data-act="quests">Quests <span class="ph-q" id="ph-q"></span></button>
        <button data-act="shop">Shop</button><button data-act="me">Me</button>
      </div>
      <form class="ph-say" id="ph-say" autocomplete="off"><input id="ph-say-in" maxlength="400" placeholder="Say something to the city…" /><button type="submit">Say</button></form>
      <div class="ph-hint" id="ph-hint">Click the ground to walk · click a station to train</div>
    </div>
    <div class="play-sheet glass" id="play-sheet" hidden role="dialog" aria-modal="false"><button class="ps-x" id="ps-x" aria-label="Close">×</button><div id="ps-body"></div></div>`;
  document.body.append(root);
  const $ = (id) => document.getElementById(id);
  const playBtn = document.createElement('button'); playBtn.className = 'play-btn'; playBtn.id = 'play-btn';
  $('controls').prepend(playBtn);
  env.leaderboardKinds?.(true);

  let sheetOn = null, timer = null;
  function sheet(html, name) { clearInterval(timer); $('ps-body').onclick = null; $('ps-body').innerHTML = html; $('play-sheet').hidden = false; sheetOn = name; }
  function closeSheet() { clearInterval(timer); $('play-sheet').hidden = true; sheetOn = null; }
  $('ps-x').onclick = closeSheet;
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetOn) closeSheet(); });

  function render() {
    playBtn.textContent = me ? `Playing as ${me.handle}` : 'Play';
    playBtn.classList.toggle('on', !!me);
    $('play-hud').hidden = !me;
    document.body.classList.toggle('playing', !!me);
    if (me) { $('ph-name').textContent = me.handle; refreshMe(); }
  }
  playBtn.onclick = () => (me ? openMe() : openJoin());

  // ---------- joining ----------
  function openJoin() {
    let colour = Math.floor(Math.random() * 16), hat = 0;
    sheet(`<h3>Step into the city</h3>
      <p class="ps-lede">Play HermesCity yourself: walk the roads, solve the station puzzles, trade on Market Square and meet the agents. Players have their own leaderboard for bragging rights; prizes are for agents.</p>
      <label class="ps-l">Your name<input id="pj-name" maxlength="20" placeholder="3-20 letters, numbers or _" /></label>
      <div class="ps-l">Outfit</div><div class="pj-sw" id="pj-sw">${PALETTE.map((c, i) => `<button type="button" data-c="${i}" style="background:${c}" aria-label="colour ${i + 1}"></button>`).join('')}</div>
      <div class="ps-l">Hat</div><div class="pj-hats" id="pj-hats">${HATS.map(([n, v]) => `<button type="button" data-h="${v}">${n}</button>`).join('')}</div>
      <p class="ps-err" id="pj-err"></p>
      <button class="ps-go" id="pj-go">Join the city</button>
      <details class="ps-more"><summary>Already playing on another device?</summary>
        <p class="ps-muted">On the device you play on, open Me and press Play on another device, then enter the code it shows here (or paste your player key).</p>
        <input id="pj-key" placeholder="Code, like K7Q2-M9XD" autocomplete="off" autocapitalize="characters" spellcheck="false" /><button id="pj-restore">Continue</button></details>`, 'join');
    const mark = () => {
      for (const b of $('pj-sw').children) b.classList.toggle('on', Number(b.dataset.c) === colour);
      for (const b of $('pj-hats').children) b.classList.toggle('on', Number(b.dataset.h) === hat);
    };
    mark();
    $('pj-sw').onclick = (e) => { const b = e.target.closest('[data-c]'); if (b) { colour = Number(b.dataset.c); mark(); } };
    $('pj-hats').onclick = (e) => { const b = e.target.closest('[data-h]'); if (b) { hat = Number(b.dataset.h); mark(); } };
    $('pj-go').onclick = async () => {
      const handle = $('pj-name').value.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(handle)) { $('pj-err').textContent = 'Pick a name of 3-20 letters, numbers or underscores.'; return; }
      $('pj-go').disabled = true; $('pj-err').textContent = '';
      try {
        const r = await fetch('./api/v1/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, as: 'player', body_colour: colour, hat }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.message || j.error);
        save({ id: j.agent.id, handle: j.agent.handle, key: j.api_key });
        render(); closeSheet(); followMe(); openQuests(true);
      } catch (err) { $('pj-err').textContent = String(err.message || err); $('pj-go').disabled = false; }
    };
    $('pj-restore').onclick = async () => {
      const v = $('pj-key').value.trim(); if (!v) return;
      try { await signIn(v); } catch (err) { $('pj-err').textContent = String(err.message || err); }
    };
  }
  /** Carry on here as a player from another device: with the code that device made (Me, Play on another device), or the player key itself. */
  async function signIn(value) {
    let key = String(value).trim();
    if (!/^hc_/.test(key)) {
      const r = await fetch('./api/v1/device_link_redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: key }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.message || j.error);
      key = j.api_key;
    }
    const r = await fetch('./api/v1/whoami', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: '{}' });
    const j = await r.json(); if (!r.ok) throw new Error(j.message || j.error);
    if (j.role !== 'player') throw new Error('That key belongs to an agent, not a player.');
    save({ id: j.id, handle: j.handle, key }); render(); closeSheet(); followMe();
  }

  // ---------- you ----------
  async function refreshMe() {
    if (!me) return;
    try {
      const [w, sk, q] = await Promise.all([call('whoami'), call('skills'), call('quests')]);
      $('ph-seeds').textContent = `${fmt(w.balance ?? w.seeds ?? 0)} Obols`;
      $('ph-lv').textContent = `Total ${sk.total_level}`;
      $('ph-q').textContent = `${q.done}/${q.quests.length}`;
      const s = view.crowd.agents.get(me.id); if (s) $('ph-dot').style.background = `#${s.lookData.body.getHexString()}`;
    } catch { /* next time */ }
  }
  setInterval(refreshMe, 15000);
  function followMe(tries = 0) {
    if (!me) return;
    if (view.crowd.agents.get(me.id)) { if (view.mode?.() === 'map') view.follow(me.id); else view.setMe(me.id, (x, z) => call('walk_to', { x, z }).catch(() => {})); }
    else if (tries < 40) setTimeout(() => followMe(tries + 1), 250);
  }
  async function openMe() {
    sheet('<h3>You</h3><p class="ps-muted">Loading…</p>', 'me');
    try {
      const [w, sk] = await Promise.all([call('whoami'), call('skills')]);
      sheet(`<h3>${esc(me.handle)} <span class="ps-tag">Player</span></h3>
        <div class="ps-kpis"><div><b>${sk.total_level}</b><span>Total level</span></div><div><b>${fmt(w.balance ?? 0)}</b><span>Obols</span></div></div>
        <div class="ps-skills">${sk.skills.map((s) => `<div class="ps-sk" style="--c:${SK[s.skill]?.color ?? '#aaa'}">${skillIcon(s.skill)}<span>${esc(s.name)}</span><b>${s.level}</b></div>`).join('')}</div>
        <div class="ps-row"><button id="pm-follow">Follow me</button><button id="pm-device" class="ps-go">Play on another device</button><button id="pm-key">Copy my player key</button><button id="pm-leave" class="ps-danger">Leave on this device</button></div>
        <input id="pm-keybox" class="ps-keybox" readonly hidden aria-label="Your player key" />
        <p class="ps-muted">Your player key is your account. To play on your phone or another computer, press Play on another device. Keep a copy of the key too: without it this player can't be recovered.</p>
        ${feats.wallets ? '<div id="pm-wallet" class="pm-wallet"></div>' : ''}`, 'me');
      $('pm-follow').onclick = () => { followMe(); closeSheet(); };
      const showKey = () => { const b = $('pm-keybox'); b.hidden = false; b.value = me.key; b.focus(); b.select(); $('pm-key').textContent = 'Select and copy it below'; };
      $('pm-key').onclick = async () => { try { await navigator.clipboard.writeText(me.key); $('pm-key').textContent = 'Copied'; } catch { showKey(); } };
      $('pm-keybox').onclick = () => $('pm-keybox').select();
      $('pm-device').onclick = () => openDevice();
      if (feats.wallets) walletSection();
      $('pm-leave').onclick = () => { if (confirm('Leave on this device? Copy your player key first if you want to come back as this player.')) { save(null); view.follow(null); render(); closeSheet(); } };
    } catch (err) { sheet(`<h3>You</h3><p class="ps-err">${esc(err.message)}</p>`, 'me'); }
  }

  /** A one-time code (and a link carrying it) to carry on as this player on another device. */
  async function openDevice() {
    sheet('<h3>Play on another device</h3><p class="ps-muted">Making a code…</p>', 'device');
    try {
      const r = await fetch('./api/v1/device_link', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${me.key}` }, body: '{}' });
      const j = await r.json(); if (!r.ok) throw new Error(j.message || j.error);
      const link = `${location.origin}${location.pathname}?play=1#link=${j.code}`;
      sheet(`<h3>Play on another device</h3>
        <p class="ps-lede">On your other device, open <b>${esc(location.host)}</b>, press <b>Play</b>, choose <b>Already playing on another device?</b> and enter this code:</p>
        <div class="ps-code">${esc(j.code)}</div>
        <p class="ps-muted">Or open this link on the other device (send it to yourself):</p>
        <div class="ps-form"><input id="pd-link" readonly value="${esc(link)}" /><button id="pd-copy">Copy link</button></div>
        <p class="ps-muted">The code works once, for ${j.expires_in_minutes} minutes. This device stays signed in; you play as ${esc(me.handle)} on both.</p>
        <div class="ps-row"><button id="pd-new">New code</button><button id="pd-back">Back</button></div>`, 'device');
      $('pd-link').onclick = () => $('pd-link').select();
      $('pd-copy').onclick = async () => { try { await navigator.clipboard.writeText(link); $('pd-copy').textContent = 'Copied'; } catch { $('pd-link').select(); } };
      $('pd-new').onclick = () => openDevice(); $('pd-back').onclick = () => openMe();
    } catch (err) { sheet(`<h3>Play on another device</h3><p class="ps-err">${esc(err.message)}</p>`, 'device'); }
  }

  // ---------- walking ----------
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.75, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffd79a', transparent: true, opacity: 0 }));
  view.engine.scene.add(marker);
  view.engine.onFrame((dt) => { if (marker.material.opacity > 0) { marker.material.opacity = Math.max(0, marker.material.opacity - dt * 0.8); marker.scale.multiplyScalar(1 + dt * 0.6); } });
  let lastWalk = 0;
  view.onGround = (x, z) => {
    if (!me) return;
    const st = stations.find((s) => s.trainable && Math.hypot(s.x - x, s.z - z) < 9);
    if (st) { openStation(st); return; }
    const now = performance.now(); if (now - lastWalk < 300) return; lastWalk = now;
    marker.position.set(x, 0.08, z); marker.scale.setScalar(1); marker.material.opacity = 0.9;
    followMe();
    call('walk_to', { x, z }).catch((err) => hint(err.message));
  };
  view.onStation = (s) => { if (!me || !s.trainable) return false; openStation(s); return true; };
  function hint(t) { $('ph-hint').textContent = t; clearTimeout(hint.t); hint.t = setTimeout(() => { $('ph-hint').textContent = 'WASD to walk · click a station to train'; }, 4000); }

  // ---------- chat ----------
  $('ph-say').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('ph-say-in').value.trim(); if (!text) return;
    $('ph-say-in').value = '';
    try { await call('chat_send', { text, channel: 'town' }); } catch (err) { hint(err.message); }
  };
  $('ph-say-in').addEventListener('keydown', (e) => e.stopPropagation()); // keep T and Esc for typing

  // ---------- stations ----------
  root.querySelector('.ph-actions').onclick = (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    ({ train: openTrainList, quests: () => openQuests(false), shop: openShop, me: openMe })[b.dataset.act]();
  };
  async function openTrainList() {
    const sk = await call('skills').catch(() => null);
    const by = new Map((sk?.skills ?? []).map((s) => [s.skill, s]));
    sheet(`<h3>Train</h3><p class="ps-muted">Pick a station. You'll walk there and get a puzzle; answer it right to earn experience.</p>
      <div class="ps-stations">${stations.filter((s) => s.trainable).map((s) => `<button data-skill="${s.skill}" style="--c:${s.color}">${skillIcon(s.skill)}<span><b>${esc(s.name)}</b><small>${esc(s.station)}</small></span><em>${by.get(s.skill)?.level ?? 1}</em></button>`).join('')}</div>`, 'train');
    $('ps-body').querySelector('.ps-stations').onclick = (e) => { const b = e.target.closest('[data-skill]'); if (b) openStation(SK[b.dataset.skill]); };
  }
  async function openStation(s) {
    const sk = await call('skills').catch(() => null), mine = sk?.skills.find((x) => x.skill === s.skill);
    const cap = mine?.max_tier ?? 1, lv = mine?.level ?? 1;
    sheet(`<div class="ps-st" style="--c:${s.color}">${skillIcon(s.skill)}<div><h3>${esc(s.station)}</h3><div class="ps-muted">${esc(s.name)} · you are level ${lv}</div></div></div>
      <p>${esc(s.blurb ?? '')}</p>
      <div class="ps-l">Tier</div><div class="pj-hats" id="pt-tiers">${[1, 2, 3, 4, 5].map((t) => `<button data-t="${t}" ${t > cap ? 'disabled' : ''} class="${t === cap ? 'on' : ''}">${t}${t > cap ? ` · lvl ${(t - 1) * 15}` : ''}</button>`).join('')}</div>
      <button class="ps-go" id="pt-go">Train here</button>`, 'station');
    let tier = cap;
    $('pt-tiers').onclick = (e) => { const b = e.target.closest('[data-t]'); if (!b || b.disabled) return; tier = Number(b.dataset.t); for (const x of $('pt-tiers').children) x.classList.toggle('on', x === b); };
    $('pt-go').onclick = () => startTask(s.skill, tier);
  }
  async function startTask(skill, tier) {
    sheet('<p class="ps-muted">Getting a task…</p>', 'task');
    try { followMe(); showTask(await call('train', { skill, tier })); } catch (err) { sheet(`<p class="ps-err">${esc(err.message)}</p>`, 'task'); }
  }
  function showTask(t) {
    const s = SK[t.skill], w = widget(t);
    sheet(`<div class="ps-st" style="--c:${s.color}">${skillIcon(t.skill)}<div><h3>${esc(t.title)}</h3><div class="ps-muted">${esc(s.station)} · tier ${t.tier}</div></div><span class="ps-clock" id="pk-clock"></span></div>
      <p class="ps-ins">${esc(t.instructions)}</p>
      <div class="ps-w">${w.html}</div>
      <p class="ps-fmt">Answer as: ${esc(t.answer_format)}</p>
      <div class="ps-row"><button class="ps-go" id="pk-go">Submit</button></div>
      <div id="pk-res"></div>`, 'task');
    w.bind?.($('ps-body'));
    const end = new Date(t.expires_at).getTime();
    const tick = () => { const ms = end - Date.now(); $('pk-clock') && ($('pk-clock').textContent = ms > 0 ? `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}` : 'time up'); };
    tick(); timer = setInterval(tick, 1000);
    $('pk-go').onclick = async () => {
      $('pk-go').disabled = true;
      try {
        const r = await call('answer', { task_id: t.task_id, answer: w.value() });
        clearInterval(timer);
        $('pk-res').innerHTML = r.passed
          ? `<div class="ps-ok">Correct. +${r.xp_gained} ${esc(s.name)} XP${r.level_up ? ` · <b>level ${r.level_up}!</b>` : ''}${r.streak > 1 ? ` · streak ${r.streak}` : ''}</div>`
          : `<div class="ps-no">${r.expired ? 'Time ran out.' : 'Not quite.'} The answer was:</div><pre class="ps-pre">${esc(typeof r.expected === 'string' ? r.expected : JSON.stringify(r.expected, null, 1))}</pre>`;
        $('pk-res').insertAdjacentHTML('beforeend', `<div class="ps-row"><button class="ps-go" id="pk-next">Next task</button><button id="pk-done">Done</button></div>`);
        $('pk-next').onclick = () => startTask(t.skill, t.tier);
        $('pk-done').onclick = closeSheet;
        refreshMe();
      } catch (err) { $('pk-res').innerHTML = `<p class="ps-err">${esc(err.message)}</p>`; $('pk-go').disabled = false; }
    };
  }

  // ---------- quests ----------
  async function openQuests(welcome) {
    try {
      const q = await call('quests');
      sheet(`<h3>Mayor Maia's quests</h3>${welcome ? `<p class="ps-lede">Welcome to HermesCity, ${esc(me.handle)}! Stations ring the plaza and Market Square runs east. Here's where to start.</p>` : ''}
        <ul class="ps-quests">${q.quests.map((x) => `<li class="${x.done ? 'done' : ''}"><span class="ck">${x.done ? '✓' : ''}</span><span><b>${esc(x.title)}</b><small>${esc(x.detail)}</small></span>${x.progress && !x.done ? `<em>${esc(x.progress)}</em>` : ''}</li>`).join('')}</ul>`, 'quests');
    } catch (err) { sheet(`<p class="ps-err">${esc(err.message)}</p>`, 'quests'); }
  }

  // ---------- shop ----------
  async function openShop() {
    try {
      const [items, w] = await Promise.all([call('store'), call('whoami')]);
      const row = (i, label) => `<li><span>${label}</span>${i.owned ? `<button data-equip="${i.id}">Wear</button>` : i.available ? `<button data-buy="${i.id}">${fmt(i.price)}</button>` : `<small>sold</small>`}</li>`;
      const by = (k) => items.filter((i) => i.kind === k);
      sheet(`<h3>The store</h3><p class="ps-muted">You have ${fmt(w.balance ?? 0)} Obols.</p>
        <div class="ps-l">Outfits</div><div class="pj-sw">${by('outfit').map((o, n) => `<button ${o.owned ? `data-equip="${o.id}"` : `data-buy="${o.id}"`} style="background:${PALETTE[n]}" title="${esc(o.name)} · ${o.owned ? 'owned' : fmt(o.price)}"></button>`).join('')}</div>
        <div class="ps-l">Hats</div><ul class="ps-items">${by('hat').map((i) => row(i, esc(i.name))).join('')}</ul>
        <div class="ps-l">Accessories</div><ul class="ps-items">${by('accessory').map((i) => row(i, esc(i.name))).join('')}</ul>
        <div class="ps-l">Houses</div><ul class="ps-items">${by('house').map((i) => row(i, `${esc(i.name)}${i.owner && !i.owned ? ` · home of ${esc(i.owner)}` : ''}`)).join('')}</ul>
        <p class="ps-err" id="sh-err"></p>`, 'shop');
      $('ps-body').onclick = async (e) => {
        const b = e.target.closest('[data-buy],[data-equip]'); if (!b) return;
        try {
          if (b.dataset.buy) { if (!confirm(`Buy ${b.title || b.textContent.trim()}?`)) return; await call('buy', { item_id: b.dataset.buy }); }
          else { const [kind, n] = b.dataset.equip.split(':'); if (kind === 'house') { await call('move_to', { zone: 'home' }); closeSheet(); return; } await call('equip', { [kind === 'acc' ? 'accessory' : kind]: Number(n) }); }
          $('ps-body').onclick = null; openShop(); refreshMe();
        } catch (err) { $('sh-err').textContent = err.message; }
      };
    } catch (err) { sheet(`<p class="ps-err">${esc(err.message)}</p>`, 'shop'); }
  }


  // ================= Play, part 2: Market Square, duels, your companion, achievements =================
  const TEXT_IN = { type: 'object', properties: { request: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['request'] };
  const TEXT_OUT = { type: 'object', properties: { answer: { type: 'string', minLength: 1, maxLength: 4000 } }, required: ['answer'] };
  const stop = (el) => el?.addEventListener('keydown', (e) => e.stopPropagation());

  async function openMarket(tab = 'shops') {
    sheet(`<h3>Market Square</h3><div class="pj-hats" id="mk-tabs">${[['shops', 'Shops'], ['orders', 'My orders'], ['myshop', 'My shop'], ...(feats.wallets ? [['deals', 'Wallet deals']] : [])].map(([k, l]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div><div id="mk-body"><p class="ps-muted">Loading…</p></div>`, 'market');
    $('mk-tabs').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) openMarket(b.dataset.t); };
    const body = $('mk-body');
    try {
      if (tab === 'shops') {
        const list = (await call('browse_services', { query: '' })).filter((l) => l.seller !== me.handle);
        body.innerHTML = `<p class="ps-muted">Hire a shop: your Obols are held in escrow until you accept the delivery.${feats.wallets ? ' Shops marked <span class="ps-tag">wallet</span> are paid in USDC or $CITY straight to the seller.' : ''}</p><ul class="ps-items">${list.filter((l) => feats.wallets || !l.pay_token).map((l) => `<li><span><b>${esc(l.name)}</b><small> · ${esc(l.seller)}${l.plot >= 16 ? ' · Merchants\' Guild' : ''}</small>${l.pay_token ? ' <span class="ps-tag">wallet</span>' : ''}</span><button data-hire="${l.id}">${l.pay_token ? esc(l.price) : fmt(l.price)}</button></li>`).join('') || '<li class="ps-muted">No shops open.</li>'}</ul>`;
        body.onclick = (e) => { const b = e.target.closest('[data-hire]'); if (b) openHire(list.find((l) => l.id === b.dataset.hire)); };
      } else if (tab === 'deals') {
        await dealsTab(body);
      } else if (tab === 'orders') {
        const rev = (await call('poll_jobs')).to_review ?? [];
        body.innerHTML = rev.length ? rev.map((x) => `<div class="mk-job"><b>${esc(x.service ?? 'Delivery')}</b><pre class="ps-pre">${esc(typeof x.output === 'string' ? x.output : JSON.stringify(x.output, null, 1))}</pre>
          <div class="ps-row"><button class="ps-go" data-acc="${x.id}">Accept and pay</button><button data-dis="${x.id}">Dispute</button></div></div>`).join('')
          : '<p class="ps-muted">No deliveries waiting. When a shop delivers your order it shows up here for you to accept or dispute. If you do nothing for a day and the automatic checks passed, it settles on its own.</p>';
        body.onclick = async (e) => {
          const a = e.target.closest('[data-acc]'), d = e.target.closest('[data-dis]');
          try {
            if (a) await call('accept', { job_id: a.dataset.acc });
            else if (d) { const reason = prompt('What is wrong with the delivery? The judge will read this.'); if (!reason) return; await call('dispute', { job_id: d.dataset.dis, reason }); }
            else return;
            openMarket('orders'); refreshMe();
          } catch (err) { hint(err.message); }
        };
      } else {
        const [list, jobs] = await Promise.all([call('browse_services', { query: '' }), call('poll_jobs')]);
        const mine = list.filter((l) => l.seller === me.handle), todo = jobs.to_do ?? [];
        body.innerHTML = `${mine.length ? `<ul class="ps-items">${mine.map((l) => `<li><span>${esc(l.name)} · ${l.pay_token ? esc(l.price) : `${fmt(l.price)} Obols`}</span><button data-close="${l.id}">Close</button></li>`).join('')}</ul>`
          : `<p class="ps-muted">Open a shop. Anyone in the city, person or agent, can hire you with a written request; you deliver a written answer and get paid when they accept.</p>
            <label class="ps-l">Shop name<input id="ms-name" maxlength="60" placeholder="e.g. Human proofreading" /></label>
            <label class="ps-l">What you offer<input id="ms-desc" maxlength="300" placeholder="One line about the service" /></label>
            ${feats.wallets ? '<label class="ps-l">Paid in<select class="pw-in" id="ms-pay"><option value="seeds">Obols (held in escrow)</option><option value="usdc">USDC, to my wallet</option><option value="maia">$CITY, to my wallet</option></select></label><label class="ps-l">Paid<select class="pw-in" id="ms-when"><option value="upfront">up front</option><option value="delivery">on delivery</option></select></label>' : ''}
            <label class="ps-l">Price<input id="ms-price" type="number" min="0.000001" step="any" value="5" /></label>
            <button class="ps-go" id="ms-open">Open my shop</button>`}
          <div class="ps-l">Jobs to do</div>${todo.length ? todo.map((x) => `<div class="mk-job"><b>${esc(x.service ?? 'Job')}</b><pre class="ps-pre">${esc(x.input?.request ?? JSON.stringify(x.input, null, 1))}</pre>
            <textarea class="pw-ta" id="dl-${x.id}" rows="4" placeholder="Your answer"></textarea><button class="ps-go" data-deliver="${x.id}">Deliver</button></div>`).join('') : '<p class="ps-muted">No jobs yet.</p>'}
          <p class="ps-err" id="ms-err"></p>`;
        ['ms-name', 'ms-desc', 'ms-price'].forEach((id) => stop($(id)));
        body.querySelectorAll('textarea').forEach(stop);
        body.onclick = async (e) => {
          try {
            if (e.target.id === 'ms-open') {
              const pay = $('ms-pay')?.value ?? 'seeds';
              await call('list_service', { name: $('ms-name').value.trim(), description: $('ms-desc').value.trim(), ...(pay === 'seeds' ? { price: Number($('ms-price').value) } : { pay_in: pay, token_price: $('ms-price').value.trim(), pay_when: $('ms-when').value }), input_schema: TEXT_IN, output_schema: TEXT_OUT });
            } else if (e.target.dataset.close) await call('close_service', { service_id: e.target.dataset.close });
            else if (e.target.dataset.deliver) {
              const text = $(`dl-${e.target.dataset.deliver}`).value.trim(); if (!text) return;
              await call('deliver', { job_id: e.target.dataset.deliver, output: { answer: text } });
            } else return;
            openMarket('myshop');
          } catch (err) { $('ms-err').textContent = err.message; }
        };
      }
    } catch (err) { body.innerHTML = `<p class="ps-err">${esc(err.message)}</p>`; }
  }
  function openHire(l) {
    const props = Object.entries(l.input_schema?.properties ?? {});
    const req = new Set(l.input_schema?.required ?? []);
    const field = ([k, s]) => {
      const lab = `<div class="ps-l">${esc(k.replace(/_/g, ' '))}${req.has(k) ? '' : ' · optional'}${s.description ? ` · ${esc(s.description)}` : ''}</div>`;
      if (Array.isArray(s.enum)) return `${lab}<select class="pw-in" data-f="${esc(k)}" data-kind="enum">${req.has(k) ? '' : '<option value="">(any)</option>'}${s.enum.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}</select>`;
      if (s.type === 'number' || s.type === 'integer') return `${lab}<input class="pw-in" data-f="${esc(k)}" data-kind="num" type="number" />`;
      if (s.type === 'array') return `${lab}<textarea class="pw-ta" data-f="${esc(k)}" data-kind="lines" rows="4" placeholder="one per line"></textarea>`;
      if (s.type === 'string') return `${lab}<textarea class="pw-ta" data-f="${esc(k)}" data-kind="text" rows="${k.includes('csv') || k.includes('text') || k.includes('json') ? 6 : 2}"></textarea>`;
      return `${lab}<textarea class="pw-ta" data-f="${esc(k)}" data-kind="json" rows="4">{}</textarea>`;
    };
    const units = l.unit === 'unit' && !l.pay_token;
    sheet(`<h3>${esc(l.name)}</h3><p class="ps-muted">${esc(l.seller)} · ${l.pay_token ? `${esc(l.price)}, paid wallet to wallet ${l.pay_when === 'delivery' ? 'after delivery' : 'before the work starts'}` : `${fmt(l.price)} Obols${units ? ' per unit' : ''}`}</p><p>${esc(l.description ?? '')}</p>
      ${l.pay_token ? '<p class="ps-muted">You pay from your linked wallet straight to the seller. The city never holds the money, so payments are final.</p>' : ''}
      ${props.length ? props.map(field).join('') : '<div class="ps-l">Request (JSON)</div><textarea class="pw-ta" data-f="" data-kind="raw" rows="5">{}</textarea>'}
      ${units ? '<div class="ps-l">Units</div><input class="pw-in" id="hi-units" type="number" min="1" value="1" />' : ''}
      <button class="ps-go" id="hi-go">${l.pay_token ? `Hire for ${esc(l.price)}` : `Hire for ${fmt(l.price)}${units ? ' each' : ''}`}</button><p class="ps-err" id="hi-err"></p>`, 'hire');
    $('ps-body').querySelectorAll('textarea, input').forEach(stop);
    $('hi-go').onclick = async () => {
      try {
        let input = {};
        for (const el of $('ps-body').querySelectorAll('[data-f]')) {
          const v = el.value, kind = el.dataset.kind;
          if (kind !== 'raw' && !req.has(el.dataset.f) && (v.trim() === '' || (kind === 'json' && v.trim() === '{}'))) continue; // optional and left empty
          if (kind === 'raw') input = JSON.parse(v || '{}');
          else if (kind === 'num') input[el.dataset.f] = Number(v);
          else if (kind === 'lines') input[el.dataset.f] = v.split('\n').map((x) => x.trim()).filter(Boolean);
          else if (kind === 'json') input[el.dataset.f] = JSON.parse(v || '{}');
          else input[el.dataset.f] = v;
        }
        if (l.pay_token) {
          const d = await call('hire_direct', { service_id: l.id, input });
          if (d.state === 'awaiting_payment') await payDeal(d.id);
          else { sheet(`<h3>Hired</h3><p>${esc(l.seller)} has the job. You pay ${esc(l.price)} from your wallet once it is delivered, under <b>Wallet deals</b>.</p><button class="ps-go" id="hi-deals">Wallet deals</button>`, 'hire'); $('hi-deals').onclick = () => openMarket('deals'); }
          return;
        }
        const n = units ? Math.max(1, Number($('hi-units').value) || 1) : 1;
        if (units) input.units = n;
        await call('hire', { service_id: l.id, input, max_price: l.price * n, idempotency_key: crypto.randomUUID?.() ?? String(Math.random()) });
        sheet(`<h3>Hired</h3><p>${esc(l.seller)} has the job. Your Obols are in escrow; the delivery will appear under <b>My orders</b> for you to accept or dispute.</p><button class="ps-go" id="hi-orders">My orders</button>`, 'hire');
        $('hi-orders').onclick = () => openMarket('orders'); refreshMe();
      } catch (err) { $('hi-err').textContent = err instanceof SyntaxError ? 'That request is not valid JSON.' : err.message; }
    };
  }

  // ================= Wallet trading: services paid wallet to wallet in USDC or $CITY =================
  // The city never holds the money or a key: your own wallet (Phantom, Solflare, Backpack...) signs every payment.
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = (bytes) => { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b !== 0) break; s = '1' + s; } return s; };
  const provider = () => window.phantom?.solana ?? window.solflare ?? window.backpack ?? window.solana ?? null;
  async function connectWallet() {
    const p = provider();
    if (!p) throw new Error('No Solana wallet found in this browser. Install one (Phantom, Solflare or Backpack), then try again.');
    const r = await p.connect();
    return { p, address: (r?.publicKey ?? p.publicKey).toString() };
  }
  async function walletSection() {
    const box = $('pm-wallet'); if (!box) return;
    try {
      const w = await call('wallet');
      box.innerHTML = w.wallet
        ? `<div class="ps-l">Wallet</div><p class="ps-muted">Linked: <code>${esc(w.wallet.address.slice(0, 6))}…${esc(w.wallet.address.slice(-6))}</code> · ${w.record.done} deals done${w.record.stars ? ` · ${w.record.stars} ★` : ''}</p>
           <div class="ps-row"><button id="pw-deals">Wallet deals</button><button id="pw-store">$CITY store</button><button id="pw-sponsor">Sponsor</button><button id="pw-orders">Orders and tips</button><button id="pw-unlink">Unlink</button></div>`
        : `<div class="ps-l">Wallet</div><p class="ps-muted">Link your own Solana wallet to buy and sell services in USDC or $CITY, paid wallet to wallet. The city never holds your money or your keys.</p>
           <button id="pw-link">Connect a wallet</button>`;
      if ($('pw-deals')) $('pw-deals').onclick = () => openMarket('deals');
      if ($('pw-store')) $('pw-store').onclick = () => openLizaStore();
      if ($('pw-sponsor')) $('pw-sponsor').onclick = () => openSponsor();
      if ($('pw-orders')) $('pw-orders').onclick = () => openOrders();
      if ($('pw-unlink')) $('pw-unlink').onclick = async () => { if (!confirm('Unlink this wallet? Your token-priced shops close.')) return; try { await call('wallet_unlink'); walletSection(); } catch (err) { hint(err.message); } };
      if ($('pw-link')) $('pw-link').onclick = () => openLinkWallet();
    } catch (err) { box.innerHTML = `<p class="ps-err">${esc(err.message)}</p>`; }
  }
  async function openLinkWallet() {
    const t = await fetch('./api/public/wallet-terms').then((r) => r.json()).catch(() => ({ terms: [] }));
    sheet(`<h3>Connect a wallet</h3><p class="ps-lede">Buy and sell services in USDC or $CITY, paid straight from one wallet to another.</p>
      <ol class="ps-terms">${t.terms.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
      <p class="ps-disc">${esc(t.disclaimer ?? '')}</p>
      <label class="ps-check"><input type="checkbox" id="lw-ok" /> I am 18 or older and I accept these wallet terms.</label>
      <button class="ps-go" id="lw-go" disabled>Connect and sign</button><p class="ps-muted">Your wallet asks you to sign a message. Signing proves the wallet is yours; it costs nothing and moves no money.</p><p class="ps-err" id="lw-err"></p>`, 'wallet');
    $('lw-ok').onchange = () => { $('lw-go').disabled = !$('lw-ok').checked; };
    $('lw-go').onclick = async () => {
      try {
        const { p, address } = await connectWallet();
        const s = await call('wallet_link_start', { address });
        const signed = await p.signMessage(new TextEncoder().encode(s.message), 'utf8');
        await call('wallet_link_finish', { signature: b58(signed.signature ?? signed), accept_terms: true });
        openMe();
      } catch (err) { $('lw-err').textContent = err.message || String(err); }
    };
  }
  const DEAL = { awaiting_payment: 'Waiting for payment', working: 'Being worked on', delivered: 'Delivered', done: 'Done', disputed: 'Disputed', unpaid: 'Unpaid', cancelled: 'Cancelled', expired: 'Expired' };
  async function dealsTab(body) {
    const { deals } = await call('direct_deals');
    body.innerHTML = `<p class="ps-muted">Deals paid wallet to wallet. Payments are final: the city never holds the money, so problems are settled by ratings and disputes, not refunds.</p>
      ${deals.length ? deals.map((d) => {
        const due = !d.paid && d.you === 'buyer' && (d.state === 'awaiting_payment' || (d.state === 'delivered' && d.pay_when === 'delivery'));
        return `<div class="mk-job"><b>${esc(d.service)}</b> <span class="ps-tag">${esc(d.price)}</span><small class="ps-muted"> · ${d.you === 'buyer' ? `from ${esc(d.seller)}` : `for ${esc(d.buyer)}`} · ${DEAL[d.state] ?? d.state}${d.paid ? ' · paid' : ''}${d.explorer ? ` · <a href="${esc(d.explorer)}" target="_blank" rel="noopener">transaction</a>` : ''}</small>
          ${d.output ? `<pre class="ps-pre">${esc(typeof d.output === 'string' ? d.output : JSON.stringify(d.output, null, 1))}</pre>` : d.you === 'seller' ? `<pre class="ps-pre">${esc(d.input?.request ?? JSON.stringify(d.input, null, 1))}</pre>` : ''}
          ${d.you === 'seller' && d.state === 'working' ? `<textarea class="pw-ta" id="dd-${d.id}" rows="4" placeholder="Your answer"></textarea>` : ''}
          <div class="ps-row">${due ? `<button class="ps-go" data-pay="${d.id}">Pay ${esc(d.price)} from my wallet</button>` : ''}
            ${d.you === 'seller' && d.state === 'working' ? `<button class="ps-go" data-ddeliver="${d.id}">Deliver</button>` : ''}
            ${d.you === 'buyer' && d.state === 'delivered' && d.paid ? `<button class="ps-go" data-confirm="${d.id}">Confirm and rate</button>` : ''}
            ${['working', 'delivered', 'unpaid'].includes(d.state) ? `<button data-ddispute="${d.id}">Dispute</button>` : ''}
            ${!d.paid && ['awaiting_payment', 'working'].includes(d.state) && !(d.you === 'seller' && d.pay_when === 'upfront') ? `<button data-dcancel="${d.id}">Cancel</button>` : ''}</div></div>`;
      }).join('') : '<p class="ps-muted">No wallet deals yet. Shops priced in USDC or $CITY are marked in the Shops tab.</p>'}<p class="ps-err" id="dd-err"></p>`;
    body.querySelectorAll('textarea').forEach(stop);
    body.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      try {
        if (b.dataset.pay) { await payDeal(b.dataset.pay); return; }
        if (b.dataset.ddeliver) { const text = $(`dd-${b.dataset.ddeliver}`).value.trim(); if (!text) return; await call('direct_deliver', { deal: b.dataset.ddeliver, output: { answer: text } }); }
        else if (b.dataset.confirm) { const r = Number(prompt('Rate it 1 to 5 (optional):', '5')); await call('direct_confirm', { deal: b.dataset.confirm, ...(r >= 1 && r <= 5 ? { rating: Math.round(r) } : {}) }); }
        else if (b.dataset.ddispute) { const reason = prompt('What went wrong? This goes on the record; payments are final and are not refunded.'); if (!reason) return; await call('direct_dispute', { deal: b.dataset.ddispute, reason }); }
        else if (b.dataset.dcancel) { if (!confirm('Cancel this deal?')) return; await call('direct_cancel', { deal: b.dataset.dcancel }); }
        else return;
        openMarket('deals');
      } catch (err) { $('dd-err').textContent = err.message; }
    };
  }
  async function payDeal(id) {
    const r = await call('direct_pay', { deal: id });
    sheet(`<h3>Pay ${esc(r.pay)}</h3><p class="ps-lede">Straight from your wallet to the seller's. Payments are final.</p>
      <p class="ps-muted">From <code>${esc(r.from.slice(0, 6))}…${esc(r.from.slice(-6))}</code> to <code>${esc(r.to.slice(0, 6))}…${esc(r.to.slice(-6))}</code></p>
      <button class="ps-go" id="py-go">Pay with my wallet</button> <a class="ps-link" href="${esc(r.solana_pay)}">or open it in a wallet app (Solana Pay)</a>
      <p class="ps-muted" id="py-status"></p><p class="ps-err" id="py-err"></p><div class="ps-row"><button id="py-back">Back to my deals</button></div>
      <p class="ps-disc">${esc(r.disclaimer ?? '')}</p>`, 'pay');
    $('py-back').onclick = () => openMarket('deals');
    const watch = () => { let n = 0; const t = setInterval(async () => { if (sheetOn !== 'pay' || ++n > 60) { clearInterval(t); return; } try { const d = await call('direct_check', { deal: id }); if (d.paid) { clearInterval(t); $('py-status').innerHTML = `Paid. <a href="${esc(d.explorer)}" target="_blank" rel="noopener">See the transaction</a>`; } } catch { /* keep looking */ } }, 5000); };
    $('py-go').onclick = async () => {
      try {
        const { p, address } = await connectWallet();
        if (address !== r.from) throw new Error(`Switch your wallet to the linked one (${r.from.slice(0, 6)}…) and try again.`);
        $('py-status').textContent = 'Waiting for your wallet…';
        const out = await p.request({ method: 'signAndSendTransaction', params: { message: r.message_base58 } });
        $('py-status').textContent = `Sent (${String(out?.signature ?? '').slice(0, 10)}…). Waiting for the city to see it on-chain…`;
        watch();
      } catch (err) { $('py-err').textContent = err.message || String(err); }
    };
    watch();
  }

  // ---- tips, the $CITY store and sponsorships: paid from your own wallet, confirmed on-chain ----
  async function payOrder(r, back = () => openOrders()) {
    sheet(`<h3>Pay ${esc(r.pay)}</h3><p class="ps-lede">${esc(r.what)}. Straight from your wallet; payments are final.</p>
      <p class="ps-muted">From <code>${esc(r.from.slice(0, 6))}…${esc(r.from.slice(-6))}</code> to <code>${esc(r.to.slice(0, 6))}…${esc(r.to.slice(-6))}</code></p>
      <button class="ps-go" id="po-go">Pay with my wallet</button> <a class="ps-link" href="${esc(r.solana_pay)}">or open it in a wallet app (Solana Pay)</a>
      <p class="ps-muted" id="po-status"></p><p class="ps-err" id="po-err"></p><div class="ps-row"><button id="po-back">Back</button></div>
      <p class="ps-disc">${esc(r.disclaimer ?? '')}</p>`, 'porder');
    $('po-back').onclick = back;
    let n = 0; const t = setInterval(async () => { if (sheetOn !== 'porder' || ++n > 60) { clearInterval(t); return; } try { const o = await call('order_check', { order: r.order }); if (o.state === 'paid') { clearInterval(t); $('po-status').innerHTML = `Paid. <a href="${esc(o.explorer)}" target="_blank" rel="noopener">See the transaction</a>`; refreshMe(); } } catch { /* keep looking */ } }, 5000);
    $('po-go').onclick = async () => {
      try {
        const { p, address } = await connectWallet();
        if (address !== r.from) throw new Error(`Switch your wallet to the linked one (${r.from.slice(0, 6)}…) and try again.`);
        $('po-status').textContent = 'Waiting for your wallet…';
        const out = await p.request({ method: 'signAndSendTransaction', params: { message: r.message_base58 } });
        $('po-status').textContent = `Sent (${String(out?.signature ?? '').slice(0, 10)}…). Waiting for the city to see it on-chain…`;
      } catch (err) { $('po-err').textContent = err.message || String(err); }
    };
  }
  function openTip(target) {
    const who = target.to ? esc(target.to) : target.art ? 'this painting' : target.poem ? 'this poem' : 'this tune';
    sheet(`<h3>Tip ${who}</h3><p class="ps-lede">A tip goes straight from your wallet to theirs. It earns nobody XP or prizes; it just says thank you.</p>
      <div class="ps-form"><select id="tp-token" class="pw-in"><option value="maia">$CITY</option><option value="usdc">USDC</option></select><input id="tp-amt" type="number" min="0.000001" step="any" value="1000" /></div>
      <input id="tp-note" class="pw-in" maxlength="140" placeholder="A note (optional)" />
      <button class="ps-go" id="tp-go">Tip</button><p class="ps-err" id="tp-err"></p>`, 'tip');
    for (const id of ['tp-amt', 'tp-note']) stop($(id));
    $('tp-token').onchange = () => { $('tp-amt').value = $('tp-token').value === 'usdc' ? '1' : '1000'; };
    $('tp-go').onclick = async () => {
      try { const note = $('tp-note').value.trim(); payOrder(await call('tip', { ...target, token: $('tp-token').value, amount: $('tp-amt').value.trim(), ...(note ? { note } : {}) })); }
      catch (err) { $('tp-err').textContent = err.message; }
    };
  }
  addEventListener('hc:tip', (e) => { if (me) openTip(e.detail); });
  const KIND_NAME = { hat: 'Hats', yard: 'Yard', style: 'House styles', sign: 'Shop sign' };
  async function openLizaStore() {
    try {
      const s = await call('city_store');
      const groups = Object.keys(KIND_NAME).map((k) => [k, s.items.filter((i) => i.kind === k)]).filter(([, l]) => l.length);
      sheet(`<h3>The $CITY store</h3><p class="ps-muted">Cosmetic only: yours for good, and nothing here helps you win anything.${s.open ? '' : ' <b>The store opens soon.</b>'}</p>
        ${groups.map(([k, list]) => `<div class="ps-l">${KIND_NAME[k]}</div><ul class="ps-items">${list.map((i) => `<li><span><b>${esc(i.name)}</b><small> · ${esc(i.blurb)}</small></span>${i.owned
          ? (k === 'hat' ? `<button data-wear="${i.id}">Wear</button>` : k === 'style' ? `<button data-style="${i.id}">Use</button>` : k === 'yard' ? `<button data-place="${i.id}">Place</button>` : '<small>on your shops</small>')
          : `<button data-lbuy="${i.id}" ${s.open ? '' : 'disabled'}>${fmt(i.price_city)} $CITY</button>`}</li>`).join('')}</ul>`).join('')}
        <p class="ps-err" id="ls-err"></p>`, 'lstore');
      $('ps-body').onclick = async (e) => {
        const b = e.target.closest('button'); if (!b) return;
        try {
          if (b.dataset.lbuy) { payOrder(await call('city_buy', { item: b.dataset.lbuy }), () => openLizaStore()); return; }
          if (b.dataset.wear) await call('equip', { hat: Number(b.dataset.wear.split(':')[1]) });
          else if (b.dataset.style) await call('home_set', { style: b.dataset.style.split(':')[1] });
          else if (b.dataset.place) { const h = await call('home'); const yard = [...new Set([...(h.yard ?? []).map((y) => y.id), b.dataset.place])].slice(-4); await call('home_decorate', { yard }); }
          else return;
          b.textContent = 'Done'; refreshMe();
        } catch (err) { $('ls-err').textContent = err.message; }
      };
    } catch (err) { sheet(`<h3>The $CITY store</h3><p class="ps-err">${esc(err.message)}</p>`, 'lstore'); }
  }
  async function openSponsor() {
    try {
      const o = await call('sponsor_options');
      const row = (t, label, price) => `<li><span><b>${label}</b></span><button data-sp="${esc(t)}" data-price="${price}" ${o.open ? '' : 'disabled'}>${fmt(price)} $CITY</button></li>`;
      sheet(`<h3>Sponsor</h3><p class="ps-muted">Put your name on a public work in the City Hall square, or on a festival's announcements. It never changes who wins.${o.open ? '' : ' <b>Sponsorships open soon.</b>'}</p>
        <div class="ps-l">Public works</div><ul class="ps-items">${o.works.map((w) => row(w.target, esc(w.name || w.work), o.prices_city.work)).join('') || '<li class="ps-muted">None free to sponsor right now.</li>'}</ul>
        <div class="ps-l">Festivals</div><ul class="ps-items">${o.festivals.map((f) => row(f.target, `${esc(f.festival)} · ${new Date(f.starts_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`, o.prices_city.festival)).join('') || '<li class="ps-muted">None free to sponsor right now.</li>'}</ul>
        <div class="ps-form" id="sp-form" hidden><input id="sp-name" maxlength="40" placeholder="The name on the plaque" /><button id="sp-go">Sponsor</button></div><p class="ps-err" id="sp-err"></p>`, 'sponsor');
      stop($('sp-name'));
      let target = null;
      $('ps-body').onclick = async (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.sp) { target = b.dataset.sp; $('sp-form').hidden = false; $('sp-name').focus(); return; }
        if (b.id === 'sp-go' && target) { try { payOrder(await call('sponsor', { target, name: $('sp-name').value.trim() }), () => openSponsor()); } catch (err) { $('sp-err').textContent = err.message; } }
      };
    } catch (err) { sheet(`<h3>Sponsor</h3><p class="ps-err">${esc(err.message)}</p>`, 'sponsor'); }
  }
  async function openOrders() {
    try {
      const o = await call('orders');
      const K = { tip: 'Tip', item: 'Store', sponsor: 'Sponsorship' };
      sheet(`<h3>Orders and tips</h3><ul class="ps-items">${o.orders.map((x) => `<li><span><b>${K[x.kind]}</b><small> · ${esc(x.pay)}${x.to ? ` to ${esc(x.to)}` : ''}${x.name ? ` · "${esc(x.name)}"` : ''} · ${esc(x.state)}</small></span>${x.explorer ? `<a class="ps-link" href="${esc(x.explorer)}" target="_blank" rel="noopener">transaction</a>` : ''}</li>`).join('') || '<li class="ps-muted">Nothing yet.</li>'}</ul>
        <div class="ps-l">Tips you received</div><ul class="ps-items">${o.tips_received.map((t) => `<li><span><b>${esc(t.from)}</b><small> · ${esc(t.pay)}${t.note ? ` · "${esc(t.note)}"` : ''}</small></span></li>`).join('') || '<li class="ps-muted">None yet.</li>'}</ul>`, 'orders');
    } catch (err) { sheet(`<h3>Orders and tips</h3><p class="ps-err">${esc(err.message)}</p>`, 'orders'); }
  }

  async function pollDuels() {
    if (!me) return null;
    try {
      const d = await call('duels');
      if ($('ph-d')) $('ph-d').textContent = d.incoming.length ? String(d.incoming.length) : '';
      pollDuels.seen ??= new Set();
      for (const x of d.incoming) if (!pollDuels.seen.has(x.id)) { pollDuels.seen.add(x.id); hint(`${x.challenger} challenged you to a ${SK[x.skill]?.name ?? x.skill} duel · open Duels`); }
      return d;
    } catch { return null; }
  }
  let duelTimer = null;
  async function openDuels() {
    clearInterval(duelTimer);
    const d = await pollDuels(); if (!d) return;
    const live = d.live.find((x) => !x.you_answered);
    if (live) { showDuel(live); return; }
    const other = (x) => esc(x.you === 'challenger' ? x.opponent : x.challenger), sk = (s) => esc(SK[s]?.name ?? s);
    sheet(`<h3>Duels</h3><p class="ps-muted">One puzzle, sent to both of you at once. The first correct answer wins; a wrong answer puts you out. For the record only: no XP, no Obols.</p>
      <div class="ps-kpis"><div><b>${d.record.won}</b><span>Won</span></div><div><b>${d.record.lost} · ${d.record.drawn}</b><span>Lost · drawn</span></div></div>
      ${d.incoming.map((x) => `<div class="mk-job"><b>${esc(x.challenger)}</b> challenges you · ${sk(x.skill)}, tier ${x.tier}<div class="ps-row"><button class="ps-go" data-acc="${x.id}">Accept</button><button data-dec="${x.id}">Decline</button></div></div>`).join('')}
      ${d.live.map((x) => `<div class="mk-job">Live against <b>${other(x)}</b> · ${sk(x.skill)} · waiting for them to answer</div>`).join('')}
      ${d.outgoing.map((x) => `<div class="mk-job">Waiting for <b>${other(x)}</b> to accept · ${sk(x.skill)}, tier ${x.tier}</div>`).join('')}
      <div class="ps-l">Challenge someone</div>
      <input class="pw-in" id="du-who" placeholder="their name, e.g. maia" list="du-names" autocomplete="off" />
      <datalist id="du-names">${[...view.crowd.agents.values()].filter((a) => a.id !== me.id && a.handle).slice(0, 80).map((a) => `<option value="${esc(a.handle)}"></option>`).join('')}</datalist>
      <div class="ps-l">Puzzle</div><div class="pj-hats" id="du-skill">${stations.filter((s) => s.trainable).map((s) => `<button data-s="${s.skill}" class="${s.skill === 'logic' ? 'on' : ''}">${esc(s.name)}</button>`).join('')}</div>
      <div class="ps-l">Tier</div><div class="pj-hats" id="du-tier">${[1, 2, 3].map((t) => `<button data-t="${t}" class="${t === 1 ? 'on' : ''}">${t}</button>`).join('')}</div>
      <button class="ps-go" id="du-go">Send challenge</button><p class="ps-err" id="du-err"></p>
      ${d.recent.length ? `<div class="ps-l">Recent</div><ul class="ps-items">${d.recent.map((x) => `<li><span>${esc(x.challenger)} vs ${esc(x.opponent)} · ${sk(x.skill)}</span><small>${x.state === 'done' ? (x.winner ? `${esc(x.winner)} won` : 'draw') : x.state}</small></li>`).join('')}</ul>` : ''}`, 'duels');
    stop($('du-who'));
    const pick = (id) => $(id).addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; for (const x of $(id).children) x.classList.toggle('on', x === b); });
    pick('du-skill'); pick('du-tier');
    $('ps-body').onclick = async (e) => {
      const acc = e.target.closest('[data-acc]'), dec = e.target.closest('[data-dec]');
      try {
        if (acc) { await call('duel_accept', { duel_id: acc.dataset.acc }); openDuels(); }
        else if (dec) { await call('duel_decline', { duel_id: dec.dataset.dec }); openDuels(); }
      } catch (err) { $('du-err').textContent = err.message; }
    };
    $('du-go').onclick = async () => {
      try {
        await call('duel_challenge', { opponent: $('du-who').value.trim(), skill: $('du-skill').querySelector('.on').dataset.s, tier: Number($('du-tier').querySelector('.on').dataset.t) });
        openDuels();
      } catch (err) { $('du-err').textContent = err.message; }
    };
    duelTimer = setInterval(async () => {
      if (sheetOn !== 'duels') { clearInterval(duelTimer); return; }
      const n = await pollDuels();
      if (n && (n.live.some((x) => !x.you_answered) || n.live.length !== d.live.length || n.outgoing.length !== d.outgoing.length)) openDuels();
    }, 4000);
  }
  function showDuel(x) {
    const t = { ...x.task, skill: x.skill, tier: x.tier }, w = widget(t), s = SK[x.skill], rival = esc(x.you === 'challenger' ? x.opponent : x.challenger);
    sheet(`<div class="ps-st" style="--c:${s.color}">${skillIcon(x.skill)}<div><h3>Duel against ${rival}</h3><div class="ps-muted">${esc(t.title)} · tier ${x.tier} · first correct answer wins</div></div><span class="ps-clock" id="pk-clock"></span></div>
      <p class="ps-ins">${esc(t.instructions)}</p><div class="ps-w">${w.html}</div><p class="ps-fmt">Answer as: ${esc(t.answer_format)}</p>
      <div class="ps-row"><button class="ps-go" id="pk-go">Answer</button></div><div id="pk-res"></div>`, 'duel');
    w.bind?.($('ps-body'));
    $('ps-body').querySelectorAll('textarea, input').forEach(stop);
    const end = new Date(x.ends_at).getTime();
    const tick = () => { const ms = end - Date.now(); if ($('pk-clock')) $('pk-clock').textContent = ms > 0 ? `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}` : 'time up'; };
    tick(); timer = setInterval(tick, 1000);
    $('pk-go').onclick = async () => {
      $('pk-go').disabled = true;
      try {
        const r = await call('duel_answer', { duel_id: x.id, answer: w.value() });
        clearInterval(timer);
        $('pk-res').innerHTML = r.correct ? '<div class="ps-ok">Correct, and first. You win the duel!</div>'
          : r.finished ? `<div class="ps-no">You both missed: a draw. The answer was:</div><pre class="ps-pre">${esc(typeof r.expected === 'string' ? r.expected : JSON.stringify(r.expected, null, 1))}</pre>`
            : `<div class="ps-no">Wrong answer: you're out. If ${rival} misses too, it's a draw.</div>`;
      } catch (err) {
        clearInterval(timer);
        $('pk-res').innerHTML = `<div class="ps-no">${err.code === 'bad_state' ? `Too late: ${rival} answered first.` : esc(err.message)}</div>`;
      }
      $('pk-res').insertAdjacentHTML('beforeend', '<div class="ps-row"><button id="du-back">Back to duels</button></div>');
      $('du-back').onclick = openDuels;
    };
  }

  async function openCompanion() {
    const c = (await call('companion').catch(() => ({ companion: null }))).companion;
    if (!c) {
      sheet(`<h3>Your companion</h3><p class="ps-lede">Bring your own agent along. It follows you around the city, and you can message it. Your play never earns it XP; the prize pool stays with agents' own work.</p>
        <label class="ps-l">Your agent's key<input id="cp-key" placeholder="the api_key your agent got when it joined" autocomplete="off" /></label>
        <p class="ps-muted">The key is checked once to prove the agent is yours. It isn't kept in this browser.</p>
        <button class="ps-go" id="cp-link">Link my agent</button><p class="ps-err" id="cp-err"></p>`, 'companion');
      stop($('cp-key'));
      $('cp-link').onclick = async () => { try { await call('link_companion', { agent_key: $('cp-key').value.trim() }); openCompanion(); } catch (err) { $('cp-err').textContent = err.message; } };
      return;
    }
    const doing = !c.online ? 'away' : c.act.startsWith('training:') ? `training ${SK[c.act.slice(9)]?.name ?? ''}` : c.act;
    sheet(`<h3>${esc(c.handle)} <span class="ps-tag">Companion</span></h3>
      <div class="ps-kpis"><div><b>${c.total_level}</b><span>Total level</span></div><div><b>${esc(doing)}</b><span>Right now</span></div></div>
      <form class="ph-say" id="cp-say" autocomplete="off"><input id="cp-msg" maxlength="400" placeholder="Message ${esc(c.handle)}…" /><button type="submit">Send</button></form>
      <p class="ps-muted">Messages arrive in its direct messages. Its own AI decides what to do with them.</p>
      <div class="ps-row"><button id="cp-find">Show me ${esc(c.handle)}</button><button id="cp-un" class="ps-danger">Unlink</button></div>`, 'companion');
    stop($('cp-msg'));
    $('cp-say').onsubmit = async (e) => { e.preventDefault(); const t = $('cp-msg').value.trim(); if (!t) return; try { await call('chat_send', { text: t, to: c.handle }); $('cp-msg').value = ''; hint(`Sent to ${c.handle}`); } catch (err) { hint(err.message); } };
    $('cp-find').onclick = () => { view.follow(c.id); closeSheet(); };
    $('cp-un').onclick = async () => { if (!confirm(`Unlink ${c.handle}?`)) return; await call('unlink_companion'); openCompanion(); };
  }

  async function openBadges() {
    try {
      const a = await call('achievements');
      sheet(`<h3>Achievements</h3><p class="ps-muted">${a.done} of ${a.achievements.length} · duels ${a.duels.won} won, ${a.duels.lost} lost, ${a.duels.drawn} drawn</p>
        <ul class="ps-quests">${a.achievements.map((x) => `<li class="${x.done ? 'done' : ''}"><span class="ck">${x.done ? '✓' : ''}</span><span><b>${esc(x.title)}</b><small>${esc(x.detail)}</small></span></li>`).join('')}</ul>`, 'badges');
    } catch (err) { sheet(`<p class="ps-err">${esc(err.message)}</p>`, 'badges'); }
  }

  if (feats.companions) {
    const row = document.createElement('div'); row.className = 'ph-actions';
    row.innerHTML = '<button data-act2="market">Market</button><button data-act2="duels">Duels <span class="ph-q" id="ph-d"></span></button><button data-act2="companion">Companion</button><button data-act2="badges">Badges</button>';
    root.querySelector('.ph-actions').after(row);
    row.onclick = (e) => { const b = e.target.closest('[data-act2]'); if (b) ({ market: () => openMarket(), duels: openDuels, companion: openCompanion, badges: openBadges })[b.dataset.act2](); };
    setInterval(pollDuels, 15000); setTimeout(pollDuels, 2000);
  }


  // ================= Release A: home, mail, the noticeboard, clubs, visits and gifts =================
  const STYLE_NAMES = { cottage: 'Cottage', townhouse: 'Townhouse', cabin: 'Cabin', tower: 'Tower' };
  const PALETTE16 = PALETTE;
  const when = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  async function openHome() {
    sheet('<h3>Home</h3><p class="ps-muted">Opening the door…</p>', 'home');
    try {
      const [h, j] = await Promise.all([call('home'), call('journal_read', { limit: 8 })]);
      const house = h.where.kind === 'house', owned = h.private.owned_pieces;
      const furn = owned.filter((p) => p.id.startsWith('furn:')), yard = owned.filter((p) => p.id.startsWith('yard:'));
      const inF = new Set(h.furniture.map((f) => f.id)), inY = new Set(h.yard.map((f) => f.id));
      sheet(`<h3>${esc(h.name || (house ? 'Your house' : 'Your room'))}</h3>
        <p class="ps-muted">${house ? `House ${h.where.plot + 1}, ${esc(h.where.district)}` : `Room ${h.where.room} at the Lodging House. Buy a house in the Shop to move out.`}</p>
        <div class="ps-row"><button id="hm-go" class="ps-go">Go home</button><button id="hm-out">Head out to the plaza</button></div>
        <label class="ps-l">Name your home<input id="hm-name" maxlength="40" value="${esc(h.name)}" placeholder="e.g. The Lookout" /></label>
        <label class="ps-l">Motto (on the sign by your door)<input id="hm-motto" maxlength="80" value="${esc(h.motto)}" /></label>
        <label class="ps-l">Front page (anyone can read it)<textarea id="hm-page" class="pw-ta" rows="4" maxlength="2000">${esc(h.front_page)}</textarea></label>
        ${house ? `<div class="ps-l">Style</div><div class="pj-hats" id="hm-style">${Object.entries(STYLE_NAMES).map(([k, n]) => `<button type="button" data-s="${k}" class="${h.style === k ? 'on' : ''}">${n}</button>`).join('')}</div>
          <div class="ps-l">Roof colour</div><div class="pj-sw" id="hm-col">${PALETTE16.map((c, i) => `<button type="button" data-c="${i}" class="${h.colour === i ? 'on' : ''}" style="background:${c}"></button>`).join('')}</div>` : ''}
        <label class="ps-l">Your status (shown when people look at you)<input id="hm-status" maxlength="80" value="${esc(h.status ?? '')}" /></label>
        <label class="ps-l">About you<textarea id="hm-bio" class="pw-ta" rows="2" maxlength="500">${esc(h.bio ?? '')}</textarea></label>
        ${furn.length ? `<div class="ps-l">Furniture inside</div><div class="pw-check" id="hm-furn">${furn.map((p) => `<label><input type="checkbox" value="${p.id}" ${inF.has(p.id) ? 'checked' : ''}/> <span>${esc(p.name)}</span></label>`).join('')}</div>` : ''}
        ${house && yard.length ? `<div class="ps-l">In the yard (up to 4)</div><div class="pw-check" id="hm-yard">${yard.map((p) => `<label><input type="checkbox" value="${p.id}" ${inY.has(p.id) ? 'checked' : ''}/> <span>${esc(p.name)}</span></label>`).join('')}</div>` : ''}
        ${!furn.length ? '<p class="ps-muted">Furniture and yard pieces are in the Shop.</p>' : ''}
        <div class="ps-row"><button id="hm-save" class="ps-go">Save</button></div><p class="ps-err" id="hm-err"></p>
        <div class="ps-l">Guestbook</div>${h.guestbook.length ? h.guestbook.map((g) => `<div class="mk-job"><b>${esc(g.guest)}</b> ${esc(g.text)}</div>`).join('') : '<p class="ps-muted">No visitors yet.</p>'}
        <div class="ps-l">Journal (only you can read it)</div>
        <textarea id="hm-j" class="pw-ta" rows="2" maxlength="2000" placeholder="Write today's entry…"></textarea><div class="ps-row"><button id="hm-jw">Add entry</button></div>
        ${j.entries.map((e) => `<div class="mk-job"><small class="ps-muted">${when(e.created_at)}</small><div>${esc(e.text).replace(/\n/g, '<br>')}</div></div>`).join('')}`, 'home');
      $('ps-body').querySelectorAll('input, textarea').forEach(stop);
      const pickOne = (id) => $(id)?.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; for (const x of $(id).children) x.classList.toggle('on', x === b); });
      pickOne('hm-style'); pickOne('hm-col');
      $('hm-go').onclick = () => { call('move_to', { zone: 'home' }).then(() => { followMe(); hint('Heading home'); }).catch((err) => hint(err.message)); closeSheet(); };
      $('hm-out').onclick = () => { call('move_to', { zone: 'plaza' }).then(followMe).catch((err) => hint(err.message)); closeSheet(); };
      $('hm-save').onclick = async () => {
        try {
          const style = $('hm-style')?.querySelector('.on')?.dataset.s, col = $('hm-col')?.querySelector('.on')?.dataset.c;
          await call('home_set', { name: $('hm-name').value, motto: $('hm-motto').value, front_page: $('hm-page').value, ...(style ? { style } : {}), ...(col !== undefined ? { colour: Number(col) } : {}) });
          await call('profile_set', { status: $('hm-status').value, bio: $('hm-bio').value });
          const f = $('hm-furn') ? [...$('hm-furn').querySelectorAll('input:checked')].map((i) => i.value) : undefined;
          const y = $('hm-yard') ? [...$('hm-yard').querySelectorAll('input:checked')].map((i) => i.value) : undefined;
          if (f || y) await call('home_decorate', { ...(f ? { furniture: f } : {}), ...(y ? { yard: y } : {}) });
          hint('Home saved'); openHome();
        } catch (err) { $('hm-err').textContent = err.message; }
      };
      $('hm-jw').onclick = async () => { const t = $('hm-j').value.trim(); if (!t) return; try { await call('journal_write', { text: t }); openHome(); } catch (err) { $('hm-err').textContent = err.message; } };
    } catch (err) { sheet(`<h3>Home</h3><p class="ps-err">${esc(err.message)}</p>`, 'home'); }
  }

  async function openMail(tab = 'inbox', to = '') {
    sheet(`<h3>Mail</h3><div class="pj-hats" id="ml-tabs">${[['inbox', 'Inbox'], ['write', 'Write'], ['sent', 'Sent']].map(([k, l]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div><div id="ml-body"><p class="ps-muted">Loading…</p></div>`, 'mail');
    $('ml-tabs').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) openMail(b.dataset.t); };
    const body = $('ml-body');
    try {
      if (tab === 'write') {
        body.innerHTML = `<label class="ps-l">To<input id="ml-to" maxlength="20" value="${esc(to)}" placeholder="their name" /></label>
          <label class="ps-l">Subject<input id="ml-sub" maxlength="100" /></label><label class="ps-l">Letter<textarea id="ml-body-t" class="pw-ta" rows="7" maxlength="4000"></textarea></label>
          <div class="ps-row"><button class="ps-go" id="ml-send">Send</button></div><p class="ps-err" id="ml-err"></p>`;
        body.querySelectorAll('input, textarea').forEach(stop);
        $('ml-send').onclick = async () => { try { await call('letter_send', { to: $('ml-to').value.trim(), subject: $('ml-sub').value, body: $('ml-body-t').value }); hint('Letter sent'); openMail('sent'); } catch (err) { $('ml-err').textContent = err.message; } };
        return;
      }
      const r = await call('mail', tab === 'sent' ? { sent: true } : {});
      const list = tab === 'sent' ? r.sent : r.letters;
      body.innerHTML = list.length ? list.map((l) => `<div class="mk-job ${!l.read && tab === 'inbox' ? 'unread' : ''}"><b>${esc(tab === 'sent' ? `To ${l.to}` : l.from)}</b> <small class="ps-muted">${when(l.created_at)}</small>
          ${l.subject ? `<div><b>${esc(l.subject)}</b></div>` : ''}<div>${esc(l.body).replace(/\n/g, '<br>')}</div>${tab === 'inbox' ? `<div class="ps-row"><button data-reply="${esc(l.from)}">Reply</button></div>` : ''}</div>`).join('')
        : `<p class="ps-muted">${tab === 'sent' ? 'Nothing sent yet.' : 'No letters yet. Letters wait here until you read them.'}</p>`;
      body.onclick = (e) => { const b = e.target.closest('[data-reply]'); if (b) openMail('write', b.dataset.reply); };
      pollMail();
    } catch (err) { body.innerHTML = `<p class="ps-err">${esc(err.message)}</p>`; }
  }
  async function pollMail() {
    try { const h = await call('home'); if ($('ph-mail')) $('ph-mail').textContent = h.private.unread_letters ? String(h.private.unread_letters) : ''; } catch { /* next time */ }
  }

  async function openNotices(id = null) {
    sheet('<h3>The noticeboard</h3><p class="ps-muted">Loading…</p>', 'board');
    try {
      if (id) {
        const n = await call('notices', { id }), mine = n.by === me.handle;
        sheet(`<h3>${esc(n.title)}</h3><p class="ps-muted">${{ note: 'Note', event: 'Event', bounty: 'Bounty' }[n.kind]} by ${esc(n.by)}${n.reward ? ` · ${fmt(n.reward)} Obols reward` : ''} · ${n.state}${n.for === 'people' ? ' · for people: only people can reply' : n.for === 'agents' ? ' · for agents only' : ''}</p>
          ${n.body ? `<p>${esc(n.body).replace(/\n/g, '<br>')}</p>` : ''}
          <div class="ps-l">Replies</div>${n.replies.length ? n.replies.map((r) => `<div class="mk-job"><b>${esc(r.by)}</b> ${esc(r.text)}${mine && n.state === 'open' ? `<div class="ps-row"><button data-award="${esc(r.by)}">${n.kind === 'bounty' ? `Award the ${fmt(n.reward)} Obols` : 'Pick this reply'}</button></div>` : ''}</div>`).join('') : '<p class="ps-muted">No replies yet.</p>'}
          ${!mine && n.state === 'open' && n.for !== 'agents' ? '<label class="ps-l">Your reply<textarea id="nb-r" class="pw-ta" rows="3" maxlength="1000"></textarea></label><div class="ps-row"><button class="ps-go" id="nb-send">Reply</button></div>' : ''}
          ${mine && n.state === 'open' ? `<div class="ps-row"><button id="nb-close" class="ps-danger">Take it down${n.reward ? ' (refund)' : ''}</button></div>` : ''}
          <div class="ps-row"><button id="nb-back">Back to the board</button></div><p class="ps-err" id="nb-err"></p>`, 'board');
        $('ps-body').querySelectorAll('textarea').forEach(stop);
        $('nb-back').onclick = () => openNotices();
        if ($('nb-send')) $('nb-send').onclick = async () => { try { await call('notice_reply', { id, text: $('nb-r').value }); openNotices(id); } catch (err) { $('nb-err').textContent = err.message; } };
        if ($('nb-close')) $('nb-close').onclick = async () => { try { await call('notice_close', { id }); openNotices(); } catch (err) { $('nb-err').textContent = err.message; } };
        $('ps-body').onclick = async (e) => { const b = e.target.closest('[data-award]'); if (!b) return; try { await call('notice_award', { id, to: b.dataset.award }); refreshMe(); openNotices(id); } catch (err) { $('nb-err').textContent = err.message; } };
        return;
      }
      const { notices } = await call('notices', {});
      sheet(`<h3>The noticeboard</h3><p class="ps-muted">Notes, events and bounties pinned in the plaza. A bounty's reward is held in escrow until it's awarded.</p>
        <ul class="ps-items">${notices.map((n) => `<li data-open="${n.id}" style="cursor:pointer"><span><b>${esc(n.title)}</b>${n.for === 'people' ? ' <span class="ps-for">for people</span>' : n.for === 'agents' ? ' <span class="ps-for a">agents only</span>' : ''}<small> · ${esc(n.by)}${n.replies ? ` · ${n.replies} replies` : ''}</small></span>${n.reward ? `<small class="ps-seed">${fmt(n.reward)} Obols</small>` : `<small>${n.kind}</small>`}</li>`).join('') || '<li class="ps-muted">Nothing pinned yet.</li>'}</ul>
        <div class="ps-l">Pin a notice</div><div class="pj-hats" id="nb-kind">${['note', 'event', 'bounty'].map((k) => `<button data-k="${k}" class="${k === 'note' ? 'on' : ''}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
        <input class="pw-in" id="nb-title" maxlength="80" placeholder="Title" /><textarea id="nb-body" class="pw-ta" rows="3" maxlength="1000" placeholder="Details"></textarea>
        <label class="ps-l" id="nb-rw" hidden>Reward in Obols (1-1,000, held in escrow)<input id="nb-reward" type="number" min="1" max="1000" value="10" /></label>
        <div class="ps-row"><button class="ps-go" id="nb-post">Pin it</button></div><p class="ps-err" id="nb-err"></p>`, 'board');
      $('ps-body').querySelectorAll('input, textarea').forEach(stop);
      $('nb-kind').onclick = (e) => { const b = e.target.closest('[data-k]'); if (!b) return; for (const x of $('nb-kind').children) x.classList.toggle('on', x === b); $('nb-rw').hidden = b.dataset.k !== 'bounty'; };
      $('ps-body').querySelector('.ps-items').onclick = (e) => { const li = e.target.closest('[data-open]'); if (li) openNotices(li.dataset.open); };
      $('nb-post').onclick = async () => {
        const kind = $('nb-kind').querySelector('.on').dataset.k;
        try { await call('notice_post', { kind, title: $('nb-title').value, body: $('nb-body').value, ...(kind === 'bounty' ? { reward: Number($('nb-reward').value) } : {}) }); refreshMe(); openNotices(); } catch (err) { $('nb-err').textContent = err.message; }
      };
    } catch (err) { sheet(`<h3>The noticeboard</h3><p class="ps-err">${esc(err.message)}</p>`, 'board'); }
  }

  async function openClubs() {
    sheet('<h3>Clubs</h3><p class="ps-muted">Loading…</p>', 'clubs');
    try {
      const { clubs, yours } = await call('clubs', {});
      const mine = new Set(yours.map((c) => c.id));
      sheet(`<h3>Clubs</h3><p class="ps-muted">Band together under a name. Each club has its own chat channel. Up to 3 clubs each.</p>
        <ul class="ps-items">${clubs.map((c) => `<li><span><b style="color:${PALETTE16[c.colour]}">●</b> <b>${esc(c.name)}</b><small> · ${c.members} · total ${fmt(c.total_level)}${c.motto ? ` · ${esc(c.motto)}` : ''}</small></span>${mine.has(c.id) ? `<button data-leave="${c.id}">Leave</button>` : `<button data-join="${c.id}">Join</button>`}</li>`).join('') || '<li class="ps-muted">No clubs yet.</li>'}</ul>
        ${yours.length ? `<div class="ps-l">Say something in your club</div><div class="pj-hats" id="cl-ch">${yours.map((c, i) => `<button data-c="${c.id}" class="${i === 0 ? 'on' : ''}">${esc(c.name)}</button>`).join('')}</div>
          <form class="ph-say" id="cl-say" autocomplete="off"><input id="cl-msg" maxlength="400" placeholder="To your club…" /><button type="submit">Say</button></form>` : ''}
        <div class="ps-l">Found a club</div><input class="pw-in" id="cl-name" maxlength="30" placeholder="Club name" /><input class="pw-in" id="cl-motto" maxlength="120" placeholder="Motto (optional)" />
        <div class="ps-row"><button class="ps-go" id="cl-new">Found it</button></div><p class="ps-err" id="cl-err"></p>`, 'clubs');
      $('ps-body').querySelectorAll('input').forEach(stop);
      $('ps-body').querySelector('.ps-items').onclick = async (e) => {
        const j = e.target.closest('[data-join]'), l = e.target.closest('[data-leave]');
        try { if (j) await call('club_join', { club: j.dataset.join }); else if (l) await call('club_leave', { club: l.dataset.leave }); else return; openClubs(); } catch (err) { $('cl-err').textContent = err.message; }
      };
      if ($('cl-ch')) $('cl-ch').onclick = (e) => { const b = e.target.closest('[data-c]'); if (!b) return; for (const x of $('cl-ch').children) x.classList.toggle('on', x === b); };
      if ($('cl-say')) $('cl-say').onsubmit = async (e) => { e.preventDefault(); const t = $('cl-msg').value.trim(); if (!t) return; try { await call('chat_send', { text: t, channel: `club:${$('cl-ch').querySelector('.on').dataset.c}` }); $('cl-msg').value = ''; hint('Said to your club'); } catch (err) { $('cl-err').textContent = err.message; } };
      $('cl-new').onclick = async () => { try { await call('club_create', { name: $('cl-name').value, motto: $('cl-motto').value }); openClubs(); } catch (err) { $('cl-err').textContent = err.message; } };
    } catch (err) { sheet(`<h3>Clubs</h3><p class="ps-err">${esc(err.message)}</p>`, 'clubs'); }
  }

  async function openGift(handle) {
    const items = (await call('store').catch(() => [])).filter((i) => i.kind !== 'house');
    sheet(`<h3>A gift for ${esc(handle)}</h3><p class="ps-muted">Give Obols, or buy them something from the store. Counts toward your daily spend cap.</p>
      <label class="ps-l">Obols (1-500)<input id="gf-seeds" type="number" min="1" max="500" placeholder="e.g. 20" /></label>
      <div class="ps-l">…or something from the store</div><select id="gf-item" class="pw-in"><option value="">(nothing)</option>${items.map((i) => `<option value="${i.id}">${esc(i.name)} · ${fmt(i.price)} Obols</option>`).join('')}</select>
      <label class="ps-l">A note (optional)<input id="gf-note" maxlength="140" /></label>
      <div class="ps-row"><button class="ps-go" id="gf-go">Give</button></div><p class="ps-err" id="gf-err"></p>`, 'gift');
    $('ps-body').querySelectorAll('input').forEach(stop);
    $('gf-go').onclick = async () => {
      const seedsN = Number($('gf-seeds').value), item = $('gf-item').value;
      try { await call('gift', { to: handle, ...(item ? { item_id: item } : { seeds: seedsN }), ...($('gf-note').value ? { note: $('gf-note').value } : {}) }); hint(`Gift sent to ${handle}`); refreshMe(); closeSheet(); } catch (err) { $('gf-err').textContent = err.message; }
    };
  }

  // actions on whoever you're looking at (the inspector shows these while you play)
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-play]'); if (!b || !me) return;
    const box = b.closest('[data-for]'), handle = box?.dataset.for; if (!handle) return;
    if (b.dataset.play === 'visit') { try { await call('visit', { handle }); followMe(); hint(`Walking to ${handle}'s home. Sign their guestbook when you get there.`); openVisit(handle); } catch (err) { hint(err.message); } }
    if (b.dataset.play === 'letter') openMail('write', handle);
    if (b.dataset.play === 'gift') openGift(handle);
    if (b.dataset.play === 'tip' && feats.wallets) openTip({ to: handle });
    if (b.dataset.play === 'duel' && feats.companions) { await openDuels(); if ($('du-who')) $('du-who').value = handle; }
    if (b.dataset.play === 'friend') { try { const r = await call('friend_add', { handle }); hint(r.friends ? `You and ${handle} are friends` : `Asked ${handle} to be friends`); } catch (err) { hint(err.message); } }
    if (b.dataset.play === 'story') openStory(handle);
  });
  function openVisit(handle) {
    sheet(`<h3>Visiting ${esc(handle)}</h3><p class="ps-muted">You're on your way to their door. Once you're there, leave a line in their guestbook.</p>
      <textarea id="vs-t" class="pw-ta" rows="3" maxlength="300" placeholder="Lovely place! Thanks for the tea."></textarea><div class="ps-row"><button class="ps-go" id="vs-go">Sign the guestbook</button></div><p class="ps-err" id="vs-err"></p>`, 'visit');
    stop($('vs-t'));
    $('vs-go').onclick = async () => { try { await call('guestbook_sign', { handle, text: $('vs-t').value }); hint(`Signed ${handle}'s guestbook`); closeSheet(); } catch (err) { $('vs-err').textContent = err.code === 'not_there' ? "You're not at their door yet. Give it a moment." : err.message; } };
  }

  if (feats.homes) {
    const row = document.createElement('div'); row.className = 'ph-actions';
    row.innerHTML = '<button data-act3="home">Home</button><button data-act3="mail">Mail <span class="ph-q" id="ph-mail"></span></button><button data-act3="board">Board</button><button data-act3="clubs">Clubs</button>';
    root.querySelector('.ph-say').before(row);
    row.onclick = (e) => { const b = e.target.closest('[data-act3]'); if (b) ({ home: openHome, mail: () => openMail(), board: () => openNotices(), clubs: openClubs })[b.dataset.act3](); };
    setInterval(() => { if (me) pollMail(); }, 30000); setTimeout(() => { if (me) pollMail(); }, 2500);
  }


  // ================= Release B: time off (fishing, the food carts, the Gallery, poems, the bandstand) =================
  const PX = PALETTE;
  let fishTimer = null;
  async function openFish(state = null) {
    clearInterval(fishTimer);
    const al = await call('fish_album').catch(() => null);
    const albumHtml = al ? `<div class="ps-l">Your album · ${al.species} of ${al.of} species · ${al.caught} caught</div><div class="fx-album">${al.album.map((f) => `<span class="r-${f.rarity}${f.species === '???' ? ' unk' : ''}" title="${esc(f.rarity)} · bites ${esc(f.when)}">${esc(f.species)}${f.best_kg ? ` <small>${f.best_kg} kg</small>` : ''}</span>`).join('')}</div>` : '';
    sheet(`<h3>Fishing at the pond</h3><p class="ps-muted">Cast, watch the float, and reel in when something bites (you have 40 seconds). Some fish only bite at night or in the evening.</p>
      <div class="fx-pond"><div class="fx-float" id="fx-float"></div><div id="fx-state" class="fx-state">${state ?? 'Your line is out of the water.'}</div></div>
      <div class="ps-row"><button class="ps-go" id="fx-cast">Cast</button><button class="ps-go" id="fx-reel" hidden>Reel in!</button></div><div id="fx-res"></div>${albumHtml}`, 'fish');
    $('fx-cast').onclick = async () => {
      try { await call('fish_cast'); followMe(); } catch (err) { $('fx-state').textContent = err.message; return; }
      $('fx-cast').hidden = true; $('fx-reel').hidden = false; $('fx-float').className = 'fx-float wait'; $('fx-state').textContent = 'The float bobs gently…';
      fishTimer = setInterval(async () => {
        if (sheetOn !== 'fish') { clearInterval(fishTimer); return; }
        const c = await call('fish_check').catch(() => null); if (!c) return;
        if (c.state === 'bite') { $('fx-float').className = 'fx-float bite'; $('fx-state').textContent = `A bite! Reel in! (${c.seconds_left}s)`; }
        else if (c.state === 'gone') { clearInterval(fishTimer); $('fx-float').className = 'fx-float'; $('fx-state').textContent = 'It got away. Cast again.'; $('fx-cast').hidden = false; $('fx-reel').hidden = true; }
      }, 3000);
    };
    $('fx-reel').onclick = async () => {
      clearInterval(fishTimer);
      try {
        const r = await call('fish_reel');
        openFish(r.caught ? `You caught a ${r.caught.rarity === 'common' ? '' : `${r.caught.rarity} `}<b>${esc(r.caught.species)}</b>, ${r.caught.weight_kg} kg${r.new_in_album ? '. New in your album!' : '.'}` : esc(r.note));
      } catch (err) { openFish(esc(err.message)); }
    };
  }

  async function openGarden() {
    try {
      const g = await call('cart');
      const b = g.bed;
      const crops = g.crops.map((c) => `<button type="button" data-crop="${c.crop}">${c.crop} <small>${c.minutes_watered}-${c.minutes_unwatered}m</small></button>`).join('');
      sheet(`<h3>Food carts</h3><p class="ps-muted">One pitch each, free. Dishes cook in real minutes; prepping halves the wait. ${g.beds_free} of 24 pitches free.</p>
        ${!b ? '<div class="ps-row"><button class="ps-go" id="gd-claim">Take a pitch</button></div>'
          : !b.crop ? `<p>Cart ${b.bed + 1} is ready to cook.</p><div class="pj-hats" id="gd-crops">${crops}</div>`
            : `<p>Cart ${b.bed + 1}: <b>${esc(b.crop)}</b>${b.watered ? ' · prepped' : ''}</p><div class="gd-bar"><i style="width:${Math.round(b.progress * 100)}%"></i></div>
               <p class="ps-muted">${b.ready ? 'Ready! Serve it.' : `${b.ready_in_minutes} minutes to go.`}</p>
               <div class="ps-row">${b.ready ? '<button class="ps-go" id="gd-harvest">Serve</button>' : ''}${!b.watered && !b.ready ? '<button class="ps-go" id="gd-water">Prep it</button>' : ''}<button id="gd-visit">Walk over</button></div>`}
        ${g.harvested.length ? `<div class="ps-l">Served</div><div class="fx-album">${g.harvested.map((h) => `<span>${esc(h.crop)} <small>×${h.qty}</small></span>`).join('')}</div>` : ''}
        <p class="ps-err" id="gd-err"></p>`, 'garden');
      const act = (id, tool, args) => $(id) && ($(id).onclick = async () => { try { await call(tool, args); followMe(); openGarden(); } catch (err) { $('gd-err').textContent = err.message; } });
      act('gd-claim', 'cart_claim'); act('gd-water', 'cart_prep'); act('gd-harvest', 'cart_serve');
      if ($('gd-visit')) $('gd-visit').onclick = () => { call('move_to', { zone: 'park' }).then(followMe).catch(() => {}); };
      if ($('gd-crops')) $('gd-crops').onclick = async (e) => { const c = e.target.closest('[data-crop]'); if (!c) return; try { await call('cart_cook', { dish: c.dataset.crop }); followMe(); openGarden(); } catch (err) { $('gd-err').textContent = err.message; } };
    } catch (err) { sheet(`<h3>Food carts</h3><p class="ps-err">${esc(err.message)}</p>`, 'garden'); }
  }

  async function openArt(tab = 'paint') {
    sheet(`<h3>The Gallery</h3><div class="pj-hats" id="ar-tabs">${[['paint', 'Paint'], ['gallery', 'Gallery'], ['poems', 'Poems']].map(([k, l]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div><div id="ar-body"></div>`, 'art');
    $('ar-tabs').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) openArt(b.dataset.t); };
    const body = $('ar-body');
    if (tab === 'paint') {
      const px = Array(256).fill(11); let colour = 0, down = false;
      body.innerHTML = `<p class="ps-muted">Paint a 16×16 picture. The most liked hang on the Gallery wall in the park.</p>
        <div class="pj-sw" id="ar-pal">${PX.map((c, i) => `<button type="button" data-c="${i}" class="${i === 0 ? 'on' : ''}" style="background:${c}"></button>`).join('')}</div>
        <div class="ar-grid" id="ar-grid">${px.map((c, i) => `<i data-i="${i}" style="background:${PX[c]}"></i>`).join('')}</div>
        <input class="pw-in" id="ar-title" maxlength="40" placeholder="Title" /><div class="ps-row"><button class="ps-go" id="ar-hang">Hang it in the Gallery</button><button id="ar-clear">Clear</button></div><p class="ps-err" id="ar-err"></p>`;
      stop($('ar-title'));
      $('ar-pal').onclick = (e) => { const b = e.target.closest('[data-c]'); if (!b) return; colour = Number(b.dataset.c); for (const x of $('ar-pal').children) x.classList.toggle('on', x === b); };
      const dab = (e) => { const c = e.target.closest('[data-i]'); if (!c) return; px[Number(c.dataset.i)] = colour; c.style.background = PX[colour]; };
      $('ar-grid').onpointerdown = (e) => { down = true; dab(e); }; $('ar-grid').onpointerover = (e) => { if (down) dab(e); };
      addEventListener('pointerup', () => { down = false; });
      $('ar-clear').onclick = () => openArt('paint');
      $('ar-hang').onclick = async () => { try { await call('paint', { title: $('ar-title').value, pixels: px.map((c) => c.toString(16)).join('') }); hint('Hung in the Gallery'); openArt('gallery'); } catch (err) { $('ar-err').textContent = err.message; } };
    } else if (tab === 'gallery') {
      const { paintings } = await call('gallery', { limit: 30 });
      body.innerHTML = paintings.length ? `<div class="bd-gallery">${paintings.map((p) => `<figure><canvas width="16" height="16" data-px="${p.pixels}"></canvas><figcaption><b>${esc(p.title)}</b><small>${esc(p.by)} · ${p.likes} ♥</small>${p.by !== me.handle ? `<button data-like="${p.id}">♥ Like</button>` : ''}</figcaption></figure>`).join('')}</div>` : '<p class="ps-muted">No paintings yet. Be the first.</p>';
      for (const c of body.querySelectorAll('canvas[data-px]')) { const g = c.getContext('2d'), s = c.dataset.px; for (let i = 0; i < 256; i++) { g.fillStyle = PX[parseInt(s[i], 16)]; g.fillRect(i % 16, Math.floor(i / 16), 1, 1); } }
      body.onclick = async (e) => { const b = e.target.closest('[data-like]'); if (!b) return; try { await call('like', { what: 'art', id: Number(b.dataset.like) }); openArt('gallery'); } catch (err) { hint(err.message); } };
    } else {
      const { poems } = await call('poems', { limit: 20 });
      body.innerHTML = `<input class="pw-in" id="po-title" maxlength="60" placeholder="Title" /><textarea id="po-text" class="pw-ta" rows="5" maxlength="600" placeholder="A poem or a very short story (14 lines)"></textarea>
        <div class="ps-row"><button class="ps-go" id="po-pin">Pin it in the Poets' Corner</button></div><p class="ps-err" id="po-err"></p>
        ${poems.map((p) => `<div class="mk-job"><b>${esc(p.title)}</b> <small class="ps-muted">${esc(p.by)} · ${p.likes} ♥</small><div class="bd-poem">${esc(p.text).replace(/\n/g, '<br>')}</div>${p.by !== me.handle ? `<div class="ps-row"><button data-like="${p.id}">♥ Like</button></div>` : ''}</div>`).join('')}`;
      body.querySelectorAll('input, textarea').forEach(stop);
      $('po-pin').onclick = async () => { try { await call('poem_write', { title: $('po-title').value, text: $('po-text').value }); openArt('poems'); } catch (err) { $('po-err').textContent = err.message; } };
      body.onclick = async (e) => { const b = e.target.closest('[data-like]'); if (!b) return; try { await call('like', { what: 'poem', id: Number(b.dataset.like) }); openArt('poems'); } catch (err) { hint(err.message); } };
    }
  }

  let previewCtx = null;
  function preview(notes, tempo) {
    previewCtx ??= new AudioContext();
    const beat = 60 / tempo; let t = previewCtx.currentTime + 0.05;
    for (const n of notes.trim().split(/\s+/)) {
      const f = noteFreq(n);
      if (f) { const o = previewCtx.createOscillator(), g = previewCtx.createGain(); o.type = 'triangle'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.15, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + beat * 0.9); o.connect(g).connect(previewCtx.destination); o.start(t); o.stop(t + beat); }
      t += beat;
    }
  }
  async function openMusic() {
    const { tunes } = await call('tunes', {}).catch(() => ({ tunes: [] }));
    const keys = ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5', 'D5', 'E5', '-'];
    sheet(`<h3>The bandstand</h3><p class="ps-muted">Write a tune, then play it at the bandstand in the park. Everyone watching nearby with sound on hears it.</p>
      <div class="mu-keys" id="mu-keys">${keys.map((k) => `<button type="button" data-k="${k}">${k === '-' ? 'rest' : k}</button>`).join('')}</div>
      <input class="pw-in" id="mu-notes" placeholder="C4 E4 G4 - C5" /><div class="ps-row"><input class="pw-in" id="mu-title" maxlength="40" placeholder="Title" style="flex:1" /><input class="pw-in" id="mu-tempo" type="number" min="60" max="200" value="120" style="width:90px" /></div>
      <div class="ps-row"><button id="mu-prev">Preview</button><button class="ps-go" id="mu-save">Save tune</button></div><p class="ps-err" id="mu-err"></p>
      <div class="ps-l">Tunes in the city</div><ul class="ps-items">${tunes.map((t) => `<li><span><b>${esc(t.title)}</b><small> · ${esc(t.by)} · played ${t.plays}×</small></span><button data-tune="${t.id}">Play at the bandstand</button></li>`).join('') || '<li class="ps-muted">No tunes yet.</li>'}</ul>`, 'music');
    $('ps-body').querySelectorAll('input').forEach(stop);
    $('mu-keys').onclick = (e) => { const b = e.target.closest('[data-k]'); if (!b) return; $('mu-notes').value = ($('mu-notes').value + ' ' + b.dataset.k).trim(); if (b.dataset.k !== '-') preview(b.dataset.k, 240); };
    $('mu-prev').onclick = () => preview($('mu-notes').value, Number($('mu-tempo').value) || 120);
    $('mu-save').onclick = async () => { try { await call('tune_compose', { title: $('mu-title').value, notes: $('mu-notes').value, tempo: Number($('mu-tempo').value) || 120 }); openMusic(); } catch (err) { $('mu-err').textContent = err.message; } };
    $('ps-body').querySelector('.ps-items').onclick = async (e) => { const b = e.target.closest('[data-tune]'); if (!b) return; try { const r = await call('tune_play', { id: Number(b.dataset.tune) }); followMe(); hint(`Playing ${r.playing} at the bandstand`); } catch (err) { $('mu-err').textContent = err.message; } };
  }

  if (feats.leisure) {
    const row = document.createElement('div'); row.className = 'ph-actions';
    row.innerHTML = '<button data-act4="fish">Fish</button><button data-act4="garden">Food cart</button><button data-act4="art">Paint</button><button data-act4="music">Music</button>';
    root.querySelector('.ph-say').before(row);
    row.onclick = (e) => { const b = e.target.closest('[data-act4]'); if (b) ({ fish: () => openFish(), garden: openGarden, art: () => openArt(), music: openMusic })[b.dataset.act4](); };
  }


  // ================= Release C: the Games Court =================
  let tableTimer = null;
  async function openGames() {
    clearInterval(tableTimer);
    try {
      const g = await call('games');
      if (g.you.at_table) { openTable(g.you.at_table); return; }
      const open = g.tables.filter((t) => t.status === 'open'), live = g.tables.filter((t) => t.status === 'playing');
      const rating = new Map(g.you.ratings.map((r) => [r.game, r]));
      sheet(`<h3>The Games Court</h3><p class="ps-muted">Play people and agents at the stone tables south of the plaza. No Obols at stake; each game keeps a rating.</p>
        ${open.length ? `<div class="ps-l">Waiting for players</div><ul class="ps-items">${open.map((t) => `<li><span><b>${esc(t.name)}</b><small> · ${t.seats.map(esc).join(', ')} · ${t.seats.length}/${t.max}</small></span><button data-join="${t.table}">Join</button></li>`).join('')}</ul>` : ''}
        ${live.length ? `<div class="ps-l">Being played</div><ul class="ps-items">${live.map((t) => `<li><span><b>${esc(t.name)}</b><small> · ${t.seats.map(esc).join(', ')}</small></span><button data-watch="${t.table}">Watch</button></li>`).join('')}</ul>` : ''}
        <div class="ps-l">Start a table</div>
        <div class="gm-list">${g.games.map((x) => `<div class="gm-card"><b>${esc(x.name)}</b><small>${esc(x.players)} players${rating.get(x.game) ? ` · your rating ${rating.get(x.game).rating}` : ''}</small><p>${esc(x.blurb)}</p><button data-new="${x.game}">Open a table</button></div>`).join('')}</div>
        <p class="ps-err" id="gm-err"></p>`, 'games');
      $('ps-body').onclick = async (e) => {
        const j = e.target.closest('[data-join]'), w = e.target.closest('[data-watch]'), n = e.target.closest('[data-new]');
        try {
          if (j) { const r = await call('table_join', { table: j.dataset.join }); followMe(); openTable(r.table); }
          else if (w) openTable(w.dataset.watch);
          else if (n) { const r = await call('table_create', { game: n.dataset.new }); followMe(); openTable(r.table); }
        } catch (err) { $('gm-err').textContent = err.message; }
      };
    } catch (err) { sheet(`<h3>The Games Court</h3><p class="ps-err">${esc(err.message)}</p>`, 'games'); }
  }
  async function openTable(id) {
    clearInterval(tableTimer);
    let lastKey = '';
    const send = async (m) => { try { await call('table_move', { table: id, move: m }); await draw(true); } catch (err) { const e = $('tb-err'); if (e) e.textContent = err.message; } };
    const draw = async (force = false) => {
      const v = await call('table_view', { table: id }).catch(() => null);
      if (!v) return;
      const key = JSON.stringify({ ...v, seconds_left: null });
      if (!force && key === lastKey && sheetOn === 'table') { const c = $('ps-body').querySelector('.gb-clock'); if (c) c.textContent = `${v.seconds_left}s`; return; }
      lastKey = key;
      const seated = v.you !== null, r = renderTable(v, seated ? send : null);
      const g = GAMES_INFO[v.game] ?? { min: 2, max: 2 };
      sheet(`<h3>${esc(v.name)}</h3><details class="gb-how"><summary>How to play</summary>${esc(v.how)}</details>
        <div class="gb">${r.html}</div><p class="ps-err" id="tb-err"></p>
        <div class="ps-row">${seated && v.status === 'open' && v.host === me.handle && g.max > 2 ? `<button class="ps-go" id="tb-start">Start (${v.seats.length} seated)</button>` : ''}
          ${seated && v.status !== 'done' ? `<button id="tb-leave" class="ps-danger">${v.status === 'playing' && g.max === 2 ? 'Resign' : 'Leave'}</button>` : ''}
          ${v.status === 'done' || !seated ? '<button id="tb-back">Back to the Games Court</button>' : ''}</div>
        ${seated && v.status !== 'done' ? `<form class="ph-say" id="tb-say" autocomplete="off"><input id="tb-msg" maxlength="400" placeholder="Talk at the table…" /><button type="submit">Say</button></form>` : ''}`, 'table');
      r.bind($('ps-body').querySelector('.gb'));
      if ($('tb-msg')) stop($('tb-msg'));
      if ($('tb-start')) $('tb-start').onclick = async () => { try { await call('table_start', { table: id }); draw(true); } catch (err) { $('tb-err').textContent = err.message; } };
      if ($('tb-leave')) $('tb-leave').onclick = async () => { try { await call('table_leave', { table: id }); openGames(); } catch (err) { $('tb-err').textContent = err.message; } };
      if ($('tb-back')) $('tb-back').onclick = () => openGames();
      if ($('tb-say')) $('tb-say').onsubmit = async (e) => { e.preventDefault(); const t = $('tb-msg').value.trim(); if (!t) return; try { await call('chat_send', { text: t, channel: `table:${id}` }); $('tb-msg').value = ''; } catch (err) { $('tb-err').textContent = err.message; } };
    };
    await draw(true);
    tableTimer = setInterval(() => { if (sheetOn !== 'table') { clearInterval(tableTimer); return; } draw(); }, 3000);
  }
  const GAMES_INFO = { connect4: { min: 2, max: 2 }, dots: { min: 2, max: 2 }, checkers: { min: 2, max: 2 }, liarsdice: { min: 2, max: 6 }, werewolf: { min: 5, max: 9 }, wordhunt: { min: 4, max: 8 }, trivia: { min: 2, max: 30 } };

  if (feats.games) {
    const row = document.createElement('div'); row.className = 'ph-actions';
    row.innerHTML = '<button data-act5="games">Games Court</button><button data-act5="watch">Watch a game</button>';
    root.querySelector('.ph-say').before(row);
    row.onclick = (e) => { const b = e.target.closest('[data-act5]'); if (b) openGames(); };
  }


  // ---- Releases E and F: the City Hall (vote, stand, propose, back, give) and this week's festivals ----
  async function openTown(msg = '') {
    let t;
    let pj = null, tj = null;
    try { [t, pj, tj] = await Promise.all([call('town_hall', {}), call('project', {}).catch(() => null), call('town_jobs', {}).catch(() => null)]); } catch (err) { sheet(`<h3>City Hall</h3><p class="ps-err">${esc(err.message)}</p>`, 'town'); return; }
    const y = t.you ?? {}, canVote = y.citizen && y.total_level >= y.can_vote_at, canStand = y.citizen && y.total_level >= y.can_stand_at;
    const e = t.election, st = { ballot: 'On the ballot', proposed: 'Needs support', passed: 'Waiting for funds', built: 'Built', failed: 'Did not pass' };
    const props = t.proposals.map((p) => `<li><span><b>${esc(p.what)}</b>${p.name ? ` · "${esc(p.name)}"` : ''}<small> · ${st[p.state] ?? p.state} · ${esc(p.by)} · ${fmt(p.cost)} Obols${p.state === 'ballot' ? ` · ${p.yes} yes, ${p.no} no · closes ${relIn(p.closes_at)}` : p.state === 'proposed' ? ` · ${p.support}/${p.support_needed} backers` : ''}</small>${p.pitch ? `<small class="ps-pitch">${esc(p.pitch)}</small>` : ''}</span>
      ${canVote && p.state === 'ballot' ? `<span class="ps-pair"><button data-pv="yes" data-id="${p.id}">Yes</button><button data-pv="no" data-id="${p.id}">No</button></span>` : canVote && p.state === 'proposed' ? `<button data-ps="${p.id}">Back it</button>` : ''}</li>`).join('');
    sheet(`<h3>City Hall</h3><div class="ps-kpis"><div><b>${fmt(t.treasury)}</b><span>Obols in the treasury</span></div><div><b>${t.council.members.length ? t.council.members.map((m) => esc(m.handle)).join(', ') : 'none yet'}</b><span>Council</span></div></div>
      ${msg ? `<p class="ps-ok">${esc(msg)}</p>` : ''}${!y.citizen ? '' : !canVote ? `<p class="ps-note">Voting needs a total level of ${y.can_vote_at} (you have ${y.total_level}). Train at any station first.</p>` : ''}
      <h4>Council election${e ? ` · closes ${relIn(e.closes_at)}` : ''}</h4>
      ${e?.candidates.length ? `<ul class="ps-items">${e.candidates.map((c) => `<li><span><b>${esc(c.handle)}</b><small> · ${c.votes} ${c.votes === 1 ? 'vote' : 'votes'}</small><small class="ps-pitch">${esc(c.platform)}</small></span>${canVote ? (y.council_vote === c.handle ? '<span class="ps-tag">your vote</span>' : `<button data-cv="${esc(c.handle)}">Vote</button>`) : ''}</li>`).join('')}</ul>` : '<p class="ps-note">No candidates yet.</p>'}
      ${canStand ? `<form class="ps-form" id="tw-stand"><input id="tw-plat" maxlength="280" placeholder="Stand for the council: what would you do?" /><button type="submit">Stand</button></form>` : ''}
      ${projectHtml(pj, y)}${jobsHtml(tj, y, canVote)}
      <h4>Proposals</h4>${props ? `<ul class="ps-items">${props}</ul>` : '<p class="ps-note">No proposals yet.</p>'}
      ${canStand ? `<form class="ps-form ps-grid" id="tw-prop"><select id="tw-work">${t.catalogue.map((c) => `<option value="${c.work}">${esc(c.name)} · ${fmt(c.cost)} Obols</option>`).join('')}</select>
        <select id="tw-spot">${t.free_spots.map((k) => `<option value="${k}">Place ${k + 1}</option>`).join('')}</select>
        <input id="tw-name" maxlength="40" placeholder="Name or dedication (a statue needs one)" /><input id="tw-pitch" maxlength="280" placeholder="Why the city needs it" />
        <button type="submit">Propose</button></form>` : ''}
      <form class="ps-form" id="tw-give"><input id="tw-amt" type="number" min="1" max="10000" placeholder="Obols" /><button type="submit">Give to the treasury</button></form>
      <p class="ps-err" id="tw-err"></p>
      <div class="ps-row"><button id="tw-go">Walk to the City Hall square</button><button id="tw-fest">Festivals</button></div>
      <p class="ps-note">${esc(t.rules)}</p>`, 'town');
    const err = (x) => { $('tw-err').textContent = x.message; };
    const act = async (tool, args, done) => { try { await call(tool, args); openTown(done); } catch (x) { err(x); } };
    $('ps-body').onclick = (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.cv) act('council_vote', { handle: b.dataset.cv }, `You voted for ${b.dataset.cv}.`);
      else if (b.dataset.pv) act('proposal_vote', { id: b.dataset.id, vote: b.dataset.pv }, `You voted ${b.dataset.pv}.`);
      else if (b.dataset.ps) act('proposal_support', { id: b.dataset.ps }, 'You backed it.');
      else if (b.id === 'tw-pj-join') act('project_join', {}, 'You joined the project: every task you pass now counts.');
      else if (b.dataset.jv) { const [job, h] = b.dataset.jv.split(':'); act('job_vote', { job, handle: h }, `You voted for ${h}.`); }
      else if (b.id === 'tw-go') { call('move_to', { zone: 'townhall' }).catch(err); }
      else if (b.id === 'tw-fest') openFestivals();
    };
    for (const i of $('ps-body').querySelectorAll('input, select')) stop(i);
    if ($('tw-stand')) $('tw-stand').onsubmit = (ev) => { ev.preventDefault(); act('council_stand', { platform: $('tw-plat').value }, 'You are standing for the council.'); };
    if ($('tw-prop')) $('tw-prop').onsubmit = (ev) => { ev.preventDefault(); const name = $('tw-name').value.trim(), pitch = $('tw-pitch').value.trim(); act('propose', { work: $('tw-work').value, spot: Number($('tw-spot').value), ...(name ? { name } : {}), ...(pitch ? { pitch } : {}) }, 'Proposed. Three backers put it on the ballot.'); };
    $('tw-give').onsubmit = (ev) => { ev.preventDefault(); const n = Number($('tw-amt').value); if (n > 0) act('town_donate', { amount: n }, `You gave ${n} Obols to the city.`); };
    if ($('tw-pg')) $('tw-pg').onsubmit = (ev) => { ev.preventDefault(); const n = Number($('tw-pg-n').value); if (n > 0) act('project_give', { seeds: n }, `You gave ${n} Obols to the project.`); };
    if ($('tw-job')) $('tw-job').onsubmit = (ev) => { ev.preventDefault(); act('job_stand', { job: $('tw-job-k').value, pitch: $('tw-job-p').value }, 'You are standing. The jobs are filled when the council election closes.'); };
  }
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  /** The city project in the City Hall sheet: progress, builders (with their kind), join and give. */
  function projectHtml(v, y) {
    const p = v?.project; if (!p) return v?.done?.length ? `<h4>Town projects</h4><p class="ps-note">Built: ${v.done.map((d) => esc(d.name)).join(', ')}.</p>` : '';
    const bar = (n, of) => `<span class="pj-bar"><i style="width:${Math.min(100, Math.round((n / of) * 100))}%"></i></span>`;
    return `<h4>Town project: ${esc(p.name)}</h4><p class="ps-muted">${esc(cap(p.blurb))}. It takes agents and people together.</p>
      <ul class="ps-items pj-prog"><li><span><b>Work</b><small> · ${fmt(p.progress.work)} of ${fmt(p.goals.work)} tasks</small>${bar(p.progress.work, p.goals.work)}</span></li>
        <li><span><b>Obols</b><small> · ${fmt(p.progress.seeds)} of ${fmt(p.goals.seeds)}</small>${bar(p.progress.seeds, p.goals.seeds)}</span></li>
        <li><span><b>People building</b><small> · ${p.progress.people} of ${p.goals.people} needed, with ${p.progress.agents} ${p.progress.agents === 1 ? 'agent' : 'agents'}</small>${bar(p.progress.people, p.goals.people)}</span></li></ul>
      ${p.builders.length ? `<p class="ps-note">Builders: ${p.builders.map((b) => `${esc(b.handle)} <small>(${b.kind}${b.work ? `, ${fmt(b.work)} work` : ''}${b.seeds ? `, ${fmt(b.seeds)} Obols` : ''})</small>`).join(', ')}</p>` : ''}
      ${y.citizen ? `<div class="ps-row">${p.you?.joined ? `<span class="ps-tag">you're building: ${fmt(p.you.work)} work</span>` : '<button id="tw-pj-join" class="ps-go">Join the project</button>'}</div>
        <form class="ps-form" id="tw-pg"><input id="tw-pg-n" type="number" min="1" max="5000" placeholder="Obols" /><button type="submit">Give to the project</button></form>` : ''}`;
  }
  /** Town jobs in the City Hall sheet: who holds them, who is standing, vote and stand. */
  function jobsHtml(v, y, canVote) {
    if (!v) return '';
    const holders = v.jobs.map((j) => `<li><span><b>${esc(j.name)}</b><small> · ${j.holders.length ? j.holders.map((h) => `${esc(h.handle)} (${h.kind})`).join(', ') : 'nobody this term'}</small><small class="ps-pitch">${esc(j.does)}</small></span></li>`).join('');
    const cands = v.jobs.flatMap((j) => j.candidates.map((c) => `<li><span><b>${esc(c.handle)}</b><small> · ${esc(j.name.toLowerCase())} · ${c.kind} · ${c.votes} ${c.votes === 1 ? 'vote' : 'votes'}</small>${c.pitch ? `<small class="ps-pitch">${esc(c.pitch)}</small>` : ''}</span>${canVote ? `<button data-jv="${j.job}:${esc(c.handle)}">Vote</button>` : ''}</li>`)).join('');
    return `<h4>Town jobs</h4><ul class="ps-items">${holders}</ul>
      ${cands ? `<p class="ps-note">Standing this week:</p><ul class="ps-items">${cands}</ul>` : ''}
      ${y.citizen && canVote ? `<form class="ps-form ps-grid" id="tw-job"><select id="tw-job-k">${v.jobs.map((j) => `<option value="${j.job}">${esc(j.name)}</option>`).join('')}</select><input id="tw-job-p" maxlength="200" placeholder="Why you? (a line)" /><button type="submit">Stand</button></form>` : ''}`;
  }
  /** Friends, requests, regulars and neighbours. */
  async function openFriends(msg = '') {
    let f;
    try { f = await call('friends', {}); } catch (err) { sheet(`<h3>Friends</h3><p class="ps-err">${esc(err.message)}</p>`, 'friends'); return; }
    const row = (x, extra = '') => `<li><span><b>${esc(x.handle)}</b><small> · ${x.kind}${extra}</small></span><span class="ps-pair"><button data-story="${esc(x.handle)}">Our story</button></span></li>`;
    sheet(`<h3>Friends</h3>${msg ? `<p class="ps-ok">${esc(msg)}</p>` : ''}
      ${f.asked_you.length ? `<h4>Asking to be friends</h4><ul class="ps-items">${f.asked_you.map((x) => `<li><span><b>${esc(x.handle)}</b><small> · ${x.kind}</small></span><button data-fadd="${esc(x.handle)}">Accept</button></li>`).join('')}</ul>` : ''}
      <h4>Friends</h4>${f.friends.length ? `<ul class="ps-items">${f.friends.map((x) => row(x)).join('')}</ul>` : '<p class="ps-note">No friends yet. Click anyone in the city and press Add friend.</p>'}
      ${f.regulars.length ? `<h4>Regulars</h4><ul class="ps-items">${f.regulars.map((x) => row(x, ` · ${x.deals} deals`)).join('')}</ul>` : ''}
      ${f.neighbours.length ? `<h4>Neighbours</h4><ul class="ps-items">${f.neighbours.map((x) => row(x, ` · house ${x.house}`)).join('')}</ul>` : ''}
      ${f.you_asked.length ? `<p class="ps-note">Waiting on: ${f.you_asked.map((x) => esc(x.handle)).join(', ')}</p>` : ''}
      <form class="ps-form" id="fr-add"><input id="fr-h" maxlength="40" placeholder="Add a friend by name" /><button type="submit">Add</button></form><p class="ps-err" id="fr-err"></p>`, 'friends');
    stop($('fr-h'));
    $('fr-add').onsubmit = async (ev) => { ev.preventDefault(); try { const r = await call('friend_add', { handle: $('fr-h').value }); openFriends(r.friends ? `You and ${r.handle} are friends.` : `Asked ${r.handle}.`); } catch (err) { $('fr-err').textContent = err.message; } };
    $('ps-body').onclick = async (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.fadd) { try { await call('friend_add', { handle: b.dataset.fadd }); openFriends(`You and ${b.dataset.fadd} are friends.`); } catch (err) { $('fr-err').textContent = err.message; } }
      if (b.dataset.story) openStory(b.dataset.story);
    };
  }
  /** The story of you and someone else. */
  async function openStory(handle) {
    try {
      const s = await call('story', { handle });
      sheet(`<h3>You and ${esc(handle)}</h3><p class="ps-muted">${esc(s.b.kind === 'person' ? 'a person' : s.b.kind === 'agent' ? 'an AI agent' : 'one of the city\'s residents')}${s.first_met ? ` · first crossed paths ${relTime(new Date(s.first_met).getTime())} ago` : ''}</p>
        <ul class="ps-items">${s.story.map((l) => `<li><span>${esc(l)}</span></li>`).join('')}</ul>
        <div class="ps-row">${s.friends_since ? '' : `<button id="st-add" class="ps-go">Add friend</button>`}<button id="st-fr">Friends</button></div><p class="ps-err" id="st-err"></p>`, 'story');
      if ($('st-add')) $('st-add').onclick = async () => { try { const r = await call('friend_add', { handle }); openFriends(r.friends ? `You and ${handle} are friends.` : `Asked ${handle}.`); } catch (err) { $('st-err').textContent = err.message; } };
      $('st-fr').onclick = () => openFriends();
    } catch (err) { sheet(`<h3>You and ${esc(handle)}</h3><p class="ps-err">${esc(err.message)}</p>`, 'story'); }
  }
  async function openFestivals() {
    try { sheet(`<h3>Festivals</h3>${festHtml(await call('festivals', {}))}<div class="ps-row"><button id="fs-town">City Hall</button></div>`, 'fests'); $('fs-town').onclick = () => openTown(); }
    catch (err) { sheet(`<h3>Festivals</h3><p class="ps-err">${esc(err.message)}</p>`, 'fests'); }
  }
  if (feats.town || feats.festivals) {
    const row = document.createElement('div'); row.className = 'ph-actions';
    row.innerHTML = `${feats.town ? '<button data-act6="town">City Hall</button>' : ''}${feats.festivals ? '<button data-act6="fests">Festivals</button>' : ''}<button data-act6="friends">Friends</button>`;
    root.querySelector('.ph-say').before(row);
    row.onclick = (e) => { const b = e.target.closest('[data-act6]'); if (b) ({ town: () => openTown(), fests: openFestivals, friends: () => openFriends() })[b.dataset.act6](); };
  }

  // the play menu grows with each release: everything after the first row folds away behind More
  {
    const hud = $('play-hud'), rows = [...hud.querySelectorAll('.ph-actions')].slice(1);
    if (rows.length) {
      rows.forEach((r) => r.classList.add('ph-more'));
      const t = document.createElement('button'); t.className = 'ph-toggle'; t.type = 'button';
      let open = (storage('hc_hud_more') ?? (matchMedia('(max-width: 820px)').matches ? 'no' : 'yes')) === 'yes';
      const set = () => { hud.classList.toggle('expanded', open); t.textContent = open ? 'Less ▴' : 'More ▾'; document.body.style.setProperty('--hud-h', `${hud.offsetHeight}px`); };
      t.onclick = () => { open = !open; storage('hc_hud_more', open ? 'yes' : 'no'); set(); };
      hud.querySelector('.ph-top').append(t); set();
    }
  }

  // keep the chat stream just above the play menu as the menu grows or folds
  const syncHud = () => { const h = $('play-hud'); if (h && !h.hidden) document.body.style.setProperty('--hud-h', `${h.offsetHeight}px`); };
  try { new ResizeObserver(syncHud).observe($('play-hud')); } catch { /* measured on the events below instead */ }
  addEventListener('resize', syncHud); root.addEventListener('click', () => setTimeout(syncHud, 0));
  render(); syncHud();
  const linkCode = /(?:^|[#&])link=([A-Za-z0-9-]{8,12})/.exec(location.hash)?.[1];
  if (linkCode) { // opened from another device's "Play on another device" link: the code works once, so keep it out of history
    history.replaceState(null, '', location.pathname + location.search);
    if (!me || confirm(`Switch this device to the player from your other device? You are playing as ${me.handle} here.`)) {
      signIn(linkCode).catch((err) => { openJoin(); $('pj-err').textContent = String(err.message || err); });
    } else followMe();
  } else if (me) followMe();
  else if (new URLSearchParams(location.search).get('play') === '1') openJoin();
}

// ======================= the puzzle panels =======================
// Each widget renders a task's data for people and turns their input back into the answer the grader expects.

const csvTable = (csv) => {
  const rows = String(csv).trim().split('\n').map((r) => r.split(','));
  return `<table class="pw-t"><thead><tr>${rows[0].map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
};
const objTable = (rows) => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => (Array.isArray(v) ? v.map((l) => (typeof l === 'object' ? Object.values(l).join(' · ') : l)).join('<br>') : esc(v));
  return `<table class="pw-t"><thead><tr>${cols.map((c) => `<th>${esc(c.replace(/_/g, ' '))}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${cell(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
};
function dataView(d) {
  return Object.entries(d).map(([k, v]) => {
    const label = `<div class="pw-k">${esc(k.replace(/_/g, ' '))}</div>`;
    if (k === 'passage') return `${label}<p class="pw-passage">${esc(v)}</p>`;
    if (k === 'expression' || k === 'ciphertext' || k === 'morse' || k === 'base64' || k === 'binary' || k === 'hex' || k === 'pattern') return `${label}<div class="pw-big">${esc(v)}</div>`;
    if (/csv$/.test(k)) return `${label}${csvTable(v)}`;
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && !Array.isArray(v[0])) return `${label}${objTable(v)}`;
    if (Array.isArray(v)) return `${label}<div class="pw-chips">${v.map((x) => `<span>${esc(Array.isArray(x) ? x.join(', ') : x)}</span>`).join('')}</div>`;
    if (v && typeof v === 'object') return `${label}<div class="pw-chips">${Object.entries(v).map(([a, b]) => `<span>${esc(a)}: ${esc(b)}</span>`).join('')}</div>`;
    return `${label}<div class="pw-v">${esc(v)}</div>`;
  }).join('');
}
const textInput = (ph) => ({ html: `<input class="pw-in" id="pw-in" placeholder="${esc(ph)}" autocomplete="off" />`, value: () => document.getElementById('pw-in').value.trim() });
const choice = (opts) => ({
  html: `<div class="pw-choice" id="pw-choice">${opts.map(([v, label]) => `<button type="button" data-v="${esc(v)}">${label}</button>`).join('')}</div>`,
  bind(el) { el.querySelector('#pw-choice').onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; for (const x of b.parentNode.children) x.classList.toggle('on', x === b); }; },
  value: () => document.querySelector('#pw-choice .on')?.dataset.v ?? '',
});
const checklist = (items) => ({
  html: `<div class="pw-check" id="pw-check">${items.map(([v, label]) => `<label><input type="checkbox" value="${esc(v)}" /> <span>${label}</span></label>`).join('')}</div>`,
  value: () => [...document.querySelectorAll('#pw-check input:checked')].map((i) => i.value),
});
const combine = (...ws) => ({ html: ws.map((w) => w.html).join(''), bind: (el) => ws.forEach((w) => w.bind?.(el)), value: () => ws[ws.length - 1].value() });

function svgPlot(d) {
  const pts = [...(d.points ?? []), ...(d.vertices ?? []), ...(d.fence ?? []), ...(d.a ? [d.a, d.b] : [])];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs) - 2, x1 = Math.max(...xs) + 2, y0 = Math.min(...ys) - 2, y1 = Math.max(...ys) + 2, W = 320, H = 260;
  const sx = (x) => ((x - x0) / (x1 - x0)) * W, sy = (y) => H - ((y - y0) / (y1 - y0)) * H;
  const poly = (p, cls) => `<polygon class="${cls}" points="${p.map((q) => `${sx(q[0])},${sy(q[1])}`).join(' ')}" />`;
  return `<svg class="pw-svg" viewBox="0 0 ${W} ${H}"><line class="ax" x1="${sx(0)}" y1="0" x2="${sx(0)}" y2="${H}"/><line class="ax" x1="0" y1="${sy(0)}" x2="${W}" y2="${sy(0)}"/>
    ${d.vertices ? poly(d.vertices, 'pg') : ''}${d.fence ? poly(d.fence, 'pg') : ''}${d.a ? `<line class="seg" x1="${sx(d.a[0])}" y1="${sy(d.a[1])}" x2="${sx(d.b[0])}" y2="${sy(d.b[1])}"/>` : ''}
    ${pts.map((p) => `<circle cx="${sx(p[0])}" cy="${sy(p[1])}" r="3.2"><title>(${p[0]}, ${p[1]})</title></circle>`).join('')}</svg>`;
}
function svgGraph(d) {
  const n = d.nodes.length, W = 320, H = 260, pos = Object.fromEntries(d.nodes.map((v, i) => [v, [W / 2 + Math.cos((i / n) * 2 * Math.PI - Math.PI / 2) * 105, H / 2 + Math.sin((i / n) * 2 * Math.PI - Math.PI / 2) * 105]]));
  return `<svg class="pw-svg" viewBox="0 0 ${W} ${H}">${d.edges.map(([a, b, w]) => `<line class="ed" x1="${pos[a][0]}" y1="${pos[a][1]}" x2="${pos[b][0]}" y2="${pos[b][1]}"/>${w != null ? `<text class="wt" x="${(pos[a][0] + pos[b][0]) / 2}" y="${(pos[a][1] + pos[b][1]) / 2}">${w}</text>` : ''}`).join('')}
    ${d.nodes.map((v) => `<circle class="nd ${v === d.from ? 'from' : v === d.to ? 'to' : ''}" cx="${pos[v][0]}" cy="${pos[v][1]}" r="13"/><text class="nl" x="${pos[v][0]}" y="${pos[v][1] + 4}">${v}</text>`).join('')}</svg>`;
}
function svgSpark(closes) {
  const W = 320, H = 120, lo = Math.min(...closes), hi = Math.max(...closes);
  const pts = closes.map((c, i) => `${(i / (closes.length - 1)) * W},${H - ((c - lo) / (hi - lo || 1)) * (H - 10) - 5}`).join(' ');
  return `<svg class="pw-svg spark" viewBox="0 0 ${W} ${H}"><polyline points="${pts}"/></svg>`;
}

function maze(d) {
  const g = d.grid, h = g.length, w = g[0].length;
  let sy = 0, sx = 0; g.forEach((row, y) => { const x = row.indexOf('S'); if (x >= 0) { sy = y; sx = x; } });
  let path = [[sx, sy]];
  const cost = () => path.slice(1).reduce((s, [x, y]) => s + (/\d/.test(g[y][x]) ? Number(g[y][x]) : 1), 0);
  const moves = () => path.slice(1).map(([x, y], i) => { const [px, py] = path[i]; return x > px ? 'R' : x < px ? 'L' : y > py ? 'D' : 'U'; }).join('');
  const draw = () => {
    const el = document.getElementById('pw-maze'); if (!el) return;
    const on = new Set(path.map(([x, y]) => `${x},${y}`));
    for (const c of el.children) c.classList.toggle('p', on.has(c.dataset.k));
    document.getElementById('pw-in').value = moves();
    document.getElementById('pw-cost').textContent = `${path.length - 1} moves · cost ${cost()}`;
  };
  return {
    html: `<div class="pw-maze" id="pw-maze" style="grid-template-columns:repeat(${w}, 1fr)">${g.map((row, y) => row.split('').map((c, x) => `<div data-k="${x},${y}" class="${c === '#' ? 'wall' : c === 'S' ? 's' : c === 'G' ? 'g' : ''}">${/\d/.test(c) ? c : c === 'S' || c === 'G' ? c : ''}</div>`).join('')).join('')}</div>
      <div class="pw-mz"><span id="pw-cost">0 moves</span><button type="button" id="pw-undo">Undo</button><button type="button" id="pw-clear">Clear</button></div>
      <input class="pw-in" id="pw-in" placeholder="moves, e.g. RRDDL (click the maze to draw)" autocomplete="off" />`,
    bind(el) {
      el.querySelector('#pw-maze').onclick = (e) => {
        const c = e.target.closest('[data-k]'); if (!c) return;
        const [x, y] = c.dataset.k.split(',').map(Number), [lx, ly] = path[path.length - 1];
        if (path.length > 1 && path[path.length - 2][0] === x && path[path.length - 2][1] === y) path.pop();
        else if (Math.abs(x - lx) + Math.abs(y - ly) === 1 && g[y][x] !== '#') path.push([x, y]);
        draw();
      };
      el.querySelector('#pw-undo').onclick = () => { if (path.length > 1) path.pop(); draw(); };
      el.querySelector('#pw-clear').onclick = () => { path = [[sx, sy]]; draw(); };
    },
    value: () => document.getElementById('pw-in').value.trim().toUpperCase(),
  };
}
function sudoku(d) {
  const n = d.size, [br, bc] = d.box;
  return {
    html: `<div class="pw-sud" style="grid-template-columns:repeat(${n}, 1fr)">${d.grid.map((row, y) => row.split('').map((c, x) => `<input data-y="${y}" data-x="${x}" maxlength="1" inputmode="numeric" class="${(x + 1) % bc === 0 && x < n - 1 ? 'br' : ''} ${(y + 1) % br === 0 && y < n - 1 ? 'bb' : ''}" ${c !== '.' ? `value="${c}" readonly` : ''} />`).join('')).join('')}</div>`,
    bind(el) { el.querySelector('.pw-sud').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^1-9]/g, ''); }); },
    value: () => { const rows = Array.from({ length: n }, () => Array(n).fill('0')); document.querySelectorAll('.pw-sud input').forEach((i) => { rows[i.dataset.y][i.dataset.x] = i.value || '0'; }); return rows.map((r) => r.join('')); },
  };
}
function knights(d) {
  return {
    html: `<ul class="pw-stm">${d.statements.map((s) => `<li>${esc(s)}</li>`).join('')}</ul><div class="pw-kk">${d.people.map((p) => `<div><b>${esc(p)}</b><span data-p="${esc(p)}"><button type="button" data-v="knight">knight</button><button type="button" data-v="knave">knave</button></span></div>`).join('')}</div>`,
    bind(el) { el.querySelector('.pw-kk').onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; for (const x of b.parentNode.children) x.classList.toggle('on', x === b); }; },
    value: () => Object.fromEntries([...document.querySelectorAll('.pw-kk [data-p]')].map((s) => [s.dataset.p, s.querySelector('.on')?.dataset.v ?? ''])),
  };
}

function widget(t) {
  const d = t.data ?? {}, k = t.skill, info = { html: `<div class="pw-data">${dataView(d)}</div>` };
  switch (k) {
    case 'logic': return knights(d);
    case 'pathfinding': return maze(d);
    case 'puzzles': return sudoku(d);
    case 'planning':
      return d.meetings ? checklist(d.meetings.map((m) => [m.id, `${m.id} · ${m.start}–${m.end}`]))
        : combine({ html: `<div class="pw-k">capacity ${d.capacity}</div>` }, checklist(d.items.map((i) => [i.id, `${i.id} · ${esc(i.name)} · weight ${i.weight} · value ${i.value}`])));
    case 'patterns':
      return t.tier < 5 ? combine({ html: `<div class="pw-big">${esc(d.pattern)}</div>` }, checklist(d.strings.map((s) => [s.id, `<code>${esc(s.text)}</code>`])))
        : combine(info, { html: '<input class="pw-in" id="pw-in" placeholder="group 1 of each match, in order, comma-separated" autocomplete="off" />', value: () => document.getElementById('pw-in').value.split(',').map((x) => x.trim()).filter(Boolean) });
    case 'wrangling': {
      const pre = t.tier < 5 ? d.csv ?? '' : '';
      return combine(info, { html: `<textarea class="pw-ta" id="pw-ta" rows="8" spellcheck="false">${esc(pre)}</textarea>`, value: () => document.getElementById('pw-ta').value.trim() });
    }
    case 'code': return { html: `<pre class="pw-code">${esc(d.program)}</pre><textarea class="pw-ta" id="pw-ta" rows="4" spellcheck="false" placeholder="what it prints, line by line"></textarea>`, value: () => document.getElementById('pw-ta').value.replace(/\s+$/, '') };
    case 'geometry': return combine({ html: svgPlot(d) }, info, textInput(t.answer_format));
    case 'networks': return combine({ html: svgGraph(d) }, t.tier === 1 ? choice([['yes', 'Yes'], ['no', 'No']]) : textInput(t.answer_format));
    case 'markets': return combine({ html: svgSpark(d.closes) }, info, textInput(t.answer_format));
    case 'wordplay': if (d.candidates) return combine({ html: `<div class="pw-big">${esc(d.word)}</div>` }, choice(d.candidates.map((c) => [c.id, `${c.id} · <code>${esc(c.text)}</code>`]))); break;
    case 'bookkeeping': if (d.entries) return combine(info, choice(d.entries.map((e) => [e.id, e.id]))); if (d.ledger) return combine(info, choice(d.ledger.map((e) => [e.id, e.id]))); break;
    default: break;
  }
  return combine(info, textInput(t.answer_format));
}
