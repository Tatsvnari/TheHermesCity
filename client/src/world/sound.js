// The bandstand, heard in the browser (Release B). Sound stays off until the viewer turns it on (browsers require a
// click before any audio anyway); tunes are quieter the further the camera is from the bandstand.
import { storage } from '../shared/common.js';
import { PARK } from './layout.js';

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function freq(note) {
  const m = /^([A-G])(#|b)?([2-6])$/.exec(note);
  if (!m) return null;
  const midi = 12 * (Number(m[3]) + 1) + PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function initSound(view, controls) {
  let ctx = null, on = storage('hc_sound') === 'on';
  const btn = document.createElement('button'); btn.id = 'btn-sound'; btn.title = 'Hear the bandstand';
  const render = () => { btn.innerHTML = `<span>${on ? '♪ Sound on' : '♪ Sound off'}</span>`; btn.setAttribute('aria-pressed', String(on)); };
  btn.onclick = () => { on = !on; storage('hc_sound', on ? 'on' : 'off'); if (on) { ctx ??= new AudioContext(); ctx.resume?.(); } render(); };
  controls.insertBefore(btn, controls.querySelector('#btn-quality'));
  render();
  return {
    play(m) {
      if (!on) return;
      ctx ??= new AudioContext();
      const t0 = view.controls.target, d = Math.hypot(t0.x - PARK.bandstand.x, t0.z - PARK.bandstand.z);
      const vol = Math.max(0.12, Math.min(1, 1 - d / 140)) * 0.16, beat = 60 / (m.tempo || 120);
      let t = ctx.currentTime + 0.08;
      for (const n of String(m.notes).split(' ')) {
        const f = freq(n);
        if (f) {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'triangle'; o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + beat * 0.92);
          o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + beat);
        }
        t += beat;
      }
    },
  };
}
