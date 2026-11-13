// Screen entry point: owns all authoritative state. Wires AirConsole (lobby, rounds, seats,
// pause and ad breaks, save data) to the simulation, renderer, audio and UI overlays.
import {
  COLORS, HATS, MODES, MAPS, DIFFICULTIES, MAX_PLAYERS, WEAPONS, BOT_NAMES, VIBE, INPUT_FIRE, clamp
} from "../shared/config.js";
import { buildMap, MAP_IDS, ARENA_W } from "./maps.js";
import { createWorld, stepWorld, TICK, addDuck, removeDuck, setBot, duckBySeat, aliveCount } from "./sim.js";
import { createFx } from "./fx.js";
import { createRenderer } from "./render.js";
import { createAudio } from "./audio.js";
import { createUi } from "./ui.js";

/* global AirConsole */
const airconsole = new AirConsole({ silence_inactive_players: true });

const canvas = document.getElementById("game");
const fx = createFx();
const renderer = createRenderer(canvas, fx);
const audio = createAudio();
const ui = createUi();

// ---- state -----------------------------------------------------------------------------------
let state = "LOADING";            // LOADING | LOBBY | MATCH | RESULTS
let ready = false;
let paused = false;               // platform pause
let adShowing = false;            // ad break in progress
let pendingAfterAd = null;        // what to do once the ad break is over
let adTimer = 0;
const cfg = { mode: 0, map: 0, goal: MODES[0].goalDefault, bots: 2, diff: 1 };
const seats = [];                 // index = colour. { id, hat, connected, uid, ... } or null
for (let i = 0; i < MAX_PLAYERS; i++) seats.push(null);
const saves = {};                 // uid -> { v, hat, wins, games, splashes }
const saveAsked = {};             // uid -> true once requested
const maps = {};                  // id -> built map
let world = null;
let bakedMap = null;
let match = null;
let results = null;
let time = 0;                     // presentation clock; stops while paused
let acc = 0;
let timeScale = 1;
let slowT = 0;
let hitStop = 0;
let lastFrame = null;
let publishT = 0, publishDirty = false;
let banner = null;
let feed = [];
const dmgPop = {};                // seat -> accumulated damage for floating numbers
const flameT = {};                // seat -> last flame event time
let lastHitSfx = 0;
let perfT = 0, perfFrames = 0, perfSlow = 0;
let resultsT = 0;
let qualityLock = false;
let needsPaint = true;

function getMap(id) { return maps[id] || (maps[id] = buildMap(id)); }

function useMap(id) {
  const m = getMap(id);
  if (bakedMap !== m) { renderer.bake(m); bakedMap = m; }
  needsPaint = true;
  return m;
}

// ---- seats -----------------------------------------------------------------------------------
function seatOf(deviceId) {
  for (let i = 0; i < seats.length; i++) if (seats[i] && seats[i].id === deviceId) return i;
  return -1;
}
function humanSeats() {
  const out = [];
  for (let i = 0; i < seats.length; i++) if (seats[i] && seats[i].connected) out.push(i);
  return out;
}
function nick(deviceId) {
  const n = airconsole.getNickname(deviceId);
  return n ? String(n).slice(0, 16) : "Guest";
}
function effectiveBots(humans) {
  let n = Math.min(cfg.bots, MAX_PLAYERS - humans);
  if (humans + n < 2) n = Math.min(MAX_PLAYERS - humans, 2 - humans);
  return Math.max(0, n);
}
function botSeats(count) {
  const out = [];
  for (let i = MAX_PLAYERS - 1; i >= 0 && out.length < count; i--) if (!seats[i]) out.push(i);
  return out;
}
function botName(seat) { return BOT_NAMES[(seat * 5 + 3) % BOT_NAMES.length]; }
function botHat(seat) { return (seat * 3 + 1) % HATS.length; }

function takeSeat(deviceId) {
  let free = -1;
  for (let i = 0; i < seats.length; i++) {
    if (seats[i]) continue;
    if (state === "MATCH" && world && duckBySeat(world, i)) continue;     // a bot is paddling there
    free = i; break;
  }
  if (free < 0 && state === "MATCH" && world && match.phase === "play") {
    // Pond is full of bots: one of them makes room.
    for (let i = MAX_PLAYERS - 1; i >= 0; i--) {
      const d = duckBySeat(world, i);
      if (!seats[i] && d && d.isBot) { removeDuck(world, i); free = i; break; }
    }
  }
  if (free < 0) for (let i = 0; i < seats.length; i++) if (!seats[i]) { free = i; break; }
  if (free < 0) return -1;
  const uid = airconsole.getUID(deviceId);
  const save = uid && saves[uid];
  seats[free] = {
    id: deviceId, hat: save ? save.hat : (free * 5 + 2) % HATS.length, hatTouched: false, connected: true, uid: uid,
    dive: undefined, quack: undefined, statusKey: "", statusT: 0, vibeT: 0
  };
  return free;
}

// Give free seats to connected phones that have none (a seat freed up, or they came in while a
// round was running). Returns true when somebody was seated.
function seatWaiting() {
  const ids = airconsole.getControllerDeviceIds();
  let changed = false;
  for (let i = 0; i < ids.length; i++) {
    if (seatOf(ids[i]) < 0 && takeSeat(ids[i]) >= 0) { requestSave(ids[i]); changed = true; }
  }
  return changed;
}

// ---- persistence -----------------------------------------------------------------------------
function sanitizeSave(raw) {
  const s = { v: 1, hat: 0, wins: 0, games: 0, splashes: 0 };
  if (raw && typeof raw === "object") {
    if (typeof raw.hat === "number" && raw.hat >= 0 && raw.hat < HATS.length) s.hat = raw.hat | 0;
    if (typeof raw.wins === "number" && raw.wins >= 0) s.wins = Math.min(1e6, raw.wins | 0);
    if (typeof raw.games === "number" && raw.games >= 0) s.games = Math.min(1e6, raw.games | 0);
    if (typeof raw.splashes === "number" && raw.splashes >= 0) s.splashes = Math.min(1e7, raw.splashes | 0);
  }
  return s;
}
function requestSave(deviceId) {
  const uid = airconsole.getUID(deviceId);
  if (uid && !saves[uid] && !saveAsked[uid]) {
    saveAsked[uid] = true;
    try { airconsole.requestPersistentData([uid]); } catch (e) { /* not available */ }
  }
}
function storeSave(seat) {
  const s = seats[seat];
  if (!s || !s.uid) return;
  const save = saves[s.uid] || (saves[s.uid] = sanitizeSave(null));
  save.hat = s.hat;
  try { airconsole.storePersistentData("save", save, s.uid); } catch (e) { /* not available */ }
}

// ---- publishing state to the controllers -----------------------------------------------------
function publish() { publishDirty = true; }
function publishNow() {
  if (!ready) return;
  publishDirty = false;
  publishT = 0.12;
  const seatMap = {};
  for (let i = 0; i < seats.length; i++) if (seats[i] && seats[i].connected) seatMap[seats[i].id] = [i, seats[i].hat];
  const data = {
    view: state === "MATCH" ? "GAME" : (state === "RESULTS" ? "RESULTS" : "LOBBY"),
    cfg: [cfg.mode, cfg.map, cfg.goal, cfg.bots, cfg.diff],
    bots: effectiveBots(humanSeats().length),
    seats: seatMap
  };
  if (state === "MATCH" && match) { data.mode = match.modeIndex; data.round = match.round; data.late = match.mode === "lms" ? 1 : 0; }
  if (state === "RESULTS" && results) data.res = results.forPhones;
  airconsole.setCustomDeviceState(data);
}

function toPhone(seat, msg) {
  const s = seats[seat];
  if (s && s.connected) airconsole.message(s.id, msg);
}
function vibe(seat, id) {
  const s = seats[seat];
  if (!s || !s.connected) return;
  if (id === VIBE.HIT) { if (time - s.vibeT < 0.2) return; s.vibeT = time; }
  airconsole.message(s.id, { v: id });
}

// ---- lobby -----------------------------------------------------------------------------------
function lobbyRoster() {
  const list = [];
  const humans = humanSeats();
  for (let i = 0; i < humans.length; i++) {
    const s = seats[humans[i]];
    list.push({ seat: humans[i], name: nick(s.id), color: humans[i], hat: s.hat, bot: true, skill: 1, deviceId: s.id, human: true });
  }
  const bots = botSeats(effectiveBots(humans.length));
  for (let i = 0; i < bots.length; i++) {
    list.push({ seat: bots[i], name: botName(bots[i]), color: bots[i], hat: botHat(bots[i]), bot: true, skill: cfg.diff, human: false });
  }
  return list;
}

function syncLobbyWorld() {
  if (state !== "LOBBY" || !world) return;
  const want = lobbyRoster();
  for (let i = world.ducks.length - 1; i >= 0; i--) {
    const d = world.ducks[i];
    let keep = false;
    for (let k = 0; k < want.length; k++) if (want[k].seat === d.seat && want[k].deviceId === d.deviceId) keep = true;
    if (!keep) { fx.ring(d.x, d.y, 10, 50, 0.5, 3); removeDuck(world, d.seat); }
  }
  for (let k = 0; k < want.length; k++) {
    const w = want[k];
    const d = duckBySeat(world, w.seat);
    if (d) { d.hat = w.hat; d.name = w.name; }
    else {
      const nd = addDuck(world, w);
      fx.splash(nd.x, nd.y, 14, 1); fx.ring(nd.x, nd.y, 8, 60, 0.6, 3);
    }
  }
}

function renderLobby() {
  if (state !== "LOBBY") return;
  const humans = humanSeats();
  const master = airconsole.getMasterControllerDeviceId();
  const players = [];
  for (let i = 0; i < humans.length; i++) {
    const s = seats[humans[i]];
    players.push({ seat: humans[i], name: nick(s.id), hat: s.hat, pic: airconsole.getProfilePicture(s.id, 96) || "", master: s.id === master, bot: false });
  }
  const bots = botSeats(effectiveBots(humans.length));
  for (let i = 0; i < bots.length; i++) players.push({ seat: bots[i], name: botName(bots[i]), hat: botHat(bots[i]), pic: "", master: false, bot: true });
  let hint;
  if (!humans.length) hint = [{ t: "Grab your phone and join to play!" }];
  else if (master !== undefined && seatOf(master) >= 0) hint = [{ t: nick(master), b: true }, { t: " can start the battle" }];
  else hint = [{ t: "Waiting for the host..." }];
  ui.lobby({ cfg: cfg, players: players, botCount: bots.length, hint: hint, pulse: humans.length > 0 });
}

function enterLobby() {
  state = "LOBBY";
  match = null; results = null; banner = null; feed = [];
  timeScale = 1; slowT = 0; hitStop = 0; acc = 0;
  airconsole.setActivePlayers(0);                 // ends any round and admits waiting phones
  for (let i = 0; i < seats.length; i++) if (seats[i] && !seats[i].connected) seats[i] = null;
  seatWaiting();
  fx.clear();
  const mapId = cfg.map === 0 ? "lagoon" : MAPS[cfg.map].id;
  world = createWorld({ map: useMap(mapId), mode: "lobby", seed: (Math.random() * 1e9) | 0, ducks: lobbyRoster() });
  ui.show("lobby");
  renderLobby();
  audio.setMusic("lobby");
  publishNow();
}

// ---- match -----------------------------------------------------------------------------------
function recFor(key) {
  return match.rec[key] || (match.rec[key] = { wins: 0, score: 0, kills: 0, deaths: 0, dmg: 0, dives: 0, crates: 0, loaf: 0 });
}
function keyOfDuck(d) { return d.deviceId !== undefined ? "d" + d.deviceId : "b" + d.seat; }

function startMatch() {
  const mode = MODES[cfg.mode];
  const order = MAP_IDS.slice();
  for (let i = order.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = order[i]; order[i] = order[j]; order[j] = t; }
  match = {
    mode: mode.id, modeIndex: cfg.mode, goal: mode.goals[cfg.goal], round: 0,
    maps: cfg.map === 0 ? order : [MAPS[cfg.map].id],
    rec: {}, names: {}, phase: "play", phaseT: 0, pulseT: 15, decided: null, lastWinner: null
  };
  state = "MATCH";
  results = null;
  ui.show(null);
  startRound();
}

function startRound() {
  match.round++;
  match.phase = "play";
  match.pulseT = 15;
  timeScale = 1; slowT = 0; hitStop = 0; acc = 0;
  feed = [];
  fx.clear();
  // Seats of players who left are released between rounds.
  for (let i = 0; i < seats.length; i++) if (seats[i] && !seats[i].connected) seats[i] = null;
  seatWaiting();
  const humans = humanSeats();
  if (!humans.length) { enterLobby(); return; }
  const ducks = [];
  for (let i = 0; i < humans.length; i++) {
    const s = seats[humans[i]];
    ducks.push({ seat: humans[i], name: nick(s.id), color: humans[i], hat: s.hat, bot: false, deviceId: s.id });
    s.dive = undefined; s.quack = undefined; s.statusKey = "";
  }
  const bots = botSeats(effectiveBots(humans.length));
  for (let i = 0; i < bots.length; i++) ducks.push({ seat: bots[i], name: botName(bots[i]), color: bots[i], hat: botHat(bots[i]), bot: true, skill: cfg.diff });
  const mapId = match.maps[(match.round - 1) % match.maps.length];
  const map = useMap(mapId);
  world = createWorld({ map: map, mode: match.mode, goal: match.goal, seed: (Math.random() * 1e9) | 0, ducks: ducks });
  for (let i = 0; i < world.ducks.length; i++) {
    const d = world.ducks[i];
    match.names[keyOfDuck(d)] = { name: d.name, seat: d.seat, hat: d.hat, bot: d.isBot };
    recFor(keyOfDuck(d));
  }
  // Round start. Every phone that is here now stays unsilenced (the ones without a seat show
  // "pond is full"); phones that connect later wait until the round is over.
  airconsole.setActivePlayers();
  publishNow();
  const sub = match.mode === "lms" ? "Round " + match.round + "  ·  first to " + match.goal : MODES[match.modeIndex].name;
  setBanner(map.name, sub, "#ffffff", 2.0, 84, 300);
  audio.setMusic("battle");
}

function collectStats() {
  for (let i = 0; i < world.ducks.length; i++) {
    const d = world.ducks[i];
    const r = recFor(keyOfDuck(d));
    r.kills += d.kills; r.deaths += d.deaths; r.dmg += d.dmg; r.dives += d.dives; r.crates += d.crates; r.loaf += d.loafTime;
    if (match.mode !== "lms") r.score = d.score;
    d.kills = 0; d.deaths = 0; d.dmg = 0; d.dives = 0; d.crates = 0; d.loafTime = 0;
  }
}

function onRoundOver(winnerSeat) {
  match.phase = "roundEnd";
  match.phaseT = match.mode === "lms" ? 4.4 : 3.6;
  const w = winnerSeat >= 0 ? duckBySeat(world, winnerSeat) : null;
  collectStats();
  airconsole.setActivePlayers(0);            // waiting phones may come in now
  match.decided = null;
  if (match.mode === "lms") {
    if (w) {
      const r = recFor(keyOfDuck(w));
      r.wins++; r.score = r.wins;
      if (r.wins >= match.goal) match.decided = keyOfDuck(w);
      setBanner(w.name + " wins the round!", match.decided ? "" : r.wins + " of " + match.goal, COLORS[w.color].body, 3.6, 78, 300);
      fx.confetti(w.x, w.y, 40);
      vibe(w.seat, VIBE.WIN);
    } else {
      setBanner("Nobody floats!", "No point this round", "#ffffff", 3.4, 78, 300);
    }
    audio.play("round_win");
  } else {
    match.decided = w ? keyOfDuck(w) : "none";
    setBanner(w ? w.name + " wins!" : "Time!", "", w ? COLORS[w.color].body : "#ffffff", 3.2, 92, 300);
    if (w) { fx.confetti(w.x, w.y, 60); vibe(w.seat, VIBE.WIN); }
    audio.play("round_win");
  }
  if (w) { fx.focus(w.x, w.y, 1.22); }
  timeScale = 0.3; slowT = 1.2;
  publish();
}

function enterResults() {
  state = "RESULTS";
  resultsT = 0;
  fx.unfocus();
  const rows = [];
  for (const key in match.rec) {
    const r = match.rec[key], n = match.names[key];
    if (!n) continue;
    rows.push({ key: key, seat: n.seat, hat: n.hat, name: n.name, bot: n.bot, score: r.score, r: r });
  }
  rows.sort(function (a, b) { return b.score - a.score || b.r.kills - a.r.kills || a.r.deaths - b.r.deaths; });
  const unit = match.mode === "lms" ? " rounds" : (match.mode === "dm" ? " splashes" : " points");
  const ranks = rows.slice(0, 3).map(function (x) { return { seat: x.seat, hat: x.hat, name: x.name, score: x.score + unit, bot: x.bot }; });
  const awards = [];
  const best = function (field, label, fmt, min) {
    let top = null;
    for (let i = 0; i < rows.length; i++) if (!top || rows[i].r[field] > top.r[field]) top = rows[i];
    if (top && top.r[field] >= min) awards.push({ label: label, name: top.name, value: fmt(top.r[field]) });
  };
  best("dmg", "Sharpest Beak", function (v) { return Math.round(v) + " damage"; }, 50);
  best("kills", "Splash Master", function (v) { return v + " splashes"; }, 2);
  best("dives", "Submarine", function (v) { return v + " dives"; }, 4);
  best("crates", "Crate Hog", function (v) { return v + " crates"; }, 3);
  best("deaths", "Sitting Duck", function (v) { return v + " dunkings"; }, 3);
  if (match.mode === "loaf") best("loaf", "Loaf Lover", function (v) { return Math.round(v) + " s with the loaf"; }, 5);

  const forPhones = { w: rows.length ? rows[0].name : "", wc: rows.length ? rows[0].seat : 0, r: {} };
  for (let i = 0; i < rows.length; i++) {
    const x = rows[i];
    if (x.key.charAt(0) !== "d") continue;
    const dev = Number(x.key.slice(1));
    forPhones.r[dev] = [i + 1, x.score, x.r.kills];
    // lifetime stats, saved per player
    const si = seatOf(dev);
    if (si >= 0 && seats[si].uid) {
      const save = saves[seats[si].uid] || (saves[seats[si].uid] = sanitizeSave(null));
      save.games++; save.splashes += x.r.kills; if (i === 0) save.wins++;
      storeSave(si);
    }
  }
  const master = airconsole.getMasterControllerDeviceId();
  results = {
    forPhones: forPhones,
    view: {
      title: rows.length ? rows[0].name + " rules the pond!" : "Match over",
      ranks: ranks, awards: awards.slice(0, 4),
      hint: master !== undefined ? [{ t: nick(master), b: true }, { t: ": rematch or back to the lobby" }] : [{ t: "Back to the lobby soon..." }]
    }
  };
  ui.results(results.view);
  ui.show("results");
  audio.setMusic("victory");
  audio.play("match_win");
  for (let i = 0; i < 5; i++) fx.confetti(200 + i * 300, 760, 40);
  publishNow();
}

// Leave the results screen through an ad break: the flow continues from onAdComplete.
function leaveResults(next) {
  if (pendingAfterAd) return;
  pendingAfterAd = next;
  adTimer = 2.5;                       // safety net if the platform never answers
  airconsole.showAd();
}
function afterAd() {
  const next = pendingAfterAd;
  pendingAfterAd = null;
  if (!next) return;
  if (next === "rematch" && humanSeats().length) startMatch(); else enterLobby();
}

// ---- banners and the kill feed ---------------------------------------------------------------
function setBanner(text, sub, color, dur, size, y) {
  banner = { text: text, sub: sub || "", color: color || "#ffffff", t: time, dur: dur || 1.5, size: size || 110, y: y || 330 };
}
function pushFeed(entry) {
  entry.t = time;
  feed.push(entry);
  if (feed.length > 5) feed.shift();
}

// ---- simulation events -> effects, sound, phones ---------------------------------------------
const SHOT_SFX = ["pea", "shotgun", "smg", "rocket", null, "torpedo", "sniper", null, null, "wave", "stone", "egg"];
const SHOT_SHAKE = [0, 0.16, 0.03, 0.2, 0, 0.08, 0.24, 0, 0.06, 0.2, 0, 0.1];
function pan(x) { return clamp((x / ARENA_W) * 2 - 1, -1, 1) * 0.7; }

function handleEvents() {
  const ev = world.events;
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    switch (e.type) {
      case "shot": {
        const sfx = SHOT_SFX[e.w];
        if (sfx) audio.play(sfx, { pan: pan(e.x) });
        if (e.w !== 4 && e.w !== 7 && e.w !== 8) fx.muzzle(e.x, e.y, e.a, e.w === 1 || e.w === 3 || e.w === 6 ? 20 : 12, e.w === 5 ? "170,230,255" : undefined);
        if (SHOT_SHAKE[e.w]) fx.shake(SHOT_SHAKE[e.w]);
        if (e.w === 1 || e.w === 3) fx.smoke(e.x, e.y, 3, 10, "220,220,225", 30);
        if (e.w === 5) { fx.splash(e.x, e.y, 5, 0.6); fx.ring(e.x, e.y, 4, 26, 0.4, 2); }
        break;
      }
      case "flame":
        fx.flame(e.x, e.y, e.a);
        flameT[e.seat] = time;
        audio.loop("flame" + e.seat, "flame", true, { pan: pan(e.x), vol: 0.8 });
        break;
      case "zap":
        fx.bolt(e.pts);
        for (let k = 2; k < e.pts.length; k += 2) { fx.flash(e.pts[k], e.pts[k + 1], 26, "190,250,255", 0.14); fx.sparks(e.pts[k], e.pts[k + 1], 5, "190,250,255", 220); }
        audio.play("zap", { pan: pan(e.pts[0]) });
        fx.shake(0.08);
        break;
      case "explosion":
        fx.explosion(e.x, e.y, e.r, e.big, e.land);
        audio.play(e.big ? "explosion_big" : "explosion", { pan: pan(e.x) });
        hitStop = Math.max(hitStop, e.big ? 0.07 : 0.045);
        break;
      case "hit": {
        const d = duckBySeat(world, e.seat);
        if (e.shield) {
          fx.ring(e.x, e.y, 26, 40, 0.25, 3, "160,235,255");
          if (time - lastHitSfx > 0.05) { lastHitSfx = time; audio.play("shield_hit", { pan: pan(e.x) }); }
        } else {
          if (e.dmg >= 5) { fx.feathers(e.x, e.y, e.dmg > 25 ? 5 : 2, d ? d.color : 0); fx.sparks(e.x, e.y, 3, "255,255,255", 200); }
          if (time - lastHitSfx > 0.05 && e.dmg >= 4) { lastHitSfx = time; audio.play("hit", { pan: pan(e.x), vol: Math.min(1, 0.5 + e.dmg / 40) }); }
          if (e.dmg >= 20) { fx.shake(0.14); hitStop = Math.max(hitStop, 0.03); }
          const pop = dmgPop[e.seat] || (dmgPop[e.seat] = { v: 0, t: 0 });
          pop.v += e.dmg;
        }
        vibe(e.seat, VIBE.HIT);
        break;
      }
      case "shieldPop":
        fx.ring(e.x, e.y, 20, 70, 0.45, 4, "160,235,255"); fx.splash(e.x, e.y, 10, 0.9, "190,240,255");
        audio.play("shield_pop", { pan: pan(e.x) });
        break;
      case "death": {
        const d = duckBySeat(world, e.seat);
        const k = e.by >= 0 ? duckBySeat(world, e.by) : null;
        fx.feathers(e.x, e.y, 28, d ? d.color : 0);
        fx.splash(e.x, e.y, 22, 1.3);
        fx.ring(e.x, e.y, 10, 90, 0.6, 5); fx.ring(e.x, e.y, 6, 130, 0.9, 2.5);
        fx.flash(e.x, e.y, 60, "255,255,255", 0.14);
        fx.text(e.x, e.y - 30, "SPLASH!", d ? COLORS[d.color].light : "#ffffff", 30, 1.1);
        fx.shake(0.5); fx.punch(0.02);
        hitStop = Math.max(hitStop, 0.09);
        audio.play("death", { pan: pan(e.x), rate: d ? 0.85 + (d.seat % 5) * 0.08 : 1 });
        let icon = "✖";
        if (e.w === -3) icon = "☠";
        pushFeed({ a: k ? k.name : "", ca: k ? k.color : 0, b: d ? d.name : "?", cb: d ? d.color : 0, w: k && e.w >= 0 ? e.w : -1, icon: icon });
        vibe(e.seat, VIBE.DIE);
        if (k) { vibe(k.seat, VIBE.KILL); toPhone(k.seat, { t: "You splashed " + (d ? d.name : "someone") + "!" }); }
        if (d) toPhone(d.seat, { t: k ? "Splashed by " + k.name : "You sank yourself" });
        if (match && match.mode === "lms") {
          const left = aliveCount(world);
          if (left === 2) setBanner("DUCK DUEL!", "", "#ffd23f", 1.3, 90, 300);
        }
        break;
      }
      case "streak": {
        const d = duckBySeat(world, e.seat);
        const txt = e.n === 2 ? "DOUBLE SPLASH!" : (e.n === 3 ? "TRIPLE SPLASH!" : "QUACKPOCALYPSE!");
        setBanner(txt, d ? d.name : "", d ? COLORS[d.color].body : "#ffffff", 1.6, 84, 300);
        break;
      }
      case "respawn":
        fx.ring(e.x, e.y, 60, 20, 0.4, 4); fx.splash(e.x, e.y, 10, 0.9);
        audio.play("respawn", { pan: pan(e.x), vol: 0.7 });
        break;
      case "dive":
        fx.splash(e.x, e.y, 9, 0.8); fx.ring(e.x, e.y, 12, 44, 0.5, 3);
        audio.play("dive", { pan: pan(e.x), vol: 0.8 });
        break;
      case "surface":
        fx.splash(e.x, e.y, 16, 1.1); fx.ring(e.x, e.y, 10, 58, 0.55, 4); fx.ring(e.x, e.y, 6, 80, 0.8, 2);
        audio.play("surface", { pan: pan(e.x), vol: 0.8 });
        break;
      case "pickup": {
        const d = duckBySeat(world, e.seat);
        fx.ring(e.x, e.y, 14, 52, 0.4, 4, "255,240,170");
        fx.sparks(e.x, e.y, 8, "255,240,170", 240);
        let label = "+40", color = "#b9f6a5", sfx = "pickup_bread";
        if (e.kind === "w") { label = WEAPONS[e.w].name; color = WEAPONS[e.w].color; sfx = "pickup_weapon"; }
        else if (e.kind === "shield") { label = "SHIELD"; color = "#8fe3ff"; sfx = "pickup_power"; }
        else if (e.kind === "turbo") { label = "TURBO"; color = "#ffe14a"; sfx = "pickup_power"; }
        fx.text(e.x, e.y - 34, label, color, 22, 1.2);
        audio.play(sfx, { pan: pan(e.x) });
        if (d) vibe(d.seat, VIBE.PICKUP);
        break;
      }
      case "crateLand":
        fx.splash(e.x, e.y, 12, 0.9); fx.ring(e.x, e.y, 10, 54, 0.6, 3);
        audio.play("crate_land", { pan: pan(e.x), vol: 0.7 });
        break;
      case "impact":
        if (e.land) fx.sparks(e.x, e.y, 3, "255,244,214", 150);
        else { fx.ring(e.x, e.y, 2, 14, 0.35, 1.6); fx.splash(e.x, e.y, 2, 0.5); }
        break;
      case "bounce":
        fx.ring(e.x, e.y, 3, 20, 0.3, 2); fx.sparks(e.x, e.y, 4, "230,235,240", 180);
        audio.play("bounce", { pan: pan(e.x), vol: 0.7 });
        break;
      case "bump":
        fx.splash(e.x, e.y, 6, 0.7);
        audio.play("splash_small", { pan: pan(e.x), vol: 0.6 });
        break;
      case "mineDrop":
        fx.ring(e.x, e.y, 4, 30, 0.4, 2.5); fx.splash(e.x, e.y, 5, 0.6);
        audio.play("mine_drop", { pan: pan(e.x) });
        break;
      case "mineArm":
        fx.ring(e.x, e.y, 6, 52, 0.35, 2, "255,80,110");
        audio.play("mine_beep", { pan: pan(e.x) });
        break;
      case "quack": {
        const d = duckBySeat(world, e.seat);
        fx.text(e.x + 18, e.y - 46, "QUACK!", d ? COLORS[d.color].light : "#ffffff", 18, 0.7);
        fx.ring(e.x, e.y, 22, 40, 0.3, 2);
        audio.quack({ pitch: 0.78 + (e.seat % 8) * 0.085, pan: pan(e.x), vol: world.passive || !d || !d.isBot ? 1 : 0.45 });
        break;
      }
      case "boo":
        fx.ring(e.x, e.y, 20, 105, 0.45, 5, "220,230,255");
        fx.text(e.x, e.y - 40, "BOO!", "#dfe6ff", 24, 0.8);
        audio.quack({ pitch: 0.55, pan: pan(e.x), vol: 0.8 });
        break;
      case "countdown":
        setBanner("" + e.n, e.n === 3 ? "Get ready..." : "", "#ffffff", 0.85, 170, 400);
        audio.play("countdown");
        break;
      case "go":
        setBanner("QUACK!", "", "#ffd23f", 1.0, 170, 400);
        audio.play("go");
        for (let s = 0; s < seats.length; s++) vibe(s, VIBE.START);
        break;
      case "zone":
        setBanner("PIRANHAS!", "Stay inside the ring", "#ff5964", 2.4, 100, 300);
        audio.play("sudden");
        audio.setMusic("sudden");
        break;
      case "overtime":
        setBanner("OVERTIME!", "Next splash wins", "#ff5964", 2.4, 100, 300);
        audio.play("sudden");
        audio.setMusic("sudden");
        break;
      case "nibble":
        fx.fish(e.x + (Math.random() - 0.5) * 30, e.y + (Math.random() - 0.5) * 20);
        fx.splash(e.x, e.y, 4, 0.6, "255,170,180");
        audio.play("nibble", { pan: pan(e.x), vol: 0.7 });
        break;
      case "burn": {
        const d = duckBySeat(world, e.seat);
        if (d) fx.text(d.x, d.y - 40, "HOT! DIVE!", "#ffb347", 20, 0.9);
        audio.play("burn");
        break;
      }
      case "loafGrab": {
        const d = duckBySeat(world, e.seat);
        fx.ring(e.x, e.y, 14, 70, 0.5, 5, "255,214,60");
        fx.sparks(e.x, e.y, 12, "255,230,120", 280);
        if (d) { pushFeed({ a: "", ca: 0, b: d.name + " has the loaf", cb: d.color, w: -1, icon: "★" }); toPhone(d.seat, { t: "You have the loaf. Run!" }); vibe(d.seat, VIBE.PICKUP); }
        audio.play("pickup_power", { pan: pan(e.x) });
        break;
      }
      case "loafDrop":
        fx.splash(e.x, e.y, 10, 1, "255,230,120");
        audio.play("splash_big", { pan: pan(e.x), vol: 0.7 });
        break;
      case "loafTick":
        fx.text(e.x, e.y - 52, "+1", "#ffe14a", 20, 0.7);
        audio.play("bread_tick", { pan: pan(e.x), vol: 0.6 });
        break;
      case "empty":
        fx.text(e.x, e.y - 36, "EMPTY", "#cfd6e4", 16, 0.7);
        audio.play("empty", { pan: pan(e.x) });
        break;
      case "crateDrop":
        break;
      case "over":
        onRoundOver(e.winner);
        break;
      default: break;
    }
  }
  ev.length = 0;
}

// ---- controller status (hp, weapon, ammo...) -------------------------------------------------
function sendStatus() {
  if (state !== "MATCH" || !world) return;
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i];
    if (!s || !s.connected) continue;
    const d = duckBySeat(world, i);
    let arr;
    if (!d) arr = [0, 0, 0, 0, 0, 0, 0];
    else {
      const life = d.alive ? 1 : (d.ghost ? 2 : 0);
      arr = [Math.max(0, Math.ceil(d.hp)), d.weapon, d.ammo, life, d.alive ? 0 : Math.ceil(d.respawn), d.shield > 0 ? 1 : 0,
        world.loaf && world.loaf.holder === i ? 1 : 0, d.diveCd > 0 || d.dive > 0 ? 1 : 0];
    }
    const key = arr.join(",");
    if (key === s.statusKey) continue;
    const urgent = s.statusKey.split(",")[3] !== String(arr[3]);
    if (!urgent && time - s.statusT < 0.1) continue;
    s.statusKey = key; s.statusT = time;
    airconsole.message(s.id, { s: arr });
  }
}

// ---- HUD model -------------------------------------------------------------------------------
function buildHud() {
  if (state !== "MATCH" || !world || !match) return { banner: banner };
  const scores = [];
  let top = -1;
  for (let i = 0; i < world.ducks.length; i++) {
    const d = world.ducks[i];
    const sc = match.mode === "lms" ? recFor(keyOfDuck(d)).wins : d.score;
    if (sc > top) top = sc;
    scores.push({ seat: d.seat, name: d.name, color: d.color, hat: d.hat, score: sc, out: !d.alive, lead: false });
  }
  scores.sort(function (a, b) { return a.seat - b.seat; });
  for (let i = 0; i < scores.length; i++) scores[i].lead = top > 0 && scores[i].score === top;
  let info = "", hot = false;
  if (match.mode === "lms") {
    info = "Round " + match.round + "  ·  first to " + match.goal + "  ·  " + aliveCount(world) + " afloat";
    if (world.zone && world.zone.active) { info = "PIRANHAS CLOSING IN  ·  " + aliveCount(world) + " afloat"; hot = true; }
  } else if (match.mode === "dm") {
    const t = Math.ceil(world.timeLeft);
    info = world.overtime ? "OVERTIME  ·  next splash wins" : Math.floor(t / 60) + ":" + ("0" + (t % 60)).slice(-2);
    hot = world.overtime || t <= 10;
  } else {
    info = "Golden Loaf  ·  first to " + match.goal;
  }
  return { scores: scores, info: info, infoHot: hot, feed: feed, banner: banner };
}

// ---- AirConsole callbacks --------------------------------------------------------------------
function onControllerJoin(deviceId) {
  requestSave(deviceId);
  let si = seatOf(deviceId);
  if (si >= 0) {
    // A phone we already know: it gets its duck back.
    const s = seats[si];
    const was = s.connected;
    s.connected = true; s.dive = undefined; s.quack = undefined; s.statusKey = "";
    if (state === "MATCH" && world && !was) {
      const d = duckBySeat(world, si);
      if (d && d.deviceId === deviceId) { setBot(world, si, false); ui.toast(nick(deviceId) + " is back!", si); }
    }
  } else {
    si = takeSeat(deviceId);
    if (si < 0) { publish(); return; }                 // pond is full; the phone shows it
    audio.play("join");
    if (state === "MATCH" && world && match) {
      if (match.phase === "play" && match.mode !== "lms") {
        // Respawn modes welcome late ducks straight away.
        const s = seats[si];
        const d = addDuck(world, { seat: si, name: nick(deviceId), color: si, hat: s.hat, bot: false, deviceId: deviceId });
        d.invuln = 2; d.spawnT = 0.5;
        match.names[keyOfDuck(d)] = { name: d.name, seat: si, hat: s.hat, bot: false };
        recFor(keyOfDuck(d));
        fx.splash(d.x, d.y, 16, 1.1); fx.ring(d.x, d.y, 8, 70, 0.6, 4);
        ui.toast(nick(deviceId) + " dives in!", si);
      } else {
        ui.toast(nick(deviceId) + " joins next round", si);
      }
    }
  }
  if (state === "LOBBY") { syncLobbyWorld(); renderLobby(); }
  publish();
}

function onControllerLeave(deviceId) {
  const si = seatOf(deviceId);
  if (si < 0) { if (state === "LOBBY") renderLobby(); return; }
  const name = nick(deviceId);
  audio.play("leave");
  if (state === "LOBBY") {
    seats[si] = null;
    seatWaiting();
    syncLobbyWorld(); renderLobby();
  } else if (state === "MATCH") {
    seats[si].connected = false;
    if (!humanSeats().length) { enterLobby(); return; }       // nobody left to play
    const d = world ? duckBySeat(world, si) : null;
    if (d) { setBot(world, si, true, cfg.diff); ui.toast(name + " left. A bot takes the oars.", si); }
    else seats[si] = null;
  } else {
    seats[si] = null;
    seatWaiting();
    if (!humanSeats().length) { enterLobby(); return; }
    if (results) {
      const master = airconsole.getMasterControllerDeviceId();
      results.view.hint = master !== undefined ? [{ t: nick(master), b: true }, { t: ": rematch or back to the lobby" }] : [{ t: "Back to the lobby soon..." }];
      ui.results(results.view);
    }
  }
  publish();
}

airconsole.onReady = function () {
  ready = true;
  audio.unlock();
  const ids = airconsole.getControllerDeviceIds();
  for (let i = 0; i < ids.length; i++) requestSave(ids[i]);
  // onConnect already fired for phones that were here first; enterLobby() seats them.
  const boot = function () { enterLobby(); };
  // Wait for the fonts so the first canvas text is not drawn in a fallback face.
  if (document.fonts && document.fonts.load) {
    let done = false;
    const go = function () { if (!done) { done = true; boot(); } };
    Promise.all([document.fonts.load("20px 'Lilita One'"), document.fonts.load("600 20px 'Fredoka'")]).then(go, go);
    setTimeout(go, 1500);
  } else boot();
};

airconsole.onConnect = function (deviceId) {
  if (state === "LOADING") return;          // boot() seats everyone who is already here
  onControllerJoin(deviceId);
};
airconsole.onDisconnect = function (deviceId) {
  if (state === "LOADING") return;
  onControllerLeave(deviceId);
};
airconsole.onDeviceProfileChange = function () { if (state === "LOBBY") { syncLobbyWorld(); renderLobby(); } };
airconsole.onPremium = function () { if (state === "LOBBY") renderLobby(); publish(); };

airconsole.onPersistentDataLoaded = function (data) {
  if (!data) return;
  for (const uid in data) {
    if (!data[uid] || !data[uid].save) continue;        // nothing saved yet for this player
    saves[uid] = sanitizeSave(data[uid].save);
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      if (s && s.uid === uid && !s.hatTouched) {
        s.hat = saves[uid].hat;
        if (state === "LOBBY") { syncLobbyWorld(); renderLobby(); }
        publish();
      }
    }
  }
};

airconsole.onMessage = function (from, data) {
  if (!data || from === AirConsole.SCREEN) return;
  audio.unlock();
  if (paused || adShowing) return;                 // input never changes state while paused
  const si = seatOf(from);
  if (data.i && si >= 0) {
    const s = seats[si];
    const a = data.i;
    const d = world ? duckBySeat(world, si) : null;
    const diveTap = s.dive !== undefined && a[3] !== s.dive;
    const quackTap = s.quack !== undefined && a[4] !== s.quack;
    s.dive = a[3]; s.quack = a[4];
    if (!d) return;
    if (state === "MATCH" && !d.isBot) {
      d.input.mx = clamp((a[0] || 0) / 100, -1, 1);
      d.input.my = clamp((a[1] || 0) / 100, -1, 1);
      d.input.fire = !!(a[2] & INPUT_FIRE);
      if (diveTap) d.input.dive = true;
    }
    if (quackTap) d.input.quack = true;
    return;
  }
  if (data.m === "hat" && si >= 0 && state === "LOBBY") {
    const s = seats[si];
    s.hat = (s.hat + (data.d > 0 ? 1 : HATS.length - 1)) % HATS.length;
    s.hatTouched = true;
    audio.play("ui_move");
    syncLobbyWorld(); renderLobby(); publish();
    clearTimeout(s.saveTimer);
    s.saveTimer = setTimeout(function () { storeSave(si); }, 1500);
    return;
  }
  if (data.m === "quack" && si >= 0 && world) {
    const d = duckBySeat(world, si);
    if (d) d.input.quack = true;
    return;
  }
  // Everything below is menu control: master controller only.
  if (from !== airconsole.getMasterControllerDeviceId()) return;
  if (data.m === "cfg" && state === "LOBBY") {
    const step = data.d > 0 ? 1 : -1;
    if (data.k === "mode") { cfg.mode = (cfg.mode + step + MODES.length) % MODES.length; cfg.goal = MODES[cfg.mode].goalDefault; }
    else if (data.k === "map") {
      cfg.map = (cfg.map + step + MAPS.length) % MAPS.length;
      const mapId = cfg.map === 0 ? "lagoon" : MAPS[cfg.map].id;
      if (world.map.id !== mapId) { fx.clear(); world = createWorld({ map: useMap(mapId), mode: "lobby", seed: (Math.random() * 1e9) | 0, ducks: lobbyRoster() }); }
    }
    else if (data.k === "goal") { const n = MODES[cfg.mode].goals.length; cfg.goal = (cfg.goal + step + n) % n; }
    else if (data.k === "bots") { cfg.bots = (cfg.bots + step + MAX_PLAYERS) % MAX_PLAYERS; }
    else if (data.k === "diff") { cfg.diff = (cfg.diff + step + DIFFICULTIES.length) % DIFFICULTIES.length; }
    audio.play("ui_move");
    syncLobbyWorld(); renderLobby(); publish();
  } else if (data.m === "start" && state === "LOBBY") {
    if (humanSeats().length >= 1 && seatOf(from) >= 0) { audio.play("ui_select"); startMatch(); }
  } else if (data.m === "rematch" && state === "RESULTS") {
    audio.play("ui_select"); leaveResults("rematch");
  } else if (data.m === "lobby" && state === "RESULTS") {
    audio.play("ui_select"); leaveResults("lobby");
  }
};

// Pause, resume and ad breaks: freeze the simulation and mute everything. Idempotent.
function applyPause() {
  const p = paused || adShowing;
  audio.setPaused(p);
  if (!p) lastFrame = null;
}
airconsole.onPause = function () { paused = true; applyPause(); };
airconsole.onResume = function () { paused = false; applyPause(); };
airconsole.onAdShow = function () { adShowing = true; applyPause(); };
airconsole.onAdComplete = function () {
  adShowing = false; applyPause();
  afterAd();
};
airconsole.onSetSafeArea = function (a) {
  if (!a) return;
  let left = a.left || 0, top = a.top || 0, right = a.right, bottom = a.bottom;
  if (right === undefined || right <= left) right = 1 - (right || 0);
  if (bottom === undefined || bottom <= top) bottom = 1 - (bottom || 0);
  renderer.setSafeArea({ left: left, top: top, right: right, bottom: bottom });
  const o = document.querySelectorAll(".overlay, #toasts");
  for (let i = 0; i < o.length; i++) {
    o[i].style.left = (left * 100) + "%"; o[i].style.top = (top * 100) + "%";
    o[i].style.right = ((1 - right) * 100) + "%"; o[i].style.bottom = ((1 - bottom) * 100) + "%";
  }
};

// Browsers keep audio suspended until a gesture reaches the page.
["pointerdown", "keydown", "touchstart", "mousedown"].forEach(function (n) {
  window.addEventListener(n, function () { audio.unlock(); }, { passive: true });
});
window.addEventListener("resize", function () { renderer.resize(); needsPaint = true; });

// ---- main loop -------------------------------------------------------------------------------
function frame(now) {
  window.requestAnimationFrame(frame);
  if (lastFrame === null) lastFrame = now;
  const realDt = Math.min((now - lastFrame) / 1000, 1 / 20);     // a suspended tab must not jump
  lastFrame = now;
  if (state === "LOADING") return;
  if (paused || adShowing) {                                      // frozen picture, silent
    // Paused before the first frame (pause-on-start) or resized while paused: paint once.
    if (needsPaint && world) {
      needsPaint = false;
      renderer.draw(world, { alpha: 0, time: time, hud: buildHud(), dim: state === "RESULTS" ? 0.45 : (state === "LOBBY" ? 0.12 : 0) });
    }
    return;
  }
  needsPaint = false;

  time += realDt;
  if (publishT > 0) publishT -= realDt;
  if (publishDirty && publishT <= 0) publishNow();

  // The ad safety net: if the platform never answered showAd(), carry on.
  if (pendingAfterAd) { adTimer -= realDt; if (adTimer <= 0) afterAd(); }

  // time scale: hit-stop (tiny freeze on big hits) and slow motion on the deciding splash
  let scale = timeScale;
  if (slowT > 0) { slowT -= realDt; if (slowT <= 0) { timeScale = 1; fx.unfocus(); } }
  if (hitStop > 0) { hitStop -= realDt; scale = 0.05; }
  const dt = realDt * scale;

  if (world) {
    acc += dt;
    let steps = 0;
    while (acc >= TICK && steps < 5) {
      stepWorld(world, TICK);
      handleEvents();
      acc -= TICK; steps++;
      if (!world) break;
    }
    if (steps === 5) acc = 0;
  }

  if (state === "MATCH" && match) {
    if (match.phase === "roundEnd") {
      match.phaseT -= realDt;
      if (match.phaseT <= 0) {
        if (match.decided) enterResults(); else startRound();
      }
    } else if (match.mode !== "lms" && world && world.phase === "play") {
      // Respawn modes: briefly lift the silence every so often so late phones can dive in.
      match.pulseT -= realDt;
      if (match.pulseT <= 0) {
        match.pulseT = 15;
        airconsole.setActivePlayers(0);
        airconsole.setActivePlayers();
      }
    }
  } else if (state === "RESULTS") {
    resultsT += realDt;
    if (resultsT > 45 && !pendingAfterAd) leaveResults("lobby");
    if (Math.random() < realDt * 1.5) fx.confetti(100 + Math.random() * 1400, 820, 26);
  }

  // floating damage numbers, batched so a flamethrower does not print a wall of digits
  for (const k in dmgPop) {
    const p = dmgPop[k];
    p.t -= realDt;
    if (p.v >= 1 && p.t <= 0 && world) {
      const d = duckBySeat(world, Number(k));
      if (d) fx.text(d.x + (Math.random() - 0.5) * 16, d.y - 58, "-" + Math.round(p.v), p.v >= 30 ? "#ff8a8a" : "#ffffff", p.v >= 30 ? 24 : 17, 0.7);
      p.v = 0; p.t = 0.22;
    }
  }
  for (const k in flameT) {
    if (time - flameT[k] > 0.12) { audio.loop("flame" + k, "flame", false); delete flameT[k]; }
  }

  sendStatus();
  fx.update(dt, realDt);
  renderer.update(world, dt, time);
  renderer.draw(world, { alpha: acc / TICK, time: time, hud: buildHud(), dim: state === "RESULTS" ? 0.45 : (state === "LOBBY" ? 0.12 : 0) });

  // Drop the expensive water effects on machines that cannot hold 30 fps.
  perfT += realDt; perfFrames++;
  if (perfT >= 2) {
    const fps = perfFrames / perfT;
    perfSlow = fps < 34 ? perfSlow + 1 : 0;
    if (perfSlow >= 2 && renderer.getQuality() > 0 && !qualityLock) renderer.setQuality(0);
    perfT = 0; perfFrames = 0;
  }
}

renderer.resize();
window.requestAnimationFrame(frame);

// Small hook for the automated tests in /tests (read only).
window.__duckwars = {
  get state() { return state; },
  get world() { return world; },
  get match() { return match; },
  get seats() { return seats; },
  get cfg() { return cfg; },
  get paused() { return paused || adShowing; },
  get time() { return time; },
  get banner() { return banner; },
  get bakeMs() { return renderer.bakeMs(); },
  lockQuality: function (q) { qualityLock = true; renderer.setQuality(q); },
  fx: fx
};
