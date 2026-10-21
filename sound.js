/*
 * Звук «Последнего чек-ина».
 * Эффекты синтезируются кодом (Web Audio). Музыка — процедурная, но если в
 * media/music лежит файл с нужным именем (lobby.mp3, quiz.mp3, basement.mp3,
 * finale.mp3, gameover.mp3, intro.mp3), играет он. Озвучка портье — файлы
 * media/vo/<код реплики>.mp3; если файла нет, реплика просто не озвучивается.
 */
(function () {
  'use strict';
  const MODES = ['all', 'nomusic', 'off'];
  let mode = 'all';
  try { mode = localStorage.getItem('checkin_sound') || 'all'; } catch (e) {}
  if (!MODES.includes(mode)) mode = 'all';

  let ctx = null, comp, master, musicBus, sfxBus, voBus, verbIn;
  let files = { vo: [], music: [] };
  const voBuffers = {};
  const musicEls = {};

  const N = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const now = () => ctx.currentTime + 0.01;

  function impulse(sec, decay) {
    const len = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return b;
  }
  let noiseBuf = null;
  function noiseBuffer() {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }

  function init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain();
      master.connect(ctx.destination);
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
      comp.connect(master);
      musicBus = ctx.createGain(); sfxBus = ctx.createGain(); voBus = ctx.createGain();
      musicBus.gain.value = 0.5; sfxBus.gain.value = 0.85; voBus.gain.value = 1;
      musicBus.connect(comp); sfxBus.connect(comp); voBus.connect(master);
      const verb = ctx.createConvolver(); verb.buffer = impulse(2.8, 2.4);
      const vg = ctx.createGain(); vg.gain.value = 0.45;
      verb.connect(vg); vg.connect(comp);
      verbIn = verb;
      applyMode();
      // разблокируем файлы музыки на iOS: короткий play/pause внутри жеста
      Object.values(musicEls).forEach((m) => { try { const p = m.el.play(); if (p) p.then(() => { if (!m.on) m.el.pause(); }).catch(() => {}); } catch (e) {} });
    }
    if (ctx.state === 'suspended') ctx.resume();
    if (pendingMusic) { const n = pendingMusic; pendingMusic = null; music(n); }
    return true;
  }

  function applyMode() {
    if (!ctx) return;
    const t = ctx.currentTime;
    master.gain.setTargetAtTime(mode === 'off' ? 0 : 0.9, t, 0.05);
    musicBus.gain.setTargetAtTime(mode === 'all' ? 0.5 : 0, t, 0.1);
  }
  function cycleMode() {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    try { localStorage.setItem('checkin_sound', mode); } catch (e) {}
    applyMode();
    return mode;
  }

  // ---------- базовые кирпичики ----------
  function env(g, t, a, peak, d) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  function osc(type, f, t, dur, peak, o = {}) {
    if (!ctx) return;
    const a = o.a ?? 0.005;
    const node = ctx.createOscillator();
    node.type = type;
    node.frequency.setValueAtTime(f, t);
    if (o.glide) node.frequency.exponentialRampToValueAtTime(o.glide, t + a + dur);
    if (o.detune) node.detune.value = o.detune;
    const g = ctx.createGain();
    env(g, t, a, peak, dur);
    let last = node;
    if (o.lp) { const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = o.lp; fl.Q.value = o.q || 0.7; node.connect(fl); last = fl; }
    last.connect(g);
    g.connect(o.dest || sfxBus);
    if (o.wet) { const w = ctx.createGain(); w.gain.value = o.wet; g.connect(w); w.connect(verbIn); }
    node.start(t); node.stop(t + a + dur + 0.05);
  }
  function noise(t, dur, peak, o = {}) {
    if (!ctx) return;
    const s = ctx.createBufferSource(); s.buffer = noiseBuffer(); s.loop = true;
    const fl = ctx.createBiquadFilter(); fl.type = o.type || 'lowpass';
    fl.frequency.setValueAtTime(o.f || 1000, t);
    if (o.sweep) fl.frequency.exponentialRampToValueAtTime(o.sweep, t + dur);
    fl.Q.value = o.q || 0.7;
    const g = ctx.createGain(); env(g, t, o.a ?? 0.005, peak, dur);
    s.connect(fl); fl.connect(g); g.connect(o.dest || sfxBus);
    if (o.wet) { const w = ctx.createGain(); w.gain.value = o.wet; g.connect(w); w.connect(verbIn); }
    s.start(t, Math.random()); s.stop(t + (o.a ?? 0.005) + dur + 0.05);
  }

  // ---------- звуковые эффекты ----------
  const fx = {
    click() { const t = now(); osc('triangle', 1500, t, 0.035, 0.06, { a: 0.002, glide: 900 }); },
    select() { const t = now(); osc('sine', 660, t, 0.14, 0.18, { glide: 990, wet: 0.25 }); },
    submit() { const t = now(); osc('triangle', N(76), t, 0.12, 0.16); osc('triangle', N(81), t + 0.08, 0.22, 0.16, { wet: 0.3 }); },
    bell() { // колокольчик на стойке портье
      const t = now();
      [1, 2.71, 5.15, 8.3].forEach((r, i) => osc('sine', 1320 * r, t, 1.7 / (i + 1), 0.2 / (i + 1.3), { a: 0.002, wet: 0.35 }));
    },
    tick(urgent) {
      const t = now();
      osc('square', urgent ? 1650 : 1100, t, 0.025, urgent ? 0.07 : 0.04, { a: 0.001, lp: 4000 });
      noise(t, 0.02, 0.04, { type: 'highpass', f: 3500 });
    },
    round() { // гонг начала вопроса
      const t = now();
      [1, 1.52, 2.31, 2.94, 4.1].forEach((r, i) => osc('sine', 98 * r, t, 2.4 / (i * 0.6 + 1), 0.16 / (i + 1), { a: 0.01, wet: 0.5 }));
      noise(t, 0.4, 0.04, { f: 500, wet: 0.4 });
    },
    right() { const t = now(); [84, 88, 91, 96].forEach((m, i) => osc('sine', N(m), t + i * 0.07, 0.55, 0.12, { wet: 0.45 })); },
    coin() { const t = now(); osc('square', N(83), t, 0.05, 0.05, { lp: 5000 }); osc('square', N(88), t + 0.06, 0.25, 0.05, { lp: 5000, wet: 0.2 }); },
    wrong() {
      const t = now();
      osc('sawtooth', 98, t, 0.75, 0.1, { lp: 700 }); osc('sawtooth', 104, t, 0.75, 0.1, { lp: 700 });
      osc('sine', 49, t, 0.9, 0.22);
    },
    hit() { // удар при спуске в подвал
      const t = now();
      osc('sine', 58, t, 1.6, 0.55, { glide: 32, wet: 0.5 });
      noise(t, 0.9, 0.22, { f: 220, wet: 0.6 });
      [1, 2.37, 3.91].forEach((r) => osc('triangle', 233 * r, t, 1.3, 0.04, { wet: 0.8 }));
    },
    slam() { const t = now(); osc('sine', 95, t, 0.6, 0.75, { a: 0.002, glide: 30 }); noise(t, 0.5, 0.6, { f: 1200, sweep: 120, a: 0.002, wet: 0.55 }); },
    thunder() {
      const t = now();
      noise(t + 0.05, 0.22, 0.32, { type: 'highpass', f: 1600, a: 0.002 });
      noise(t, 3.6, 0.55, { f: 700, sweep: 70, a: 0.06, wet: 0.6 });
    },
    death() {
      const t = now();
      osc('triangle', 520, t, 1.1, 0.18, { glide: 55, wet: 0.5 });
      osc('sine', 62, t + 0.95, 0.9, 0.75, { glide: 28 });
      noise(t + 0.95, 0.6, 0.5, { f: 600, sweep: 90, wet: 0.6 });
    },
    revive() {
      const t = now();
      [74, 78, 81, 86, 90, 93, 98].forEach((m, i) => osc('sine', N(m), t + i * 0.08, 0.95, 0.09, { wet: 0.6 }));
      noise(t, 1.6, 0.05, { type: 'highpass', f: 4000, sweep: 9000, wet: 0.5 });
    },
    chime(n = 3) { // часы бьют рассвет
      const t = now();
      for (let k = 0; k < n; k++) [1, 2, 2.76, 4.1].forEach((r, i) => osc('sine', 196 * r, t + k * 1.05, 2.6 / (i + 1), 0.2 / (i + 1), { wet: 0.6 }));
    },
    step() { const t = now(); osc('sine', 85, t, 0.12, 0.35, { glide: 50 }); noise(t, 0.07, 0.14, { f: 800 }); },
    steps(n) { for (let i = 0; i < Math.min(n, 6); i++) setTimeout(fx.step, i * 190); },
    whoosh() { const t = now(); noise(t, 0.6, 0.18, { type: 'bandpass', f: 300, sweep: 3200, q: 1.2, a: 0.2, wet: 0.3 }); },
    fanfare() {
      const t = now();
      [[62, 0], [66, 0.16], [69, 0.32], [74, 0.48], [78, 0.64]].forEach(([m, d]) => {
        osc('triangle', N(m), t + d, 0.5, 0.13, { wet: 0.4 }); osc('sine', N(m - 12), t + d, 0.5, 0.09);
      });
      [74, 78, 81].forEach((m) => osc('triangle', N(m), t + 0.85, 1.8, 0.1, { wet: 0.5 }));
    },
    heartbeat() { const t = now(); osc('sine', 60, t, 0.13, 0.55, { glide: 40 }); osc('sine', 55, t + 0.23, 0.16, 0.45, { glide: 37 }); },
    roar() { // пробуждение Тьмы
      const t = now();
      osc('sawtooth', 46, t, 2.8, 0.22, { a: 0.4, lp: 260, q: 4, wet: 0.5 });
      osc('sawtooth', 49, t, 2.8, 0.18, { a: 0.5, lp: 220, q: 4, wet: 0.5 });
      noise(t, 2.6, 0.25, { type: 'bandpass', f: 140, sweep: 900, q: 1.5, a: 0.6, wet: 0.6 });
      osc('sine', 34, t + 0.2, 2.4, 0.5, { a: 0.3 });
    },
    devour() { // Тьма кого-то съела
      const t = now();
      for (let i = 0; i < 4; i++) noise(t + i * 0.07, 0.06, 0.4, { type: 'bandpass', f: 1800 - i * 250, q: 2, a: 0.002 });
      osc('sine', 70, t + 0.25, 0.7, 0.7, { glide: 30, wet: 0.4 });
      osc('sawtooth', 52, t + 0.2, 1.2, 0.16, { lp: 300, q: 4, wet: 0.5 });
    },
    gloom() { const t = now(); [50, 53, 57].forEach((m) => osc('sawtooth', N(m), t, 2.2, 0.06, { lp: 600, a: 0.3, wet: 0.5 })); },
  };

  // дождь для вступления
  let rainStop = null;
  function rain(on) {
    if (!ctx) return;
    if (!on) { if (rainStop) rainStop(); rainStop = null; return; }
    if (rainStop) return;
    const t = now();
    const s = ctx.createBufferSource(); s.buffer = noiseBuffer(); s.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7000;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09, t + 1.2);
    s.connect(hp); hp.connect(lp); lp.connect(g); g.connect(sfxBus); s.start(t);
    rainStop = () => { const e = ctx.currentTime; g.gain.cancelScheduledValues(e); g.gain.setTargetAtTime(0.0001, e, 0.6); s.stop(e + 3); };
  }

  // ---------- процедурная музыка ----------
  const TRACKS = {
    lobby: {
      bpm: 60,
      step(i, t, st, out) {
        const chords = [[50, 57, 62, 65], [46, 53, 58, 62], [43, 50, 55, 58], [45, 52, 57, 61]];
        if (i % 16 === 0) chords[(i / 16) % 4].forEach((m, k) => osc('sawtooth', N(m), t, st * 16, 0.028, { a: 1.5, lp: 900, detune: k % 2 ? 6 : -6, dest: out, wet: 0.4 }));
        if (Math.random() < 0.33) { const sc = [74, 76, 77, 79, 81, 82, 84, 86]; osc('sine', N(sc[Math.floor(Math.random() * sc.length)]), t, 1.4, 0.05, { a: 0.003, dest: out, wet: 0.7 }); }
      },
    },
    quiz: {
      bpm: 96,
      step(i, t, st, out) {
        const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [52, 56, 59]];
        const c = chords[Math.floor(i / 8) % 4];
        const arp = [0, 1, 2, 1, 0, 2, 1, 2];
        osc('triangle', N(c[arp[i % 8]] + 12), t, st * 0.9, 0.04, { a: 0.004, lp: 2600, dest: out, wet: 0.3 });
        if (i % 4 === 0) osc('sine', N(c[0] - 12), t, st * 3.5, 0.12, { a: 0.01, dest: out });
        if (i % 2 === 0) noise(t, 0.03, 0.012, { type: 'highpass', f: 6000, dest: out });
      },
    },
    basement: {
      bpm: 70,
      step(i, t, st, out) {
        if (i % 32 === 0) { [36, 42].forEach((m, k) => osc('sawtooth', N(m), t, st * 32, 0.05, { a: 3, lp: 280, detune: k ? 8 : -8, dest: out, wet: 0.3 })); }
        if (i % 4 === 0) { osc('sine', 58, t, 0.12, 0.3, { glide: 40, dest: out }); osc('sine', 54, t + 0.22, 0.15, 0.24, { glide: 38, dest: out }); }
        if (Math.random() < 0.06) [1, 2.37, 3.91].forEach((r) => osc('triangle', 311 * r, t, 1.6, 0.022, { dest: out, wet: 0.9 }));
      },
    },
    finale: {
      bpm: 150,
      step(i, t, st, out) {
        const roots = [38, 34, 36, 33]; // D, Bb, C, A
        const r = roots[Math.floor(i / 16) % 4];
        const pat = [0, 0, 12, 0, 3, 0, 2, 0];
        osc('sawtooth', N(r + pat[i % 8]), t, st * 0.8, 0.09, { a: 0.003, lp: 750, q: 3, dest: out });
        if (i % 2 === 0) osc('sine', 130, t, 0.16, 0.5, { glide: 42, a: 0.002, dest: out });
        if (i % 4 === 2) noise(t, 0.12, 0.16, { type: 'bandpass', f: 1800, q: 0.8, dest: out, wet: 0.2 });
        noise(t, 0.025, 0.02, { type: 'highpass', f: 7000, dest: out });
        if (i % 16 === 0) {
          const tri = [[62, 65, 69], [58, 62, 65], [60, 64, 67], [61, 64, 69]][Math.floor(i / 16) % 4];
          tri.forEach((m) => { for (let k = 0; k < 16; k++) osc('sawtooth', N(m + 12), t + k * st, st * 0.7, 0.012, { a: 0.01, lp: 3000, dest: out }); });
        }
        if (i % 64 === 60) noise(t, st * 4, 0.12, { type: 'bandpass', f: 400, sweep: 6000, q: 1, a: st * 3.5, dest: out, wet: 0.4 });
      },
    },
    gameover: {
      bpm: 84,
      step(i, t, st, out) {
        const chords = [[62, 66, 69], [55, 59, 62], [59, 62, 66], [57, 61, 64]];
        const c = chords[Math.floor(i / 8) % 4];
        if (i % 8 === 0) c.forEach((m) => osc('triangle', N(m), t, st * 8, 0.03, { a: 0.4, lp: 1800, dest: out, wet: 0.5 }));
        osc('sine', N(c[i % 3] + 24), t, 0.9, 0.04, { a: 0.003, dest: out, wet: 0.6 });
      },
    },
  };

  const AUDIO_EXT = ['.mp3', '.m4a', '.ogg', '.wav'];
  const findFile = (list, base) => list.find((f) => AUDIO_EXT.some((e) => f.toLowerCase() === base + e));

  let cur = null; // { name, stop }
  let pendingMusic = null;
  function music(name) {
    if (cur && cur.name === name) return;
    if (cur) { cur.stop(); cur = null; }
    if (!name) return;
    if (!ctx) { pendingMusic = name; return; }
    const file = findFile(files.music, name);
    if (file) {
      let m = musicEls[name];
      if (!m) m = musicEls[name] = makeEl(file);
      m.on = true;
      const t = ctx.currentTime;
      m.g.gain.cancelScheduledValues(t); m.g.gain.setValueAtTime(0.0001, t); m.g.gain.exponentialRampToValueAtTime(1, t + 1.2);
      try { m.el.currentTime = 0; } catch (e) {}
      const p = m.el.play(); if (p && p.catch) p.catch(() => {});
      cur = { name, stop() { m.on = false; const e = ctx.currentTime; m.g.gain.setTargetAtTime(0.0001, e, 0.4); setTimeout(() => { if (!m.on) m.el.pause(); }, 1800); } };
      return;
    }
    const tr = TRACKS[name];
    if (!tr) return;
    const out = ctx.createGain(); out.connect(musicBus);
    const t0 = ctx.currentTime;
    out.gain.setValueAtTime(0.0001, t0); out.gain.exponentialRampToValueAtTime(1, t0 + 1.5);
    const st = 60 / tr.bpm / 2;
    let i = 0, next = t0 + 0.1;
    const timer = setInterval(() => {
      if (ctx.state !== 'running') return;
      while (next < ctx.currentTime + 0.25) { tr.step(i, next, st, out); next += st; i++; }
    }, 40);
    cur = { name, stop() { clearInterval(timer); const e = ctx.currentTime; out.gain.setTargetAtTime(0.0001, e, 0.5); setTimeout(() => out.disconnect(), 4000); } };
  }
  function makeEl(file) {
    const el = new Audio(); el.src = `/media/music/${file}`; el.loop = true; el.preload = 'auto'; el.crossOrigin = 'anonymous';
    const src = ctx.createMediaElementSource(el);
    const g = ctx.createGain(); g.gain.value = 0.0001;
    src.connect(g); g.connect(musicBus);
    return { el, g, on: false };
  }

  // ---------- озвучка портье ----------
  let voSrc = null;
  async function loadVo(id) {
    if (voBuffers[id] !== undefined) return voBuffers[id];
    const file = findFile(files.vo, id);
    if (!file || !ctx) return (voBuffers[id] = null);
    voBuffers[id] = fetch(`/media/vo/${file}`).then((r) => r.arrayBuffer())
      .then((b) => new Promise((res, rej) => ctx.decodeAudioData(b, res, rej)))
      .catch(() => null);
    return voBuffers[id];
  }
  async function voice(id) {
    if (!ctx || !id) return;
    const buf = await loadVo(id);
    if (!buf) return;
    if (voSrc) { try { voSrc.stop(); } catch (e) {} }
    const s = ctx.createBufferSource(); s.buffer = buf; s.connect(voBus);
    const t = ctx.currentTime;
    // приглушаем музыку, пока портье говорит
    if (mode === 'all') { musicBus.gain.cancelScheduledValues(t); musicBus.gain.setTargetAtTime(0.18, t, 0.15); musicBus.gain.setTargetAtTime(0.5, t + buf.duration, 0.6); }
    s.start(t); voSrc = s;
    return new Promise((res) => { s.onended = res; });
  }

  async function loadList() {
    try { files = await (await fetch('/media-list')).json(); } catch (e) {}
    if (ctx) files.vo.forEach((f) => loadVo(f.replace(/\.[^.]+$/, '')));
  }

  window.SND = { init, fx, music, voice, rain, loadList, cycleMode, get mode() { return mode; }, get ready() { return !!ctx && ctx.state === 'running'; } };
  ['pointerdown', 'keydown', 'touchend'].forEach((ev) => document.addEventListener(ev, () => init(), { passive: true }));
})();
