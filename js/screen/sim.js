// The pond simulation. Pure logic: no DOM, no audio, no AirConsole. It consumes per-duck input
// and produces state plus a queue of events that the renderer, audio and controllers react to.
// Runs at a fixed 60 Hz step (see main.js) and in Node for the headless tests.
import { ARENA_W, ARENA_H, makeRng } from "./maps.js";
import { WEAPON_DEFS, WEAPON_WEIGHTS, weaponAmmo, normAngle } from "./weapons.js";
import { thinkBot, newBrain } from "./bots.js";

export const TICK = 1 / 60;
export const DUCK_R = 20;
export const MAX_HP = 100;
const SHORE_R = 24;               // ducks keep a little more room from the bank than from each other
const DIVE_TIME = 0.9;
const DIVE_COOLDOWN = 2.2;
const RESPAWN_TIME = 2.6;
const BASE_SPEED = 245;

const tmp = { x: 0, y: 0 };

// ---- world -------------------------------------------------------------------------------------
// opts: { map, mode: "lms"|"dm"|"loaf"|"lobby", goal, seed, countdown,
//         ducks: [{ seat, name, color, hat, bot, skill, deviceId }] }
export function createWorld(opts) {
  const world = {
    map: opts.map,
    mode: opts.mode,
    goal: opts.goal || 0,
    rng: makeRng(opts.seed || 1),
    time: 0,
    phase: opts.mode === "lobby" ? "play" : "countdown",   // countdown | play | over
    countdown: opts.countdown === undefined ? 5.2 : opts.countdown,   // the first 1.6 s show the pond's name
    lastCount: 9,
    ducks: [], bullets: [], pickups: [], mines: [], barrels: [], waves: [],
    events: [],
    zone: null,
    loaf: null,
    timeLeft: opts.mode === "dm" ? opts.goal : 0,
    overtime: false,
    winner: -1,
    pickupT: 2.2,
    barrelT: 16,
    nextId: 1,
    lastCrate: -1,
    passive: opts.mode === "lobby"
  };
  const list = opts.ducks || [];
  for (let i = 0; i < list.length; i++) addDuck(world, list[i]);
  if (!world.passive) {
    for (let i = 0; i < world.map.barrels.length; i++) {
      const b = world.map.barrels[i];
      world.barrels.push(newBarrel(world, b.x, b.y));
    }
  }
  if (world.mode === "lms") {
    const n = world.ducks.length;
    const c = pickZoneCenter(world);
    world.zone = { x: c.x, y: c.y, r: 1100, r0: 1100, r1: 120, delay: 16 + n * 3, dur: 42, active: false, tick: 0 };
  }
  if (world.mode === "loaf") {
    const c = pickZoneCenter(world);
    world.loaf = { x: c.x, y: c.y, vx: 0, vy: 0, holder: -1, lock: 0, tick: 0, idle: 0 };
  }
  return world;
}

function pickZoneCenter(world) {
  const map = world.map;
  let best = map.spawns[0] || { x: ARENA_W / 2, y: ARENA_H / 2 };
  let bs = -Infinity;
  for (let i = 0; i < map.openWater.length; i++) {
    const p = map.openWater[i];
    const s = map.depth(p.x, p.y) * 0.6 - Math.hypot(p.x - ARENA_W / 2, p.y - ARENA_H / 2) + world.rng() * 120;
    if (s > bs) { bs = s; best = p; }
  }
  return { x: best.x, y: best.y };
}

export function addDuck(world, info) {
  const spawn = pickSpawn(world, null);
  const duck = {
    seat: info.seat, name: info.name, color: info.color, hat: info.hat || 0,
    isBot: !!info.bot, skill: info.skill === undefined ? 1 : info.skill, deviceId: info.deviceId,
    x: spawn.x, y: spawn.y, px: spawn.x, py: spawn.y, vx: 0, vy: 0,
    facing: Math.atan2(ARENA_H / 2 - spawn.y, ARENA_W / 2 - spawn.x), aim: 0,
    hp: MAX_HP, alive: true, ghost: false, respawn: 0, invuln: 0,
    dive: 0, diveCd: 0,
    weapon: 0, ammo: 0, fireCd: 0,
    shield: 0, turbo: 0, burn: 0, burnBy: -1, burnTick: 0,
    inReeds: false, reveal: 0, hidden: false,
    input: { mx: 0, my: 0, fire: false, dive: false, quack: false },
    target: null, lastHitBy: -1, lastHitT: -99, lastHitW: 0,
    score: 0, kills: 0, deaths: 0, dmg: 0, dives: 0, crates: 0, loafTime: 0, streak: 0, multi: 0, multiT: 0,
    quackCd: 0, booCd: 0,
    // presentation helpers, advanced by the sim so they stay in step with it
    paddle: world.rng() * 6, flash: 0, kick: 0, wob: world.rng() * 6, spawnT: 0.5,
    brain: null
  };
  duck.aim = duck.facing;
  if (duck.isBot) duck.brain = newBrain(world, duck);
  world.ducks.push(duck);
  return duck;
}

export function removeDuck(world, seat) {
  for (let i = 0; i < world.ducks.length; i++) {
    if (world.ducks[i].seat === seat) {
      const d = world.ducks[i];
      if (world.loaf && world.loaf.holder === seat) dropLoaf(world, d);
      world.ducks.splice(i, 1);
      return d;
    }
  }
  return null;
}

export function duckBySeat(world, seat) {
  for (let i = 0; i < world.ducks.length; i++) if (world.ducks[i].seat === seat) return world.ducks[i];
  return null;
}

// Hand a duck to the AI (its player left) or back to a human.
export function setBot(world, seat, isBot, skill) {
  const d = duckBySeat(world, seat);
  if (!d) return;
  d.isBot = isBot;
  d.input.mx = 0; d.input.my = 0; d.input.fire = false;
  if (isBot) { d.skill = skill === undefined ? 1 : skill; d.brain = newBrain(world, d); } else { d.brain = null; }
}

function pickSpawn(world, forDuck) {
  const spawns = world.map.spawns;
  if (!spawns.length) return { x: ARENA_W / 2, y: ARENA_H / 2 };
  let best = spawns[0], bs = -Infinity;
  for (let i = 0; i < spawns.length; i++) {
    const s = spawns[i];
    let near = 1e9;
    for (let k = 0; k < world.ducks.length; k++) {
      const d = world.ducks[k];
      if (d === forDuck || !d.alive) continue;
      near = Math.min(near, Math.hypot(d.x - s.x, d.y - s.y));
    }
    for (let k = 0; k < world.mines.length; k++) {
      near = Math.min(near, Math.hypot(world.mines[k].x - s.x, world.mines[k].y - s.y) * 2);
    }
    let score = Math.min(near, 700) + world.rng() * 60;
    if (world.zone && world.zone.active && Math.hypot(s.x - world.zone.x, s.y - world.zone.y) > world.zone.r - 30) score -= 2000;
    if (score > bs) { bs = score; best = s; }
  }
  return best;
}

function emit(world, type, a) {
  const e = a || {};
  e.type = type;
  world.events.push(e);
}

function newBarrel(world, x, y) {
  return { id: world.nextId++, x: x, y: y, vx: 0, vy: 0, hp: 26, r: 17, fuse: -1, by: -1, fall: 0, wob: world.rng() * 6 };
}

// ---- helpers -----------------------------------------------------------------------------------
function segCircle(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1, dy = y2 - y1;
  const fx = x1 - cx, fy = y1 - cy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy;
  if (a < 1e-9) return -1;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}

function turnToward(a, b, max) {
  const d = normAngle(b - a);
  if (Math.abs(d) <= max) return b;
  return a + (d > 0 ? max : -max);
}

function isTargetable(d) { return d.alive && !d.ghost; }

// ---- damage ------------------------------------------------------------------------------------
export function damage(world, duck, amount, bySeat, wIdx, kx, ky) {
  if (!duck.alive || duck.ghost || duck.invuln > 0 || world.phase !== "play" || world.passive) return 0;
  duck.vx += kx || 0; duck.vy += ky || 0;
  duck.reveal = 1.0;
  let left = amount;
  if (duck.shield > 0) {
    const used = Math.min(duck.shield, left);
    duck.shield -= used; left -= used;
    emit(world, "hit", { seat: duck.seat, by: bySeat, x: duck.x, y: duck.y, dmg: used, shield: true });
    if (duck.shield <= 0) { duck.shield = 0; emit(world, "shieldPop", { seat: duck.seat, x: duck.x, y: duck.y }); }
    if (left <= 0) return 0;
  }
  duck.hp -= left;
  duck.flash = 0.12;
  if (bySeat >= 0 && bySeat !== duck.seat) {
    duck.lastHitBy = bySeat; duck.lastHitT = world.time; duck.lastHitW = wIdx;
    const src = duckBySeat(world, bySeat);
    if (src) src.dmg += left;
  }
  emit(world, "hit", { seat: duck.seat, by: bySeat, x: duck.x, y: duck.y, dmg: left, shield: false });
  if (duck.hp <= 0) {
    // A self-inflicted or environmental death still credits whoever hit this duck last.
    let killer = bySeat;
    let weapon = wIdx;
    if ((killer < 0 || killer === duck.seat) && world.time - duck.lastHitT < 5) { killer = duck.lastHitBy; weapon = duck.lastHitW; }
    kill(world, duck, killer, weapon);
  }
  return left;
}

function kill(world, duck, bySeat, wIdx) {
  duck.alive = false;
  duck.hp = 0;
  duck.deaths++;
  duck.burn = 0; duck.dive = 0; duck.shield = 0; duck.turbo = 0;
  duck.input.fire = false;
  duck.streak = 0;
  const killer = bySeat >= 0 && bySeat !== duck.seat ? duckBySeat(world, bySeat) : null;
  if (killer) {
    killer.kills++;
    killer.streak++;
    killer.multi = world.time - killer.multiT < 3.2 ? killer.multi + 1 : 1;
    killer.multiT = world.time;
    if (world.mode === "dm") killer.score++;
    if (killer.multi >= 2) emit(world, "streak", { seat: killer.seat, n: killer.multi });
  } else if (world.mode === "dm") {
    duck.score = Math.max(0, duck.score - 1);
  }
  emit(world, "death", { seat: duck.seat, by: killer ? killer.seat : -1, w: wIdx, x: duck.x, y: duck.y, self: !killer });
  if (duck.weapon !== 0 && duck.ammo > 0) {
    const p = addPickup(world, "w", duck.weapon, duck.x, duck.y, false);
    p.ammo = duck.ammo;
    p.vx = duck.vx * 0.5; p.vy = duck.vy * 0.5;
  }
  duck.weapon = 0; duck.ammo = 0;
  if (world.loaf && world.loaf.holder === duck.seat) dropLoaf(world, duck);
  if (world.mode === "lms") {
    duck.ghost = true;
    duck.booCd = 1.5;
  } else {
    duck.respawn = RESPAWN_TIME;
  }
}

function respawn(world, duck) {
  const s = pickSpawn(world, duck);
  duck.x = duck.px = s.x; duck.y = duck.py = s.y;
  duck.vx = duck.vy = 0;
  duck.hp = MAX_HP; duck.alive = true; duck.ghost = false;
  duck.invuln = 1.8; duck.dive = 0; duck.diveCd = 0; duck.fireCd = 0.3;
  duck.weapon = 0; duck.ammo = 0; duck.burn = 0; duck.spawnT = 0.5;
  duck.facing = duck.aim = Math.atan2(ARENA_H / 2 - s.y, ARENA_W / 2 - s.x);
  if (duck.brain) duck.brain = newBrain(world, duck);
  emit(world, "respawn", { seat: duck.seat, x: s.x, y: s.y });
}

export function explode(world, x, y, radius, dmg, owner, wIdx, big) {
  emit(world, "explosion", { x: x, y: y, r: radius, big: !!big, land: world.map.depth(x, y) < 0 });
  for (let i = 0; i < world.ducks.length; i++) {
    const d = world.ducks[i];
    if (!isTargetable(d)) continue;
    const dx = d.x - x, dy = d.y - y;
    const dist = Math.hypot(dx, dy);
    const edge = Math.max(0, dist - DUCK_R);
    if (edge >= radius) continue;
    const f = 1 - edge / radius;
    let amount = dmg * (0.3 + 0.7 * f);
    if (d.dive > 0) amount *= 0.4;
    if (d.seat === owner) amount *= 0.6;
    const k = (240 + 360 * f) / (dist || 1);
    damage(world, d, amount, owner, wIdx, dx * k, dy * k);
  }
  for (let i = 0; i < world.barrels.length; i++) {
    const b = world.barrels[i];
    const dist = Math.hypot(b.x - x, b.y - y);
    if (dist < radius && b.fuse < 0) {
      b.hp -= dmg;
      b.by = owner;
      b.vx += (b.x - x) / (dist || 1) * 160; b.vy += (b.y - y) / (dist || 1) * 160;
      if (b.hp <= 0) b.fuse = 0.14 + world.rng() * 0.12;
    }
  }
  for (let i = 0; i < world.mines.length; i++) {
    const m = world.mines[i];
    if (m.fuse < 0 && Math.hypot(m.x - x, m.y - y) < radius * 0.9) m.fuse = 0.1 + world.rng() * 0.1;
  }
  for (let i = 0; i < world.pickups.length; i++) {
    const p = world.pickups[i];
    const dist = Math.hypot(p.x - x, p.y - y);
    if (dist < radius && p.fall <= 0) { p.vx += (p.x - x) / (dist || 1) * 220; p.vy += (p.y - y) / (dist || 1) * 220; }
  }
  if (world.loaf && world.loaf.holder < 0) {
    const l = world.loaf;
    const dist = Math.hypot(l.x - x, l.y - y);
    if (dist < radius) { l.vx += (l.x - x) / (dist || 1) * 260; l.vy += (l.y - y) / (dist || 1) * 260; }
  }
}

// ---- the API handed to weapons -----------------------------------------------------------------
function makeApi(world) {
  return {
    addBullet: function (b) {
      b.id = world.nextId++;
      b.px = b.x; b.py = b.y; b.age = 0; b.hits = null; b.bounced = false; b.target = null;
      world.bullets.push(b);
      return b;
    },
    addMine: function (x, y, owner) {
      // Never drop a mine on land.
      if (world.map.depth(x, y) < 14) { const o = duckBySeat(world, owner); if (o) { x = o.x; y = o.y; } }
      world.mines.push({ id: world.nextId++, x: x, y: y, vx: 0, vy: 0, owner: owner, arm: 0.9, life: 26, fuse: -1, armed: false, wob: world.rng() * 6 });
      emit(world, "mineDrop", { x: x, y: y });
    },
    addWave: function (x, y, a, owner) {
      world.waves.push({ id: world.nextId++, x: x, y: y, a: a, owner: owner, age: 0, life: 0.85, speed: 430, hit: [] });
    },
    flame: function (duck, range, half, dmg) {
      emit(world, "flame", { seat: duck.seat, x: duck.x + Math.cos(duck.aim) * 28, y: duck.y + Math.sin(duck.aim) * 28, a: duck.aim });
      for (let i = 0; i < world.ducks.length; i++) {
        const d = world.ducks[i];
        if (d === duck || !isTargetable(d) || d.dive > 0) continue;
        const dx = d.x - duck.x, dy = d.y - duck.y;
        const dist = Math.hypot(dx, dy);
        if (dist > range + DUCK_R) continue;
        const off = Math.abs(normAngle(Math.atan2(dy, dx) - duck.aim));
        if (off > half + Math.atan2(DUCK_R, dist || 1)) continue;
        if (!world.map.clearLine(duck.x, duck.y, d.x, d.y, 0)) continue;
        damage(world, d, dmg, duck.seat, duck.weapon, Math.cos(duck.aim) * 9, Math.sin(duck.aim) * 9);
        if (d.alive) { if (d.burn <= 0) emit(world, "burn", { seat: d.seat }); d.burn = 2.6; d.burnBy = duck.seat; }
      }
      for (let i = 0; i < world.barrels.length; i++) {
        const b = world.barrels[i];
        const dx = b.x - duck.x, dy = b.y - duck.y;
        const dist = Math.hypot(dx, dy);
        if (dist > range || b.fuse >= 0) continue;
        if (Math.abs(normAngle(Math.atan2(dy, dx) - duck.aim)) > half + 0.1) continue;
        b.hp -= dmg; b.by = duck.seat;
        if (b.hp <= 0) b.fuse = 0.25;
      }
    },
    zap: function (duck, range, chain, dmgs) {
      const pts = [duck.x + Math.cos(duck.aim) * 30, duck.y + Math.sin(duck.aim) * 30];
      const done = [duck];
      let from = duck;
      let reach = range;
      let hits = 0;
      for (let n = 0; n < dmgs.length; n++) {
        let best = null, bd = reach;
        for (let i = 0; i < world.ducks.length; i++) {
          const d = world.ducks[i];
          if (!isTargetable(d) || done.indexOf(d) !== -1) continue;
          if (d.hidden && n === 0 && Math.hypot(d.x - from.x, d.y - from.y) > 120) continue;
          const dist = Math.hypot(d.x - from.x, d.y - from.y);
          if (dist >= bd) continue;
          if (n === 0 && d !== duck.target && Math.abs(normAngle(Math.atan2(d.y - duck.y, d.x - duck.x) - duck.aim)) > 0.9) continue;
          if (!world.map.clearLine(from.x, from.y, d.x, d.y, 0)) continue;
          bd = dist; best = d;
        }
        if (!best) break;
        pts.push(best.x, best.y);
        done.push(best);
        const a = Math.atan2(best.y - from.y, best.x - from.x);
        damage(world, best, dmgs[n] * (best.dive > 0 ? 1.5 : 1), duck.seat, duck.weapon, Math.cos(a) * 60, Math.sin(a) * 60);
        hits++;
        from = best; reach = chain;
      }
      if (!hits) { pts.push(duck.x + Math.cos(duck.aim) * 150, duck.y + Math.sin(duck.aim) * 150); }
      emit(world, "zap", { seat: duck.seat, pts: pts, hits: hits });
    }
  };
}

// ---- pickups -----------------------------------------------------------------------------------
function addPickup(world, kind, wIdx, x, y, drop) {
  const p = {
    id: world.nextId++, kind: kind, w: wIdx, x: x, y: y, vx: 0, vy: 0,
    fall: drop ? 1.15 : 0, life: 24, ammo: -1, wob: world.rng() * 6
  };
  world.pickups.push(p);
  if (drop) emit(world, "crateDrop", { x: x, y: y });
  return p;
}

function randomOpenPoint(world, minDuck, tries) {
  const pts = world.map.openWater;
  if (!pts.length) return null;
  let best = null, bs = -Infinity;
  for (let t = 0; t < (tries || 10); t++) {
    const c = pts[(world.rng() * pts.length) | 0];
    const x = c.x + (world.rng() - 0.5) * 30, y = c.y + (world.rng() - 0.5) * 30;
    let near = 1e9;
    for (let i = 0; i < world.ducks.length; i++) {
      if (world.ducks[i].alive) near = Math.min(near, Math.hypot(world.ducks[i].x - x, world.ducks[i].y - y));
    }
    for (let i = 0; i < world.pickups.length; i++) {
      near = Math.min(near, Math.hypot(world.pickups[i].x - x, world.pickups[i].y - y) * 1.5);
    }
    let s = Math.min(near, minDuck * 2.5);
    if (world.zone && world.zone.active && Math.hypot(x - world.zone.x, y - world.zone.y) > world.zone.r - 40) s -= 1000;
    if (s > bs) { bs = s; best = { x: x, y: y }; }
  }
  return best;
}

function spawnPickup(world) {
  const p = randomOpenPoint(world, 150, 12);
  if (!p) return;
  const roll = world.rng();
  if (roll < 0.64) {
    let total = 0;
    for (let i = 1; i < WEAPON_WEIGHTS.length; i++) total += (i === world.lastCrate ? 0 : WEAPON_WEIGHTS[i]);
    let pick = world.rng() * total, idx = 1;
    for (let i = 1; i < WEAPON_WEIGHTS.length; i++) {
      if (i === world.lastCrate) continue;
      pick -= WEAPON_WEIGHTS[i];
      if (pick <= 0) { idx = i; break; }
    }
    world.lastCrate = idx;
    addPickup(world, "w", idx, p.x, p.y, true);
  } else if (roll < 0.82) {
    addPickup(world, "bread", 0, p.x, p.y, true);
  } else if (roll < 0.91) {
    addPickup(world, "shield", 0, p.x, p.y, true);
  } else {
    addPickup(world, "turbo", 0, p.x, p.y, true);
  }
}

function collect(world, duck, p) {
  if (p.kind === "w") {
    const full = weaponAmmo(p.w);
    const ammo = p.ammo > 0 ? p.ammo : full;
    if (duck.weapon === p.w) duck.ammo = Math.min(full * 2, duck.ammo + ammo);
    else { duck.weapon = p.w; duck.ammo = ammo; }
    duck.fireCd = Math.max(duck.fireCd, 0.15);
    duck.crates++;
  } else if (p.kind === "bread") {
    duck.hp = Math.min(MAX_HP, duck.hp + 40);
  } else if (p.kind === "shield") {
    duck.shield = 45;
  } else if (p.kind === "turbo") {
    duck.turbo = 7;
  }
  emit(world, "pickup", { seat: duck.seat, kind: p.kind, w: p.w, x: p.x, y: p.y });
}

function dropLoaf(world, duck) {
  const l = world.loaf;
  if (!l) return;
  l.holder = -1;
  l.x = duck.x; l.y = duck.y;
  const a = world.rng() * Math.PI * 2;
  l.vx = duck.vx * 0.4 + Math.cos(a) * 120; l.vy = duck.vy * 0.4 + Math.sin(a) * 120;
  l.lock = 0.7;
  emit(world, "loafDrop", { x: l.x, y: l.y, seat: duck.seat });
}

// Keep a floating thing on the water.
function floatBody(world, o, r, dt, drag, flowK) {
  const map = world.map;
  map.flow(o.x, o.y, tmp);
  o.x += (o.vx + tmp.x * flowK) * dt;
  o.y += (o.vy + tmp.y * flowK) * dt;
  const k = Math.exp(-drag * dt);
  o.vx *= k; o.vy *= k;
  const d = map.depth(o.x, o.y);
  if (d < r) {
    map.normal(o.x, o.y, tmp);
    o.x += tmp.x * (r - d); o.y += tmp.y * (r - d);
    const vn = o.vx * tmp.x + o.vy * tmp.y;
    if (vn < 0) { o.vx -= 1.4 * vn * tmp.x; o.vy -= 1.4 * vn * tmp.y; }
  }
}

// ---- auto aim ----------------------------------------------------------------------------------
function acquireTarget(world, duck, range) {
  let best = null, bs = Infinity;
  for (let i = 0; i < world.ducks.length; i++) {
    const d = world.ducks[i];
    if (d === duck || !isTargetable(d) || d.dive > 0) continue;
    const dx = d.x - duck.x, dy = d.y - duck.y;
    const dist = Math.hypot(dx, dy);
    if (dist > range) continue;
    if (d.hidden && dist > 120) continue;
    const off = Math.abs(normAngle(Math.atan2(dy, dx) - duck.facing));
    let s = dist * (1 + 0.5 * off / Math.PI);
    if (d === duck.target) s *= 0.7;
    if (!world.map.clearLine(duck.x, duck.y, d.x, d.y, 0)) s += 400;
    if (s < bs) { bs = s; best = d; }
  }
  return best;
}

// ---- main step ---------------------------------------------------------------------------------
export function stepWorld(world, dt) {
  const map = world.map;
  world.time += dt;

  if (world.phase === "countdown") {
    world.countdown -= dt;
    const n = Math.ceil(world.countdown - 0.6);
    if (n !== world.lastCount && n >= 1 && n <= 3) { world.lastCount = n; emit(world, "countdown", { n: n }); }
    if (world.countdown <= 0.6 && world.lastCount !== 0) { world.lastCount = 0; world.phase = "play"; emit(world, "go"); }
  }
  const playing = world.phase === "play";
  const api = world.api || (world.api = makeApi(world));

  // -- ducks
  for (let i = 0; i < world.ducks.length; i++) {
    const d = world.ducks[i];
    d.px = d.x; d.py = d.y;
    d.wob += dt * 2.2;
    if (d.flash > 0) d.flash -= dt;
    if (d.kick > 0) d.kick = Math.max(0, d.kick - dt * 6);
    if (d.spawnT > 0) d.spawnT -= dt;
    if (d.quackCd > 0) d.quackCd -= dt;
    if (d.booCd > 0) d.booCd -= dt;

    if (d.isBot && d.brain) thinkBot(world, d, dt);
    const inp = d.input;

    if (inp.quack) {
      inp.quack = false;
      if (d.quackCd <= 0) { d.quackCd = 0.25; d.reveal = 0.6; emit(world, "quack", { seat: d.seat, x: d.x, y: d.y }); }
    }

    if (!d.alive) {
      if (!d.ghost) {
        inp.dive = false;
        if (playing && d.respawn > 0) { d.respawn -= dt; if (d.respawn <= 0) respawn(world, d); }
        continue;
      }
    }

    // timers
    if (d.invuln > 0) d.invuln -= dt;
    if (d.turbo > 0) d.turbo -= dt;
    if (d.fireCd > 0) d.fireCd -= dt;
    if (d.diveCd > 0) d.diveCd -= dt;
    if (d.reveal > 0) d.reveal -= dt;

    const frozen = world.phase === "countdown";
    let mx = frozen ? 0 : inp.mx, my = frozen ? 0 : inp.my;
    let mag = Math.hypot(mx, my);
    if (mag > 1) { mx /= mag; my /= mag; mag = 1; }
    if (mag < 0.12) { mx = 0; my = 0; mag = 0; }

    // dive
    if (inp.dive) {
      inp.dive = false;
      const holdsLoaf = world.loaf && world.loaf.holder === d.seat;
      if (playing && d.alive && d.dive <= 0 && d.diveCd <= 0 && !holdsLoaf) {
        d.dive = DIVE_TIME;
        d.dives++;
        if (d.burn > 0) d.burn = 0;
        emit(world, "dive", { seat: d.seat, x: d.x, y: d.y });
      }
    }
    if (d.dive > 0) {
      d.dive -= dt;
      if (d.dive <= 0) {
        d.dive = 0; d.diveCd = DIVE_COOLDOWN;
        emit(world, "surface", { seat: d.seat, x: d.x, y: d.y });
        // Breaching under someone bumps them.
        for (let k = 0; k < world.ducks.length; k++) {
          const o = world.ducks[k];
          if (o === d || !isTargetable(o) || o.dive > 0) continue;
          const dx = o.x - d.x, dy = o.y - d.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 56) damage(world, o, 8, d.seat, -1, dx / (dist || 1) * 300, dy / (dist || 1) * 300);
        }
      }
    }
    const under = d.dive > 0;

    // movement
    let top = BASE_SPEED;
    if (d.turbo > 0) top *= 1.38;
    if (under) top *= 1.28;
    if (d.ghost) top *= 1.1;
    if (world.loaf && world.loaf.holder === d.seat) top *= 0.9;
    if (d.weapon === 7 && inp.fire && !under) top *= 0.82;
    const k = 1 - Math.exp(-(mag > 0 ? 5.2 : 1.9) * dt);
    d.vx += (mx * top - d.vx) * k;
    d.vy += (my * top - d.vy) * k;
    map.flow(d.x, d.y, tmp);
    const fk = d.ghost ? 0 : (under ? 0.45 : 1);
    d.x += (d.vx + tmp.x * fk) * dt;
    d.y += (d.vy + tmp.y * fk) * dt;
    const sp = Math.hypot(d.vx, d.vy);
    d.paddle += dt * (2 + sp * 0.06);

    // shore
    const depth = map.depth(d.x, d.y);
    if (depth < SHORE_R) {
      map.normal(d.x, d.y, tmp);
      d.x += tmp.x * (SHORE_R - depth); d.y += tmp.y * (SHORE_R - depth);
      const vn = d.vx * tmp.x + d.vy * tmp.y;
      if (vn < 0) { d.vx -= 1.2 * vn * tmp.x; d.vy -= 1.2 * vn * tmp.y; }
    }

    // facing and aim
    d.target = (d.alive && !under && !world.passive && playing) ? acquireTarget(world, d, WEAPON_DEFS[d.weapon].assist) : null;
    let want = d.facing;
    if (mag > 0) want = Math.atan2(my, mx);
    let aimWant = want;
    if (d.target) {
      aimWant = Math.atan2(d.target.y - d.y, d.target.x - d.x);
      if (d.isBot && d.brain) aimWant += d.brain.aimErr;
      if (inp.fire) want = aimWant;          // face what you shoot at, paddle any way you like
    }
    d.facing = normAngle(turnToward(d.facing, want, 9 * dt));
    d.aim = normAngle(turnToward(d.aim, aimWant, 7.5 * dt));

    d.inReeds = !under && map.inReeds(d.x, d.y);
    d.hidden = d.inReeds && d.reveal <= 0 && d.alive;

    if (d.ghost) {
      if (inp.fire && d.booCd <= 0 && playing) {
        d.booCd = 2.4;
        emit(world, "boo", { seat: d.seat, x: d.x, y: d.y });
        for (let k2 = 0; k2 < world.ducks.length; k2++) {
          const o = world.ducks[k2];
          if (!isTargetable(o)) continue;
          const dx = o.x - d.x, dy = o.y - d.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 105) { o.vx += dx / (dist || 1) * 230; o.vy += dy / (dist || 1) * 230; }
        }
      }
      continue;
    }

    // burning
    if (d.burn > 0) {
      d.burn -= dt;
      d.burnTick -= dt;
      if (d.burnTick <= 0) { d.burnTick = 0.4; damage(world, d, 2.6, d.burnBy, 7, 0, 0); }
    }

    // whirlpool core
    for (let wI = 0; wI < map.whirlpools.length; wI++) {
      const wp = map.whirlpools[wI];
      if (d.alive && Math.hypot(d.x - wp.x, d.y - wp.y) < wp.r * 0.16 && playing) {
        d.burnTick -= dt;
        if (d.burnTick <= 0) { d.burnTick = 0.4; damage(world, d, 5, -1, -1, 0, 0); }
      }
    }

    // firing
    if (d.alive && playing && !world.passive && inp.fire && !under && d.fireCd <= 0) {
      const def = WEAPON_DEFS[d.weapon];
      d.fireCd = def.cd;
      d.reveal = 0.9;
      d.kick = 1;
      def.fire(world, d, api);
      d.vx -= Math.cos(d.aim) * def.recoil; d.vy -= Math.sin(d.aim) * def.recoil;
      emit(world, "shot", { seat: d.seat, w: d.weapon, x: d.x + Math.cos(d.aim) * 32, y: d.y + Math.sin(d.aim) * 32, a: d.aim });
      if (d.weapon !== 0) {
        d.ammo--;
        if (d.ammo <= 0) { emit(world, "empty", { seat: d.seat, w: d.weapon, x: d.x, y: d.y }); d.weapon = 0; d.ammo = 0; d.fireCd = 0.35; }
      }
    }
  }

  // -- duck vs duck, duck vs barrel
  for (let i = 0; i < world.ducks.length; i++) {
    const a = world.ducks[i];
    if (!isTargetable(a) || a.dive > 0) continue;
    for (let j = i + 1; j < world.ducks.length; j++) {
      const b = world.ducks[j];
      if (!isTargetable(b) || b.dive > 0) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const min = DUCK_R * 2;
      if (dist < min && dist > 0.001) {
        const nx = dx / dist, ny = dy / dist;
        const push = (min - dist) / 2;
        a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
        const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rel < 0) {
          const imp = -rel * 0.9;
          a.vx -= nx * imp; a.vy -= ny * imp; b.vx += nx * imp; b.vy += ny * imp;
          if (rel < -150) emit(world, "bump", { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        }
      }
    }
    for (let j = 0; j < world.barrels.length; j++) {
      const b = world.barrels[j];
      if (b.fall > 0) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const min = DUCK_R + b.r;
      if (dist < min && dist > 0.001) {
        const nx = dx / dist, ny = dy / dist;
        b.x += nx * (min - dist) * 0.8; b.y += ny * (min - dist) * 0.8;
        a.x -= nx * (min - dist) * 0.2; a.y -= ny * (min - dist) * 0.2;
        const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rel < 0) { b.vx -= nx * rel * 1.1; b.vy -= ny * rel * 1.1; }
      }
    }
  }

  if (!world.passive) {
    stepBullets(world, dt);
    stepWaves(world, dt);
    stepMines(world, dt);
    stepBarrels(world, dt);
  }
  stepPickups(world, dt);
  if (playing && !world.passive) stepRules(world, dt);
}

function hitDuckWith(world, b, d) {
  const sp = Math.hypot(b.vx, b.vy) || 1;
  let dmg = b.dmg;
  if (b.type === "pellet") dmg *= 1 - 0.55 * (b.age / b.life);
  damage(world, d, dmg, b.owner, b.w, b.vx / sp * b.knock, b.vy / sp * b.knock);
}

function stepBullets(world, dt) {
  const map = world.map;
  const list = world.bullets;
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    b.age += dt;
    b.px = b.x; b.py = b.y;
    let dead = false;

    if (b.type === "egg") {
      const t = Math.min(1, b.age / b.dur);
      b.x = b.sx + (b.tx - b.sx) * t; b.y = b.sy + (b.ty - b.sy) * t;
      b.h = Math.sin(Math.PI * t) * 95;
      if (t >= 1) { explode(world, b.x, b.y, 100, b.dmg, b.owner, b.w, false); dead = true; }
      if (dead) { list[i] = list[list.length - 1]; list.pop(); }
      continue;
    }

    if (b.type === "rocket") {
      const sp = Math.hypot(b.vx, b.vy);
      const ns = Math.min(780, sp + 1100 * dt);
      b.vx *= ns / sp; b.vy *= ns / sp;
    } else if (b.type === "torpedo") {
      b.seek -= dt;
      if (b.seek <= 0) {
        b.seek = 0.15;
        const head = Math.atan2(b.vy, b.vx);
        let best = null, bd = 430;
        for (let k = 0; k < world.ducks.length; k++) {
          const d = world.ducks[k];
          if (!isTargetable(d) || d.seat === b.owner) continue;
          const dist = Math.hypot(d.x - b.x, d.y - b.y);
          if (dist < bd && Math.abs(normAngle(Math.atan2(d.y - b.y, d.x - b.x) - head)) < 1.5) { bd = dist; best = d; }
        }
        b.target = best;
      }
      let head = Math.atan2(b.vy, b.vx);
      if (b.target && b.target.alive) head = turnToward(head, Math.atan2(b.target.y - b.y, b.target.x - b.x), 2.7 * dt);
      const sp = Math.min(340, Math.hypot(b.vx, b.vy) + 90 * dt);
      b.vx = Math.cos(head) * sp; b.vy = Math.sin(head) * sp;
    }

    const nx = b.x + b.vx * dt, ny = b.y + b.vy * dt;
    let bestT = map.rayLand(b.x, b.y, nx, ny, 0);
    let what = bestT < 1 ? 1 : 0;        // 1 land, 2 duck, 3 barrel, 4 mine
    let obj = null;
    for (let k = 0; k < world.ducks.length; k++) {
      const d = world.ducks[k];
      if (!isTargetable(d) || d.invuln > 0) continue;
      if (d.seat === b.owner && !b.bounced) continue;
      if (d.dive > 0 && !b.under) continue;
      if (b.hits && b.hits.indexOf(d.seat) !== -1) continue;
      const t = segCircle(b.x, b.y, nx, ny, d.x, d.y, DUCK_R + b.r);
      if (t >= 0 && t < bestT) { bestT = t; what = 2; obj = d; }
    }
    for (let k = 0; k < world.barrels.length; k++) {
      const o = world.barrels[k];
      if (o.fall > 0 || o.fuse >= 0) continue;
      const t = segCircle(b.x, b.y, nx, ny, o.x, o.y, o.r + b.r);
      if (t >= 0 && t < bestT) { bestT = t; what = 3; obj = o; }
    }
    for (let k = 0; k < world.mines.length; k++) {
      const o = world.mines[k];
      if (o.fuse >= 0 || (o.owner === b.owner && b.age < 0.25)) continue;
      const t = segCircle(b.x, b.y, nx, ny, o.x, o.y, 12 + b.r);
      if (t >= 0 && t < bestT) { bestT = t; what = 4; obj = o; }
    }

    const explosive = b.type === "rocket" || b.type === "torpedo";
    if (what === 0) {
      b.x = nx; b.y = ny;
    } else {
      b.x += (nx - b.x) * bestT; b.y += (ny - b.y) * bestT;
      if (explosive) {
        explode(world, b.x, b.y, b.type === "rocket" ? 112 : 84, b.dmg, b.owner, b.w, b.type === "rocket");
        dead = true;
      } else if (what === 2) {
        hitDuckWith(world, b, obj);
        if (b.pierce) { (b.hits || (b.hits = [])).push(obj.seat); b.x = nx; b.y = ny; }
        else dead = true;
      } else if (what === 3) {
        obj.hp -= b.dmg; obj.by = b.owner;
        const sp = Math.hypot(b.vx, b.vy) || 1;
        obj.vx += b.vx / sp * 50; obj.vy += b.vy / sp * 50;
        if (obj.hp <= 0) obj.fuse = 0.12;
        emit(world, "impact", { x: b.x, y: b.y, land: true });
        dead = !b.pierce;
        if (b.pierce) { b.x = nx; b.y = ny; }
      } else if (what === 4) {
        obj.fuse = 0.03;
        dead = true;
      } else {
        // shore
        if (b.type === "stone" && b.bounces > 0) {
          map.normal(b.x, b.y, tmp);
          const vn = b.vx * tmp.x + b.vy * tmp.y;
          b.vx -= 2 * vn * tmp.x; b.vy -= 2 * vn * tmp.y;
          b.x += tmp.x * 4; b.y += tmp.y * 4;
          b.bounces--; b.bounced = true; b.dmg += 4;
          emit(world, "bounce", { x: b.x, y: b.y });
        } else {
          emit(world, "impact", { x: b.x, y: b.y, land: true });
          dead = true;
        }
      }
    }
    if (!dead && b.age >= b.life) {
      if (explosive) explode(world, b.x, b.y, b.type === "rocket" ? 112 : 84, b.dmg, b.owner, b.w, b.type === "rocket");
      else emit(world, "impact", { x: b.x, y: b.y, land: false });
      dead = true;
    }
    if (dead) { list[i] = list[list.length - 1]; list.pop(); }
  }
}

function stepWaves(world, dt) {
  for (let i = world.waves.length - 1; i >= 0; i--) {
    const w = world.waves[i];
    w.age += dt;
    w.x += Math.cos(w.a) * w.speed * dt; w.y += Math.sin(w.a) * w.speed * dt;
    const t = w.age / w.life;
    const half = 44 + 80 * t;
    w.half = half;
    const cx = Math.cos(w.a), cy = Math.sin(w.a);
    const reach = function (o, pad) {
      const dx = o.x - w.x, dy = o.y - w.y;
      const along = dx * cx + dy * cy, side = -dx * cy + dy * cx;
      return Math.abs(along) < 26 + pad && Math.abs(side) < half + pad;
    };
    for (let k = 0; k < world.ducks.length; k++) {
      const d = world.ducks[k];
      if (!isTargetable(d) || d.seat === w.owner || d.dive > 0 || w.hit.indexOf(d.seat) !== -1) continue;
      if (reach(d, DUCK_R)) {
        w.hit.push(d.seat);
        damage(world, d, 10, w.owner, 9, cx * 560, cy * 560);
      }
    }
    for (let k = 0; k < world.bullets.length; k++) {
      const b = world.bullets[k];
      if (b.owner === w.owner || b.type === "egg" || b.under) continue;
      if (reach(b, 6)) {
        const sp = Math.hypot(b.vx, b.vy);
        b.vx = cx * sp; b.vy = cy * sp; b.owner = w.owner; b.age = Math.min(b.age, b.life * 0.5);
      }
    }
    const shove = function (list) {
      for (let k = 0; k < list.length; k++) {
        const o = list[k];
        if (o.fall > 0) continue;
        if (reach(o, 14)) { o.vx += (cx * 330 - o.vx) * 0.5; o.vy += (cy * 330 - o.vy) * 0.5; }
      }
    };
    shove(world.pickups); shove(world.barrels); shove(world.mines);
    if (world.loaf && world.loaf.holder < 0 && reach(world.loaf, 14)) { world.loaf.vx = cx * 330; world.loaf.vy = cy * 330; }
    if (w.age >= w.life || world.map.depth(w.x, w.y) < -12) { world.waves[i] = world.waves[world.waves.length - 1]; world.waves.pop(); }
  }
}

function stepMines(world, dt) {
  for (let i = world.mines.length - 1; i >= 0; i--) {
    const m = world.mines[i];
    m.wob += dt * 2;
    floatBody(world, m, 12, dt, 2.5, 0.4);
    m.life -= dt;
    if (!m.armed) {
      m.arm -= dt;
      if (m.arm <= 0) { m.armed = true; emit(world, "mineArm", { x: m.x, y: m.y }); }
    } else if (m.fuse < 0) {
      for (let k = 0; k < world.ducks.length; k++) {
        const d = world.ducks[k];
        if (!isTargetable(d) || d.invuln > 0) continue;
        if (d.seat === m.owner && m.life > 23) continue;       // owner gets a head start
        const reach = d.dive > 0 ? 30 : 52;
        if (Math.hypot(d.x - m.x, d.y - m.y) < reach) { m.fuse = 0.22; emit(world, "mineArm", { x: m.x, y: m.y }); break; }
      }
    }
    if (m.fuse >= 0) {
      m.fuse -= dt;
      if (m.fuse <= 0) {
        world.mines[i] = world.mines[world.mines.length - 1]; world.mines.pop();
        explode(world, m.x, m.y, 116, 62, m.owner, 4, true);
        continue;
      }
    }
    if (m.life <= 0 && m.fuse < 0) {
      emit(world, "impact", { x: m.x, y: m.y, land: false });
      world.mines[i] = world.mines[world.mines.length - 1]; world.mines.pop();
    }
  }
}

function stepBarrels(world, dt) {
  for (let i = world.barrels.length - 1; i >= 0; i--) {
    const b = world.barrels[i];
    b.wob += dt * 1.7;
    if (b.fall > 0) {
      b.fall -= dt;
      if (b.fall <= 0) emit(world, "crateLand", { x: b.x, y: b.y });
      continue;
    }
    floatBody(world, b, b.r, dt, 1.6, 0.8);
    if (b.fuse >= 0) {
      b.fuse -= dt;
      if (b.fuse <= 0) {
        world.barrels[i] = world.barrels[world.barrels.length - 1]; world.barrels.pop();
        explode(world, b.x, b.y, 126, 58, b.by, -2, true);
      }
    }
  }
  if (world.phase === "play") {
    world.barrelT -= dt;
    if (world.barrelT <= 0) {
      world.barrelT = 15 + world.rng() * 8;
      if (world.barrels.length < world.map.barrels.length) {
        const p = randomOpenPoint(world, 180, 8);
        if (p) { const b = newBarrel(world, p.x, p.y); b.fall = 1.1; world.barrels.push(b); emit(world, "crateDrop", { x: p.x, y: p.y }); }
      }
    }
  }
}

function stepPickups(world, dt) {
  for (let i = world.pickups.length - 1; i >= 0; i--) {
    const p = world.pickups[i];
    p.wob += dt * 2.4;
    if (p.fall > 0) {
      p.fall -= dt;
      if (p.fall <= 0) emit(world, "crateLand", { x: p.x, y: p.y });
      continue;
    }
    floatBody(world, p, 14, dt, 1.8, 0.8);
    p.life -= dt;
    let taken = false;
    for (let k = 0; k < world.ducks.length; k++) {
      const d = world.ducks[k];
      if (!isTargetable(d) || d.dive > 0) continue;
      if (Math.hypot(d.x - p.x, d.y - p.y) < DUCK_R + 17) {
        if (p.kind === "bread" && d.hp >= MAX_HP) continue;
        collect(world, d, p);
        taken = true;
        break;
      }
    }
    if (taken || p.life <= 0) { world.pickups[i] = world.pickups[world.pickups.length - 1]; world.pickups.pop(); }
  }
  if (world.phase === "play" && !world.passive) {
    world.pickupT -= dt;
    if (world.pickupT <= 0) {
      let n = 0;
      for (let i = 0; i < world.ducks.length; i++) if (world.ducks[i].alive) n++;
      world.pickupT = Math.max(1.5, 4.4 - n * 0.33) * (0.75 + world.rng() * 0.5);
      if (world.pickups.length < 3 + Math.ceil(n / 2)) spawnPickup(world);
    }
  }
}

export function aliveCount(world) {
  let n = 0;
  for (let i = 0; i < world.ducks.length; i++) if (world.ducks[i].alive) n++;
  return n;
}

function finish(world, winnerSeat) {
  world.phase = "over";
  world.winner = winnerSeat;
  emit(world, "over", { winner: winnerSeat });
}

function stepRules(world, dt) {
  if (world.mode === "lms") {
    const z = world.zone;
    if (!z.active && world.time > z.delay) { z.active = true; z.t = 0; emit(world, "zone", { x: z.x, y: z.y }); }
    if (z.active) {
      z.t += dt;
      const k = Math.min(1, z.t / z.dur);
      z.r = z.r0 + (z.r1 - z.r0) * k;
      // Visible radius never exceeds what matters on screen.
      z.tick -= dt;
      if (z.tick <= 0) {
        z.tick = 0.3;
        for (let i = 0; i < world.ducks.length; i++) {
          const d = world.ducks[i];
          if (!isTargetable(d)) continue;
          if (Math.hypot(d.x - z.x, d.y - z.y) > z.r) {
            emit(world, "nibble", { seat: d.seat, x: d.x, y: d.y });
            const was = d.invuln; d.invuln = 0;
            damage(world, d, 4.2 + 4 * k, -1, -3, 0, 0);
            d.invuln = was;
          }
        }
      }
    }
    let alive = 0, last = null;
    for (let i = 0; i < world.ducks.length; i++) { if (world.ducks[i].alive) { alive++; last = world.ducks[i]; } }
    if (alive <= 1 && world.ducks.length > 1) finish(world, last ? last.seat : -1);
    else if (alive === 0) finish(world, -1);
  } else if (world.mode === "dm") {
    world.timeLeft -= dt;
    if (world.timeLeft <= 0) {
      world.timeLeft = 0;
      let top = -1, best = null, tie = false;
      for (let i = 0; i < world.ducks.length; i++) {
        const d = world.ducks[i];
        if (d.score > top) { top = d.score; best = d; tie = false; } else if (d.score === top) tie = true;
      }
      if (!tie && best) finish(world, best.seat);
      else if (!world.overtime) { world.overtime = true; emit(world, "overtime", {}); }
    }
  } else if (world.mode === "loaf") {
    const l = world.loaf;
    if (l.lock > 0) l.lock -= dt;
    if (l.holder >= 0) {
      const h = duckBySeat(world, l.holder);
      if (!h || !h.alive) { l.holder = -1; }
      else {
        l.x = h.x; l.y = h.y;
        h.loafTime += dt;
        h.reveal = 0.5;
        l.tick += dt;
        if (l.tick >= 1) {
          l.tick -= 1;
          h.score++;
          emit(world, "loafTick", { seat: h.seat, x: h.x, y: h.y });
          if (h.score >= world.goal) finish(world, h.seat);
        }
      }
    } else {
      floatBody(world, l, 14, dt, 1.6, 0.8);
      l.idle += dt;
      if (l.lock <= 0) {
        for (let i = 0; i < world.ducks.length; i++) {
          const d = world.ducks[i];
          if (!isTargetable(d) || d.dive > 0) continue;
          if (Math.hypot(d.x - l.x, d.y - l.y) < DUCK_R + 18) {
            l.holder = d.seat; l.tick = 0; l.idle = 0;
            emit(world, "loafGrab", { seat: d.seat, x: d.x, y: d.y });
            break;
          }
        }
      }
    }
  }
}
