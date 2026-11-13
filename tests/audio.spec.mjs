// Audio engine test. Run with:  node tests/audio.spec.mjs
//
// Serves the repo over a tiny local http server (ES modules need http), loads a
// blank page in headless Chromium, imports /js/screen/audio.js and renders every
// sfx, the quack, each loop and each music track through an OfflineAudioContext
// (44100 Hz, stereo). Asserts: no exception, not silent, no clipping (peak <= 1.0
// measured after the compressor), one-shots finished by 3 s, pause is silent, and
// that nothing throws before unlock() or without Web Audio. Exit code 1 on failure.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_PATH = '/js/screen/audio.js';
const SAMPLE_RATE = 44100;

// The names the rest of the game is written against.
const SFX_NAMES = [
  'pea', 'shotgun', 'smg', 'rocket', 'torpedo', 'sniper', 'zap', 'wave', 'stone', 'egg',
  'mine_drop', 'mine_beep', 'empty',
  'explosion', 'explosion_big', 'hit', 'shield_hit', 'shield_pop', 'bounce', 'burn', 'nibble',
  'splash_small', 'splash_big', 'dive', 'surface',
  'pickup_weapon', 'pickup_bread', 'pickup_power', 'crate_land',
  'death', 'respawn',
  'countdown', 'go', 'round_win', 'match_win', 'sudden', 'bread_tick', 'join', 'leave',
  'ui_move', 'ui_select'
];
const TRACKS = ['lobby', 'battle', 'sudden', 'victory'];
const LOOPS = ['flame', 'whirl'];
const API = ['unlock', 'setPaused', 'setMusic', 'play', 'loop', 'quack', 'setVolumes', 'now'];

const failures = [];
function check(ok, msg) {
  if (!ok) failures.push(msg);
  return ok;
}

/* ------------------------------------------------------------ static checks */

function staticChecks() {
  const src = fs.readFileSync(path.join(ROOT, MODULE_PATH), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  check(!/\?\.[^\d]/.test(code), 'syntax: optional chaining found');
  check(!/\?\?/.test(code), 'syntax: nullish coalescing found');
  check(!/catch\s*\{/.test(code), 'syntax: optional catch binding found');
  check(!/\bawait\b/.test(code), 'syntax: await found');
  check(!/\bglobalThis\b/.test(code), 'syntax: globalThis found');
  check(!/AudioWorklet|cancelAndHoldAtTime/.test(code), 'uses AudioWorklet or cancelAndHoldAtTime');
  check(!/\bnew\s+Audio\b|<audio|\.mp3|\.ogg|\.wav/.test(code), 'references an audio asset');

  let acorn = null;
  try { acorn = require('acorn'); } catch (e) {
    try { acorn = createRequire(require.resolve('playwright'))('acorn'); } catch (e2) { acorn = null; }
  }
  if (acorn) {
    try {
      acorn.parse(src, { ecmaVersion: 2017, sourceType: 'module' });
      return 'parsed as ES2017 with acorn ' + acorn.version;
    } catch (e) {
      check(false, 'syntax: not ES2017: ' + e.message);
      return 'ES2017 parse FAILED';
    }
  }
  return 'acorn not available, regex syntax checks only';
}

/* ------------------------------------------------------------------- server */

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png'
};

function startServer() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/__blank.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>audio test</title></head><body>audio test</body></html>');
      return;
    }
    const file = path.normalize(path.join(ROOT, url));
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ------------------------------------------------- in-page: offline renders */

async function pageOffline(cfg) {
  const mod = await import(cfg.modulePath);
  const createAudio = mod.createAudio;
  const SR = cfg.sampleRate;
  const rows = [];
  const fails = [];
  const made = [];
  const check = (ok, msg) => { if (!ok) fails.push(msg); return ok; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Peak / rms over [t0, t1) of both channels. `end` is the last moment above -60 dBFS.
  function analyse(buf, t0, t1) {
    const a = Math.max(0, Math.floor((t0 || 0) * SR));
    const b = Math.min(buf.length, t1 === undefined ? buf.length : Math.floor(t1 * SR));
    const chans = [buf.getChannelData(0), buf.getChannelData(1)];
    let peak = 0, bad = 0, first = -1, last = -1;
    const sq = [0, 0];
    for (let ch = 0; ch < 2; ch++) {
      const d = chans[ch];
      for (let i = a; i < b; i++) {
        const x = d[i];
        if (x !== x || x === Infinity || x === -Infinity) { bad++; continue; }
        const ax = x < 0 ? -x : x;
        if (ax > peak) peak = ax;
        sq[ch] += x * x;
        if (ax > 0.001) {
          if (first < 0 || i < first) first = i;
          if (i > last) last = i;
        }
      }
    }
    const n = Math.max(1, b - a);
    let act = 0;
    if (last >= 0) {
      for (let ch = 0; ch < 2; ch++) {
        const d = chans[ch];
        for (let i = first; i <= last; i++) act += d[i] * d[i];
      }
      act = Math.sqrt(act / (2 * (last - first + 1)));
    }
    return {
      peak: peak, bad: bad,
      rms: Math.sqrt((sq[0] + sq[1]) / (2 * n)),
      rmsL: Math.sqrt(sq[0] / n), rmsR: Math.sqrt(sq[1] / n),
      start: first < 0 ? 0 : first / SR,
      end: last < 0 ? 0 : (last + 1) / SR,
      activeRms: act
    };
  }

  // Zero crossings per second of the left channel inside [t0, t1): a cheap pitch proxy.
  function crossings(buf, t0, t1) {
    const d = buf.getChannelData(0);
    let n = 0;
    for (let i = Math.floor(t0 * SR) + 1; i < Math.floor(t1 * SR); i++) {
      if ((d[i - 1] < 0) !== (d[i] < 0)) n++;
    }
    return n / (t1 - t0);
  }

  // Renders `seconds` of audio. script(audio, at, ctx) runs before rendering starts;
  // at(t, fn) runs fn at render time t (OfflineAudioContext.suspend).
  async function render(label, seconds, script) {
    const ctx = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
    let audio = null;
    const guard = (what, fn) => {
      try { fn(); } catch (e) { fails.push(label + ': exception ' + what + ': ' + (e && e.message ? e.message : e)); }
    };
    guard('in createAudio', () => { audio = createAudio({ context: ctx }); });
    if (!audio) return null;
    made.push({ label: label, audio: audio });
    const at = (t, fn) => {
      ctx.suspend(t).then(() => { guard('at ' + t + 's', fn); ctx.resume(); });
    };
    guard('in unlock', () => audio.unlock());
    guard('in setup', () => script(audio, at, ctx));
    const buf = await ctx.startRendering();
    return { audio: audio, buf: buf, all: analyse(buf) };
  }

  function row(group, name, a, extra) {
    rows.push({ group: group, name: name, dur: a.end, peak: a.peak, rms: a.activeRms, extra: extra || '' });
  }

  function common(label, a) {
    check(a.bad === 0, label + ': output contains NaN/Infinity');
    check(a.peak <= 1.0, label + ': clipping, peak ' + a.peak.toFixed(3));
  }

  /* --- module surface --- */
  check(typeof createAudio === 'function', 'createAudio is not exported');
  {
    const a = createAudio({ context: new OfflineAudioContext(2, SR, SR) });
    cfg.api.forEach((m) => check(typeof a[m] === 'function', 'audio.' + m + ' is not a function'));
    check(a.now() === 0, 'now() should be 0 on a fresh offline context');
  }
  if (mod.SFX_NAMES) {
    cfg.sfx.forEach((n) => check(mod.SFX_NAMES.indexOf(n) >= 0, 'sfx missing from module table: ' + n));
  }

  /* --- every one-shot sfx --- */
  for (const name of cfg.sfx) {
    const r = await render('sfx ' + name, 3.5, (audio) => audio.play(name));
    if (!r) continue;
    const a = r.all;
    const tail = analyse(r.buf, 3.0);
    common('sfx ' + name, a);
    check(r.audio._stats().played === 1, 'sfx ' + name + ': was not triggered');
    check(a.peak > 0.02 && a.activeRms > 0.003, 'sfx ' + name + ': silent (peak ' + a.peak.toFixed(4) + ')');
    check(tail.peak < 0.001, 'sfx ' + name + ': still sounding after 3 s (peak ' + tail.peak.toFixed(4) + ')');
    check(a.start < 0.05, 'sfx ' + name + ': starts late (' + a.start.toFixed(3) + ' s)');
    row('sfx', name, a);
  }

  /* --- quack at three duck voices --- */
  const quackRate = {};
  for (const pitch of [0.7, 1.0, 1.4]) {
    const label = 'quack pitch ' + pitch;
    const r = await render(label, 3.5, (audio) => audio.quack({ pitch: pitch }));
    if (!r) continue;
    const a = r.all;
    common(label, a);
    check(a.peak > 0.05 && a.activeRms > 0.01, label + ': silent');
    check(analyse(r.buf, 3.0).peak < 0.001, label + ': still sounding after 3 s');
    check(a.end > 0.12 && a.end < 0.6, label + ': odd length ' + a.end.toFixed(3) + ' s');
    quackRate[pitch] = crossings(r.buf, 0.03, 0.2);
    row('quack', 'quack p=' + pitch, a);
  }
  {
    const r = await render('quack defaults', 1, (audio) => { audio.quack(); });
    if (r) check(r.all.peak > 0.05, 'quack(): silent without options');
  }

  /* --- sustained loops: on at 0, off at 1.5 s --- */
  for (const name of cfg.loops) {
    const label = 'loop ' + name;
    const r = await render(label, 3.5, (audio, at) => {
      audio.loop('k1', name, true, { pan: -0.2, vol: 1 });
      audio.loop('k1', name, true);
      at(0.7, () => {
        check(audio._stats().loops === 1, label + ': second on-call must not start a second loop');
        audio.loop('k1', name, true, { pan: 0.4, vol: 0.8 });
      });
      at(1.5, () => audio.loop('k1', name, false));
    });
    if (!r) continue;
    const on = analyse(r.buf, 0.6, 1.5);
    const off = analyse(r.buf, 2.5);
    common(label, r.all);
    check(on.rms > 0.003, label + ': silent while on (rms ' + on.rms.toFixed(5) + ')');
    check(off.peak < 0.001, label + ': still audible 1 s after off (peak ' + off.peak.toFixed(4) + ')');
    check(r.audio._stats().loops === 0, label + ': loop still registered after off');
    rows.push({ group: 'loop', name: name, dur: r.all.end, peak: r.all.peak, rms: on.rms, extra: 'on 0..1.5 s' });
  }

  /* --- ~6 s of each music track --- */
  for (const name of cfg.tracks) {
    const label = 'music ' + name;
    const r = await render(label, 6, (audio) => { audio.setMusic(name); audio.setMusic(name); });
    if (!r) continue;
    const a = r.all;
    const st = r.audio._stats();
    common(label, a);
    check(a.rms > 0.01, label + ': silent (rms ' + a.rms.toFixed(5) + ')');
    check(st.trackStarts === 1, label + ': same track twice restarted it');
    check(st.songWarnings.length === 0, label + ': song data warnings: ' + st.songWarnings.join('; '));
    check(st.steps > 30, label + ': only ' + st.steps + ' steps scheduled');
    for (let s = 0; s < 6; s++) {
      const w = analyse(r.buf, s, s + 1);
      check(w.rms > 0.004, label + ': gap in second ' + s);
    }
    rows.push({ group: 'music', name: name, dur: a.end, peak: a.peak, rms: a.rms, extra: st.steps + ' steps' });
  }

  /* --- music stays under the sfx --- */
  {
    const sfxPeaks = rows.filter((r) => r.group === 'sfx').map((r) => r.peak).sort((x, y) => x - y);
    const median = sfxPeaks[Math.floor(sfxPeaks.length / 2)] || 0;
    rows.filter((r) => r.group === 'music').forEach((r) => {
      check(r.peak < median, 'music ' + r.name + ': peak ' + r.peak.toFixed(3) + ' is not under the median sfx peak ' + median.toFixed(3));
    });
  }

  /* --- paused from the start: nothing at all may come out --- */
  {
    const r = await render('paused', 3, (audio) => {
      audio.setPaused(true);
      audio.setPaused(true);
      audio.setMusic('battle');
      audio.loop('a', 'flame', true);
      audio.loop('b', 'whirl', true);
      cfg.sfx.forEach((n) => audio.play(n));
      audio.quack({ pitch: 1 });
    });
    if (r) {
      check(r.all.peak < 1e-6, 'setPaused(true): output is not silent (peak ' + r.all.peak + ')');
      check(r.audio._stats().played === 0, 'setPaused(true): sfx were not dropped');
      rows.push({ group: 'state', name: 'paused', dur: r.all.end, peak: r.all.peak, rms: r.all.rms, extra: 'everything requested while paused' });
    }
  }

  /* --- pause in the middle, then unpause: silence, then music + loops come back --- */
  {
    let midStats = null;
    const r = await render('pause/unpause', 4.5, (audio, at) => {
      audio.setMusic('battle');
      audio.loop('f', 'flame', true);
      audio.play('explosion_big');
      audio.quack();
      at(1.0, () => {
        audio.setPaused(true);
        audio.setPaused(true);
        audio.play('shotgun');
        audio.quack();
        audio.loop('w', 'whirl', true);
        audio.setMusic('sudden');
        midStats = audio._stats();
      });
      at(2.0, () => { audio.setPaused(false); audio.setPaused(false); });
    });
    if (r) {
      const before = analyse(r.buf, 0.1, 1.0);
      const during = analyse(r.buf, 1.06, 2.0);
      const after = analyse(r.buf, 2.3, 4.5);
      const st = r.audio._stats();
      common('pause/unpause', r.all);
      check(before.rms > 0.01, 'pause test: nothing audible before the pause');
      check(during.peak < 1e-5, 'pause test: not silent while paused (peak ' + during.peak + ')');
      check(after.rms > 0.005, 'pause test: nothing came back after unpause');
      check(midStats && midStats.tracks === 0 && midStats.loops === 0 && midStats.played === 2,
        'pause test: music/loops not stopped or sfx not dropped while paused ' + JSON.stringify(midStats));
      check(st.track === 'sudden', 'pause test: track requested while paused did not start on unpause (' + st.track + ')');
      check(st.loops === 2, 'pause test: loops not restored on unpause (' + st.loops + ')');
      rows.push({ group: 'state', name: 'pause 1..2 s', dur: r.all.end, peak: during.peak, rms: during.rms, extra: 'window while paused' });
    }
  }

  /* --- crossfade between tracks, stop with null --- */
  {
    const r = await render('crossfade', 5, (audio, at) => {
      audio.setMusic('lobby');
      at(1.5, () => { audio.setMusic('battle'); audio.setMusic('battle'); });
      at(3.5, () => audio.setMusic(null));
    });
    if (r) {
      common('crossfade', r.all);
      for (let t = 0.2; t < 3.4; t += 0.2) {
        check(analyse(r.buf, t, t + 0.2).rms > 0.002, 'crossfade: gap at ' + t.toFixed(1) + ' s');
      }
      check(analyse(r.buf, 4.4).peak < 0.002, 'crossfade: setMusic(null) did not fade the music out');
      check(r.audio._stats().trackStarts === 2, 'crossfade: expected 2 track starts, got ' + r.audio._stats().trackStarts);
      check(r.audio._stats().track === null, 'crossfade: a track is still current after setMusic(null)');
    }
  }

  /* --- volumes --- */
  {
    const loud = await render('vol sfx 1', 1, (audio) => { audio.setVolumes({ sfx: 1 }); audio.play('countdown'); });
    const half = await render('vol sfx 0.25', 1, (audio) => { audio.setVolumes({ sfx: 0.25 }); audio.play('countdown'); });
    const optVol = await render('play vol 0.25', 1, (audio) => { audio.play('countdown', { vol: 0.25 }); });
    const mute = await render('vol 0', 2, (audio) => {
      audio.setVolumes({ music: 0, sfx: 0 });
      audio.setMusic('battle');
      audio.play('explosion');
      audio.quack();
    });
    if (loud && half && optVol && mute) {
      check(half.all.peak < loud.all.peak * 0.6, 'setVolumes: sfx 0.25 is not clearly quieter');
      check(optVol.all.peak < loud.all.peak * 0.6, 'play(): vol 0.25 is not clearly quieter');
      check(analyse(mute.buf, 0.3).peak < 0.001, 'setVolumes: 0/0 is not silent');
    }
    const r = await render('vol junk', 0.5, (audio) => {
      audio.setVolumes(); audio.setVolumes(null); audio.setVolumes({ music: NaN, sfx: 'x' }); audio.setVolumes({ music: 7, sfx: -3 });
    });
    check(!!r, 'setVolumes: junk input broke the render');
  }

  /* --- pan and rate options --- */
  {
    const l = await render('pan left', 1, (audio) => audio.play('countdown', { pan: -1 }));
    const rr = await render('pan right', 1, (audio) => audio.play('countdown', { pan: 1 }));
    if (l && rr) {
      check(l.all.rmsL > l.all.rmsR * 4, 'pan -1 is not on the left');
      check(rr.all.rmsR > rr.all.rmsL * 4, 'pan +1 is not on the right');
    }
    const lo = await render('rate 1', 1, (audio) => audio.play('countdown', { rate: 1 }));
    const hi = await render('rate 2', 1, (audio) => audio.play('countdown', { rate: 2 }));
    if (lo && hi) {
      const ratio = crossings(hi.buf, 0.03, 0.12) / crossings(lo.buf, 0.03, 0.12);
      check(ratio > 1.7 && ratio < 2.3, 'rate 2 should double the pitch, got x' + ratio.toFixed(2));
    }
    if (quackRate[0.7] && quackRate[1.4]) {
      check(quackRate[1.4] > quackRate[0.7] * 1.2, 'quack pitch 1.4 is not higher than 0.7');
    }
  }

  /* --- retrigger limit, unknown names, junk arguments --- */
  {
    const r = await render('retrigger', 1, (audio) => {
      for (let i = 0; i < 10; i++) audio.play('smg');
    });
    if (r) {
      const st = r.audio._stats();
      check(st.played === 1 && st.dropped === 9, 'retrigger: 10 instant smg shots should play once, got ' + st.played);
    }
    const u = await render('unknown', 1, (audio) => {
      audio.play('nope'); audio.play(); audio.play(null); audio.play(42, 'x'); audio.play('toString'); audio.play('constructor');
      audio.play('pea', null); audio.play('hit', 7);
      audio.setMusic('nope'); audio.setMusic(123); audio.setMusic('toString');
      audio.loop('k', 'nope', true); audio.loop(null, null, true); audio.loop('k', 'flame', false); audio.loop();
      audio.quack(null); audio.quack('x');
      audio.setPaused(); audio.setPaused(0);
    });
    if (u) {
      const st = u.audio._stats();
      check(st.played === 3, 'unknown names: expected exactly pea + hit + quack to play, got ' + st.played);
      check(st.tracks === 0 && st.loops === 0, 'unknown names started music or a loop');
    }
  }

  /* --- voice cap + limiter under load --- */
  {
    let peakVoices = 0;
    const r = await render('stress', 4, (audio, at) => {
      audio.setMusic('battle');
      for (let i = 0; i < 6; i++) audio.loop('flame' + i, 'flame', true, { pan: i / 3 - 1 });
      cfg.sfx.forEach((n, i) => audio.play(n, { pan: (i % 5) / 2 - 1 }));
      for (let i = 0; i < 8; i++) audio.quack({ pitch: 0.7 + i * 0.1 });
      peakVoices = audio._stats().sfxVoices;
      // 8 players hammering fire for 2.5 s, explosions going off all the time.
      const shots = ['smg', 'pea', 'shotgun', 'hit', 'explosion', 'sniper', 'rocket', 'explosion_big', 'splash_big', 'zap'];
      for (let k = 1; k <= 62; k++) {
        at(k * 0.04, () => {
          for (let p = 0; p < 8; p++) audio.play(shots[(k + p) % shots.length], { pan: p / 3.5 - 1 });
          if (k % 5 === 0) audio.quack({ pitch: 0.7 + (k % 8) * 0.1 });
          peakVoices = Math.max(peakVoices, audio._stats().sfxVoices);
        });
      }
    });
    if (r) {
      const st = r.audio._stats();
      common('stress', r.all);
      check(r.all.peak <= 0.99, 'stress: peak ' + r.all.peak.toFixed(3) + ' leaves no headroom');
      check(peakVoices <= 24, 'stress: voice cap exceeded (' + peakVoices + ')');
      check(peakVoices >= 20, 'stress: expected the voice pool to fill up (' + peakVoices + ')');
      check(st.stolen + st.dropped > 0, 'stress: nothing was dropped or stolen');
      check(st.loops === 6, 'stress: expected 6 loops, got ' + st.loops);
      rows.push({
        group: 'state', name: 'stress', dur: r.all.end, peak: r.all.peak, rms: r.all.rms,
        extra: 'max ' + peakVoices + ' voices, ' + st.played + ' played, ' + st.stolen + ' stolen, ' + st.dropped + ' dropped'
      });
    }
  }

  /* --- one-shot voices must free themselves --- */
  await sleep(300);
  made.forEach((m) => {
    if (m.label.indexOf('sfx ') === 0 || m.label.indexOf('quack') === 0) {
      check(m.audio._stats().sfxVoices === 0, m.label + ': voice not released after it ended (' + m.audio._stats().sfxVoices + ')');
    }
  });

  return { rows: rows, fails: fails, renders: made.length };
}

/* ------------------------------- in-page: fresh instance / no Web Audio / live */

async function pageRobustness(cfg) {
  const mod = await import(cfg.modulePath);
  const fails = [];
  const notes = [];
  const check = (ok, msg) => { if (!ok) fails.push(msg); return ok; };

  function hammer(label, audio, withUnlock) {
    const calls = [
      ['now', () => audio.now()],
      ['setVolumes', () => audio.setVolumes({ music: 0.5, sfx: 0.5 })],
      ['setMusic', () => audio.setMusic('lobby')],
      ['setMusic same', () => audio.setMusic('lobby')],
      ['setMusic other', () => audio.setMusic('battle')],
      ['play all', () => cfg.sfx.forEach((n) => audio.play(n, { pan: 0.3, vol: 0.8, rate: 1.1 }))],
      ['play unknown', () => audio.play('nope')],
      ['quack', () => audio.quack({ pitch: 1.2, pan: -0.5, vol: 0.9 })],
      ['quack bare', () => audio.quack()],
      ['loop on', () => { audio.loop('a', 'flame', true, { pan: 0, vol: 1 }); audio.loop('b', 'whirl', true); }],
      ['loop off', () => { audio.loop('a', 'flame', false); audio.loop('zzz', 'whirl', false); }],
      ['setPaused true', () => { audio.setPaused(true); audio.setPaused(true); }],
      ['play paused', () => audio.play('pea')],
      ['setPaused false', () => { audio.setPaused(false); audio.setPaused(false); }],
      ['setMusic null', () => audio.setMusic(null)],
      ['now again', () => { if (typeof audio.now() !== 'number') throw new Error('now() is not a number'); }]
    ];
    if (withUnlock) calls.push(['unlock', () => { audio.unlock(); audio.unlock(); }], ['play after unlock', () => audio.play('pea')]);
    calls.forEach((c) => {
      try { c[1](); } catch (e) { fails.push(label + ': ' + c[0] + ' threw: ' + (e && e.message ? e.message : e)); }
    });
  }

  // 1. Fresh instance, nothing unlocked yet.
  let a = null;
  try { a = mod.createAudio(); } catch (e) { fails.push('createAudio() threw: ' + e.message); }
  if (a) {
    hammer('before unlock', a, false);
    hammer('with unlock', a, true);
    try { a.dispose(); hammer('after dispose', a, true); } catch (e) { fails.push('dispose threw: ' + e.message); }
  }

  // 2. Web Audio missing altogether: every method must be a safe no-op.
  const saved = { AC: window.AudioContext, WAC: window.webkitAudioContext };
  try {
    window.AudioContext = undefined;
    window.webkitAudioContext = undefined;
    let b = null;
    try { b = mod.createAudio(); } catch (e) { fails.push('createAudio() threw without Web Audio: ' + e.message); }
    if (b) {
      hammer('no Web Audio', b, true);
      check(b.now() === 0, 'no Web Audio: now() should be 0');
      check(b._stats().hasContext === false, 'no Web Audio: a context exists anyway');
      b.dispose();
    }
  } finally {
    window.AudioContext = saved.AC;
    window.webkitAudioContext = saved.WAC;
  }

  // 3. Context constructor that throws.
  try {
    window.AudioContext = function () { throw new Error('boom'); };
    const c = mod.createAudio();
    hammer('throwing constructor', c, true);
    c.dispose();
  } catch (e) {
    fails.push('throwing AudioContext constructor escaped: ' + e.message);
  } finally {
    window.AudioContext = saved.AC;
  }

  // 4. Leave an instance waiting for the first user gesture (see pageLive).
  window.__live = mod.createAudio();
  window.__live.setMusic('battle');
  window.__live.loop('f', 'flame', true);
  notes.push('state before gesture: ' + window.__live._stats().state);
  return { fails: fails, notes: notes };
}

// Real-time checks: look-ahead scheduler, crossfade bookkeeping, pause, cleanup.
async function pageLive() {
  const fails = [];
  const notes = [];
  const check = (ok, msg) => { if (!ok) fails.push(msg); return ok; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const a = window.__live;
  const S = () => a._stats();

  for (let i = 0; i < 40 && S().state !== 'running'; i++) await sleep(50);
  if (S().state !== 'running') {
    a.dispose();
    return { fails: fails, notes: notes, skipped: 'AudioContext never reached "running" here (state ' + S().state + ')' };
  }
  notes.push('auto-unlocked by the user gesture');

  // The track and loop requested before the gesture must have started by themselves.
  await sleep(200);
  check(S().track === 'battle', 'live: music requested before unlock did not start (' + S().track + ')');
  check(S().loops === 1, 'live: loop requested before unlock did not start');
  check(S().timer === true, 'live: scheduler timer is not running');

  const t0 = a.now();
  const s0 = S().steps;
  await sleep(1500);
  const dt = a.now() - t0;
  const ds = S().steps - s0;
  const sd = 60 / 132 / 4;
  check(dt > 1.2, 'live: audio clock did not advance (' + dt.toFixed(2) + ' s)');
  check(Math.abs(ds - dt / sd) <= 4, 'live: scheduled ' + ds + ' steps in ' + dt.toFixed(2) + ' s, expected about ' + (dt / sd).toFixed(1));
  check(S().musicVoices > 0 && S().musicVoices < 80, 'live: ' + S().musicVoices + ' music voices alive (leak or nothing playing)');
  notes.push('scheduler: ' + ds + ' steps in ' + dt.toFixed(2) + ' s (ideal ' + (dt / sd).toFixed(1) + '), ' + S().musicVoices + ' music voices alive');

  // Same track again: no restart. New track: two tracks during the crossfade, then one.
  const starts = S().trackStarts;
  a.setMusic('battle');
  check(S().trackStarts === starts, 'live: same track restarted');
  a.setMusic('sudden');
  await sleep(150);
  check(S().tracks === 2, 'live: expected 2 tracks during the crossfade, got ' + S().tracks);
  await sleep(1000);
  check(S().tracks === 1 && S().track === 'sudden', 'live: crossfade did not settle on one track');

  // Spam: the voice cap must hold and everything must be released afterwards.
  let maxVoices = 0;
  const names = ['smg', 'pea', 'hit', 'shotgun', 'explosion', 'bounce', 'splash_small', 'zap'];
  for (let i = 0; i < 60; i++) {
    for (let p = 0; p < 8; p++) a.play(names[(i + p) % names.length], { pan: p / 3.5 - 1 });
    if (i % 6 === 0) a.quack({ pitch: 0.8 + (i % 5) * 0.1 });
    maxVoices = Math.max(maxVoices, S().sfxVoices);
    await sleep(10);
  }
  check(maxVoices <= 24, 'live: voice cap exceeded (' + maxVoices + ')');
  check(maxVoices >= 8, 'live: sfx spam produced only ' + maxVoices + ' voices');
  notes.push('spam: max ' + maxVoices + ' sfx voices, ' + S().played + ' played, ' + S().dropped + ' dropped, ' + S().stolen + ' stolen');

  // Pause: scheduling stops, loops stop, voices die. Unpause: music and loops return.
  a.play('explosion_big');
  a.setPaused(true);
  a.setPaused(true);
  await sleep(250);
  const frozen = S().steps;
  const playedBefore = S().played;
  a.play('shotgun');
  a.quack();
  await sleep(300);
  check(S().steps === frozen, 'live: music kept scheduling while paused');
  check(S().played === playedBefore, 'live: sfx played while paused');
  check(S().timer === false && S().tracks === 0 && S().loops === 0, 'live: pause left timer/tracks/loops running ' + JSON.stringify(S()));
  check(S().sfxVoices === 0 && S().musicVoices === 0, 'live: voices alive while paused (' + S().sfxVoices + ' sfx, ' + S().musicVoices + ' music)');
  a.setPaused(false);
  a.setPaused(false);
  await sleep(400);
  check(S().track === 'sudden' && S().steps > frozen, 'live: music did not resume after unpause');
  check(S().loops === 1, 'live: loop did not come back after unpause');

  // Stop everything: nothing may be left behind.
  a.loop('f', 'flame', false);
  a.setMusic(null);
  await sleep(2600);
  const end = S();
  check(end.tracks === 0 && end.musicVoices === 0, 'live: music nodes left after setMusic(null): ' + end.tracks + ' tracks, ' + end.musicVoices + ' voices');
  check(end.sfxVoices === 0, 'live: ' + end.sfxVoices + ' sfx voices never released');
  check(end.loops === 0 && end.timer === false, 'live: loop or timer left running');
  notes.push('after stop: ' + end.sfxVoices + ' sfx voices, ' + end.musicVoices + ' music voices, ' + end.tracks + ' tracks, timer ' + end.timer);
  a.dispose();
  return { fails: fails, notes: notes, skipped: null };
}

/* --------------------------------------------------------------------- main */

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function lpad(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

function printTable(rows) {
  console.log('');
  console.log(pad('group', 7) + pad('name', 16) + lpad('dur s', 8) + lpad('peak', 8) + lpad('rms', 8) + '  note');
  console.log('-'.repeat(78));
  rows.forEach((r) => {
    console.log(pad(r.group, 7) + pad(r.name, 16) + lpad(r.dur.toFixed(3), 8) + lpad(r.peak.toFixed(3), 8) + lpad(r.rms.toFixed(4), 8) + (r.extra ? '  ' + r.extra : ''));
  });
  console.log('');
}

async function main() {
  const syntaxNote = staticChecks();
  const { chromium } = require('playwright');
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const pageErrors = [];
  let live = null;
  let robust = null;
  let offline = null;

  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    await page.goto(base + '/__blank.html');
    const cfg = { modulePath: MODULE_PATH, sampleRate: SAMPLE_RATE, sfx: SFX_NAMES, tracks: TRACKS, loops: LOOPS, api: API };

    offline = await page.evaluate(pageOffline, cfg);
    robust = await page.evaluate(pageRobustness, cfg);
    await page.mouse.click(20, 20);      // the first user gesture
    live = await page.evaluate(pageLive);
  } finally {
    await browser.close();
    server.close();
  }

  printTable(offline.rows);
  offline.fails.forEach((f) => failures.push(f));
  robust.fails.forEach((f) => failures.push(f));
  live.fails.forEach((f) => failures.push(f));
  pageErrors.forEach((e) => failures.push('uncaught page error: ' + e));

  const sfxRows = offline.rows.filter((r) => r.group === 'sfx');
  const musicRows = offline.rows.filter((r) => r.group === 'music');
  const maxPeak = offline.rows.reduce((m, r) => Math.max(m, r.peak), 0);
  const longest = sfxRows.reduce((m, r) => (r.dur > m.dur ? r : m), sfxRows[0]);
  const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const db = (x) => (20 * Math.log10(x)).toFixed(1);

  console.log('syntax        : ' + syntaxNote);
  console.log('offline       : ' + offline.renders + ' renders at ' + SAMPLE_RATE + ' Hz stereo (' + sfxRows.length + ' sfx, 3 quacks, ' +
    LOOPS.length + ' loops, ' + musicRows.length + ' tracks, state tests)');
  console.log('highest peak  : ' + maxPeak.toFixed(3) + ' (limit 1.0, measured after the compressor)');
  console.log('longest sfx   : ' + longest.name + ' ' + longest.dur.toFixed(2) + ' s (limit 3 s)');
  console.log('levels        : median sfx peak ' + db(med(sfxRows.map((r) => r.peak))) + ' dBFS, median music peak ' +
    db(med(musicRows.map((r) => r.peak))) + ' dBFS, median music rms ' + db(med(musicRows.map((r) => r.rms))) + ' dBFS');
  robust.notes.forEach((n) => console.log('robustness    : ' + n));
  if (live.skipped) console.log('live context  : SKIPPED - ' + live.skipped);
  live.notes.forEach((n) => console.log('live context  : ' + n));
  console.log('');

  if (failures.length) {
    console.log('FAILED (' + failures.length + ')');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('PASSED audio.spec: all checks green');
}

main().catch((e) => {
  console.error('audio.spec crashed:', e);
  process.exit(1);
});
