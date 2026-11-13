// Phone controller. It never decides anything: it sends intent (stick, fire, dive, quack, menu
// taps) and draws whatever the screen's published state says, so a phone that reloads or
// reconnects recovers on its own.
import { COLORS, HATS, MODES, MAPS, DIFFICULTIES, WEAPONS, MAX_PLAYERS, VIBE, INPUT_FIRE } from "../shared/config.js";
import { drawDuck, drawWeaponIcon } from "../shared/duckart.js";

/* global AirConsole */
const airconsole = new AirConsole({ orientation: AirConsole.ORIENTATION_LANDSCAPE });

function $(id) { return document.getElementById(id); }

let ready = false;
let screenState = null;          // last custom device state from the screen
let view = "CONNECT";
let mySeat = -1, myHat = 0;
let status = [100, 0, 0, 1, 0, 0, 0, 0];      // hp, weapon, ammo, life, cd, shield, loaf, diveBusy
let toastTimer = 0;

// ---- input state, sent whole so a delayed packet can never leave the screen stuck ---------------
const input = { x: 0, y: 0, bits: 0, dive: 0, quack: 0 };
let lastSent = "", lastSendT = 0, sendTimer = 0;
const MIN_GAP = 45;              // ms between packets: ~22 per second, under the limit of 25

function sendInput() {
  if (!ready) return;
  const packet = [input.x, input.y, input.bits, input.dive, input.quack];
  const key = packet.join(",");
  if (key === lastSent) return;
  const now = Date.now();
  const wait = MIN_GAP - (now - lastSendT);
  if (wait > 0) {
    if (!sendTimer) sendTimer = setTimeout(function () { sendTimer = 0; sendInput(); }, wait);
    return;
  }
  lastSent = key; lastSendT = now;
  airconsole.message(AirConsole.SCREEN, { i: packet });
}
function menu(msg) { if (ready) airconsole.message(AirConsole.SCREEN, msg); }
function tick(ms) { try { airconsole.vibrate(ms || 12); } catch (e) { /* no haptics */ } }

// ---- views ---------------------------------------------------------------------------------------
function showView(name) {
  if (view === name) return;
  view = name;
  const views = document.querySelectorAll(".view");
  for (let i = 0; i < views.length; i++) views[i].classList.toggle("active", views[i].id === "view-" + name);
  if (name !== "GAME") { input.x = 0; input.y = 0; input.bits = 0; releaseStick(); }
}

function isMaster() { return airconsole.getDeviceId() === airconsole.getMasterControllerDeviceId(); }
function myName() { return airconsole.getNickname(airconsole.getDeviceId()) || "Duck"; }

function setColor(seat) {
  const c = COLORS[seat % COLORS.length];
  const st = document.documentElement.style;
  st.setProperty("--pc", c.body); st.setProperty("--pcd", c.dark); st.setProperty("--pcl", c.light);
}

function drawAvatar(canvas, seat, hat, mood, weapon) {
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const s = canvas.height / 58;
  ctx.translate(canvas.width * 0.42, canvas.height * 0.54);
  ctx.scale(s, s);
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath(); ctx.ellipse(3, 8, 26, 17, 0, 0, Math.PI * 2); ctx.fill();
  drawDuck(ctx, { color: seat, hat: hat, facing: -0.2, aim: -0.2, mood: mood || "normal", weapon: weapon === undefined ? -1 : weapon, moving: 0, t: 1 });
}

function goalText(mode, goalIndex) {
  const m = MODES[mode], g = m.goals[goalIndex];
  if (m.goalUnit === "time") return Math.floor(g / 60) + ":" + ("0" + (g % 60)).slice(-2);
  return "First to " + g;
}

let avatarKey = "";
function render() {
  if (!ready) return;
  if (!screenState) { showView("CONNECT"); return; }
  const me = airconsole.getDeviceId();
  const seatInfo = screenState.seats && screenState.seats[me];
  const seated = !!seatInfo;
  const seatCount = screenState.seats ? Object.keys(screenState.seats).length : 0;
  if (seated) {
    if (seatInfo[0] !== mySeat) { mySeat = seatInfo[0]; setColor(mySeat); }
    myHat = seatInfo[1];
  }
  const v = screenState.view || "LOBBY";

  if (!seated) {
    // No seat: either the pond is full, or a battle is running and we wait for the next round.
    $("wait-text").textContent = seatCount >= MAX_PLAYERS
      ? "The pond is full. You get a seat as soon as one frees up."
      : (v === "GAME" ? "Battle in progress. You dive in as soon as there is an opening!" : "Paddling to the pond...");
    showView("WAIT");
    return;
  }

  const key = mySeat + ":" + myHat;
  if (key !== avatarKey) {
    avatarKey = key;
    drawAvatar($("lobby-duck"), mySeat, myHat, "happy");
    drawAvatar($("game-duck"), mySeat, myHat, "normal");
  }

  if (v === "LOBBY") {
    const cfg = screenState.cfg || [0, 0, 0, 0, 1];
    $("lobby-name").textContent = myName();
    $("hat-name").textContent = HATS[myHat] ? HATS[myHat].name : "";
    const master = isMaster();
    $("host-panel").classList.toggle("on", master);
    $("guest-panel").classList.toggle("on", !master);
    const mode = MODES[cfg[0]] || MODES[0];
    if (master) {
      $("c-mode").textContent = mode.name;
      $("c-map").textContent = MAPS[cfg[1]] ? MAPS[cfg[1]].name : "";
      $("c-goal-label").textContent = mode.goalUnit === "time" ? "Length" : "Goal";
      $("c-goal").textContent = goalText(cfg[0], cfg[2]);
      $("c-bots").textContent = "" + screenState.bots;
      $("c-diff").textContent = DIFFICULTIES[cfg[4]];
    } else {
      const masterId = airconsole.getMasterControllerDeviceId();
      $("guest-text").textContent = masterId === undefined ? "Waiting for the host..." : "Waiting for " + airconsole.getNickname(masterId) + " to start";
      $("guest-summary").textContent = mode.name + "  ·  " + (MAPS[cfg[1]] ? MAPS[cfg[1]].name : "") + "  ·  " + goalText(cfg[0], cfg[2]);
    }
    showView("LOBBY");
  } else if (v === "GAME") {
    $("game-name").textContent = myName();
    showView("GAME");
    renderStatus();
  } else if (v === "RESULTS") {
    const res = screenState.res || { r: {} };
    const mine = res.r && res.r[me];
    $("res-place").textContent = mine ? ["1st", "2nd", "3rd"][mine[0] - 1] || mine[0] + "th" : "";
    $("res-text").textContent = mine && mine[0] === 1 ? "You rule the pond!" : (res.w ? res.w + " rules the pond" : "Match over");
    const master = isMaster();
    $("res-buttons").classList.toggle("on", master);
    const masterId = airconsole.getMasterControllerDeviceId();
    $("res-wait").textContent = master ? "" : (masterId === undefined ? "" : airconsole.getNickname(masterId) + " picks what happens next");
    showView("RESULTS");
  }
}

let weaponDrawn = -1;
function renderStatus() {
  const hp = status[0], weapon = status[1], ammo = status[2], life = status[3], cd = status[4];
  const fill = $("hp-fill");
  fill.style.width = Math.max(0, Math.min(100, hp)) + "%";
  fill.style.backgroundColor = hp > 55 ? "#6be36b" : (hp > 28 ? "#ffd23f" : "#ff5964");
  fill.parentNode.classList.toggle("shield", !!status[5]);
  const w = WEAPONS[weapon] || WEAPONS[0];
  $("weapon-name").textContent = w.name;
  $("weapon-ammo").textContent = weapon === 0 ? "∞" : "x" + ammo;
  if (weaponDrawn !== weapon) {
    weaponDrawn = weapon;
    const c = $("weapon-icon"), ctx = c.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
    ctx.translate(c.width / 2, c.height / 2);
    drawWeaponIcon(ctx, weapon, 1.7);
  }
  const fire = $("fire"), dive = $("dive"), banner = $("game-banner");
  const ghost = life === 2;
  fire.textContent = ghost ? "BOO!" : "FIRE";
  fire.classList.toggle("boo", ghost);
  fire.classList.toggle("off", life === 0);
  dive.classList.toggle("off", life !== 1 || !!status[6] || !!status[7]);
  dive.textContent = status[6] ? "NO DIVING" : "DIVE";
  let text = "";
  if (life === 0) text = cd > 0 ? "Splashed! Back in " + cd + "..." : (screenState && screenState.late ? "You dive in next round" : "Get ready...");
  else if (ghost) text = "You are a ghost. BOO the living!";
  else if (status[6]) text = "You have the loaf. RUN!";
  banner.textContent = text;
  banner.classList.toggle("on", !!text);
}

function toast(text) {
  const t = $("game-toast");
  t.textContent = text;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove("on"); }, 2200);
}

// ---- AirConsole callbacks (assigned right away) ----------------------------------------------------
airconsole.onReady = function () { ready = true; render(); };
airconsole.onCustomDeviceStateChange = function (deviceId, data) {
  if (deviceId === AirConsole.SCREEN) { screenState = data; render(); }
};
airconsole.onActivePlayersChange = function () { render(); };
airconsole.onConnect = airconsole.onDisconnect = airconsole.onPremium = function () { render(); };
airconsole.onDeviceProfileChange = function () { render(); };

airconsole.onMessage = function (from, data) {
  if (from !== AirConsole.SCREEN || !data) return;
  if (data.s) { status = data.s; if (view === "GAME") renderStatus(); }
  if (data.t) toast(String(data.t));
  if (data.v) {
    const V = AirConsole.VIBRATE;
    try {
      if (data.v === VIBE.HIT) airconsole.vibrate(40);
      else if (data.v === VIBE.DIE) airconsole.vibrate({ type: V.TYPE.COMPOSITION, value: [{ primitive: V.PRIMITIVE.THUD, scale: 1 }, { primitive: V.PRIMITIVE.QUICK_FALL, scale: 0.9, delay: 60 }] });
      else if (data.v === VIBE.PICKUP) airconsole.vibrate(25);
      else if (data.v === VIBE.KILL) airconsole.vibrate({ type: V.TYPE.COMPOSITION, value: [{ primitive: V.PRIMITIVE.QUICK_RISE, scale: 0.8 }, { primitive: V.PRIMITIVE.CLICK, scale: 1, delay: 40 }] });
      else if (data.v === VIBE.WIN) airconsole.vibrate(400);
      else if (data.v === VIBE.START) airconsole.vibrate(80);
    } catch (e) { /* vibration is never the only signal */ }
  }
};

// ---- buttons ---------------------------------------------------------------------------------------
// touchstart/touchend respond instantly; mouse events keep the desktop simulator usable.
function bindButton(el, onDown, onUp) {
  let touchId = null;
  function down(e) {
    if (e.type === "touchstart") { e.preventDefault(); if (touchId !== null) return; touchId = e.changedTouches[0].identifier; }
    el.classList.add("down");
    onDown();
  }
  function up(e) {
    if (e && e.changedTouches) {
      let mine = false;
      for (let i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].identifier === touchId) mine = true;
      if (!mine) return;
    }
    touchId = null;
    if (!el.classList.contains("down")) return;
    el.classList.remove("down");
    if (onUp) onUp();
  }
  el.addEventListener("touchstart", down, { passive: false });
  el.addEventListener("touchend", up);
  el.addEventListener("touchcancel", up);
  el.addEventListener("mousedown", down);
  el.addEventListener("mouseup", up);
  el.addEventListener("mouseleave", up);
}

bindButton($("fire"), function () { input.bits |= INPUT_FIRE; sendInput(); }, function () { input.bits &= ~INPUT_FIRE; sendInput(); });
bindButton($("dive"), function () { input.dive = (input.dive + 1) % 256; tick(15); sendInput(); });
bindButton($("quack"), function () { input.quack = (input.quack + 1) % 256; tick(10); sendInput(); });
bindButton($("lobby-quack"), function () { tick(10); menu({ m: "quack" }); });
bindButton($("hat-prev"), function () { tick(); menu({ m: "hat", d: -1 }); });
bindButton($("hat-next"), function () { tick(); menu({ m: "hat", d: 1 }); });
bindButton($("start"), function () { if (isMaster()) { tick(30); menu({ m: "start" }); } });
bindButton($("rematch"), function () { if (isMaster()) { tick(30); menu({ m: "rematch" }); } });
bindButton($("to-lobby"), function () { if (isMaster()) { tick(30); menu({ m: "lobby" }); } });
(function () {
  const rows = document.querySelectorAll(".set");
  for (let i = 0; i < rows.length; i++) {
    const k = rows[i].getAttribute("data-k");
    bindButton(rows[i].querySelector(".prev"), function () { if (isMaster()) { tick(); menu({ m: "cfg", k: k, d: -1 }); } });
    bindButton(rows[i].querySelector(".next"), function () { if (isMaster()) { tick(); menu({ m: "cfg", k: k, d: 1 }); } });
  }
})();

// ---- joystick: starts wherever the thumb lands, and the base follows if the thumb strays -----------
const zone = $("stick-zone"), base = $("stick-base"), knob = $("stick-knob");
let stickTouch = null, ox = 0, oy = 0, stickR = 60;

function placeStick(cx, cy, kx, ky) {
  const r = zone.getBoundingClientRect();
  base.style.left = (cx - r.left) + "px"; base.style.top = (cy - r.top) + "px";
  knob.style.transform = "translate(" + kx + "px," + ky + "px)";
}
function stickStart(x, y) {
  const r = zone.getBoundingClientRect();
  stickR = Math.max(34, Math.min(r.width, r.height) * 0.24);
  ox = x; oy = y;
  base.classList.add("live");
  placeStick(ox, oy, 0, 0);
}
function stickMove(x, y) {
  let dx = x - ox, dy = y - oy;
  const d = Math.hypot(dx, dy);
  if (d > stickR) {
    // drag the base along so the thumb never runs out of room
    ox += dx * (1 - stickR / d); oy += dy * (1 - stickR / d);
    dx = x - ox; dy = y - oy;
  }
  let nx = dx / stickR, ny = dy / stickR;
  const m = Math.hypot(nx, ny);
  if (m < 0.16) { nx = 0; ny = 0; }
  // quantised so tiny tremors do not spend the message budget
  input.x = Math.round(nx * 10) * 10; input.y = Math.round(ny * 10) * 10;
  placeStick(ox, oy, dx, dy);
  sendInput();
}
function releaseStick() {
  stickTouch = null;
  input.x = 0; input.y = 0;
  base.classList.remove("live");
  base.style.left = ""; base.style.top = "";
  knob.style.transform = "";
  sendInput();
}
zone.addEventListener("touchstart", function (e) {
  e.preventDefault();
  if (stickTouch !== null) return;
  const t = e.changedTouches[0];
  stickTouch = t.identifier;
  stickStart(t.clientX, t.clientY);
}, { passive: false });
zone.addEventListener("touchmove", function (e) {
  e.preventDefault();
  for (let i = 0; i < e.changedTouches.length; i++) {
    const t = e.changedTouches[i];
    if (t.identifier === stickTouch) stickMove(t.clientX, t.clientY);
  }
}, { passive: false });
function touchEnd(e) {
  for (let i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].identifier === stickTouch) releaseStick();
}
zone.addEventListener("touchend", touchEnd);
zone.addEventListener("touchcancel", touchEnd);
let mouseStick = false;
zone.addEventListener("mousedown", function (e) { mouseStick = true; stickStart(e.clientX, e.clientY); });
window.addEventListener("mousemove", function (e) { if (mouseStick) stickMove(e.clientX, e.clientY); });
window.addEventListener("mouseup", function () { if (mouseStick) { mouseStick = false; releaseStick(); } });

// ---- keyboard, for the desktop simulator: WASD / arrows, Space fire, Shift dive, Q quack -----------
const keys = {};
function applyKeys() {
  const x = (keys.ArrowRight || keys.KeyD ? 1 : 0) - (keys.ArrowLeft || keys.KeyA ? 1 : 0);
  const y = (keys.ArrowDown || keys.KeyS ? 1 : 0) - (keys.ArrowUp || keys.KeyW ? 1 : 0);
  const l = Math.hypot(x, y) || 1;
  input.x = Math.round(x / l * 10) * 10; input.y = Math.round(y / l * 10) * 10;
  if (keys.Space) input.bits |= INPUT_FIRE; else input.bits &= ~INPUT_FIRE;
  sendInput();
}
window.addEventListener("keydown", function (e) {
  if (e.repeat) return;
  if (view === "GAME") {
    if (e.code === "ShiftLeft" || e.code === "ShiftRight" || e.code === "KeyE") { input.dive = (input.dive + 1) % 256; sendInput(); return; }
    if (e.code === "KeyQ") { input.quack = (input.quack + 1) % 256; sendInput(); return; }
    keys[e.code] = true; applyKeys();
    if (e.code === "Space" || e.code.indexOf("Arrow") === 0) e.preventDefault();
  } else if (view === "LOBBY") {
    if (e.code === "Enter" && isMaster()) menu({ m: "start" });
    if (e.code === "KeyQ") menu({ m: "quack" });
    if (e.code === "ArrowLeft") menu({ m: "hat", d: -1 });
    if (e.code === "ArrowRight") menu({ m: "hat", d: 1 });
  } else if (view === "RESULTS" && isMaster()) {
    if (e.code === "Enter") menu({ m: "rematch" });
    if (e.code === "Escape") menu({ m: "lobby" });
  }
});
window.addEventListener("keyup", function (e) { if (keys[e.code]) { keys[e.code] = false; if (view === "GAME") applyKeys(); } });
window.addEventListener("blur", function () { for (const k in keys) keys[k] = false; if (view === "GAME") applyKeys(); });

// Test hook (read only).
window.__duckpad = { get view() { return view; }, get seat() { return mySeat; }, get status() { return status; }, input: input };
