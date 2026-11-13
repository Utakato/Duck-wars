// Bot ducks. Layered the usual way: perceive on a timer -> decide a mode -> path -> steer.
// A bot only ever writes the same input struct a phone would send, so it plays by the same rules.
import { WEAPON_DEFS, normAngle } from "./weapons.js";

// Per skill level: 0 easy, 1 normal, 2 hard.
const AIM_ERR = [0.30, 0.13, 0.04];
const REACT = [0.75, 0.38, 0.14];
const DODGE = [0.06, 0.35, 0.8];
const THINK = [0.32, 0.2, 0.12];
const CRATE_RANGE = [380, 650, 950];
const THROTTLE = [0.82, 0.95, 1];

export function newBrain(world, duck) {
  const r = world.rng;
  return {
    t: r() * 0.25, mode: "wander", tgt: null, goalX: duck.x, goalY: duck.y,
    path: null, pathI: 0, pathT: 0, pathGX: 0, pathGY: 0,
    strafe: r() < 0.5 ? 1 : -1, strafeT: 1 + r() * 1.5,
    aimErr: 0, errT: 0, react: 0, hadLos: false,
    stuckT: 1, lx: duck.x, ly: duck.y, wanderT: 0,
    quackT: 3 + r() * 9, idleT: 0, fire: false, mvx: 0, mvy: 0
  };
}

function pickWander(world, d, br) {
  const pts = world.map.openWater;
  if (!pts.length) return;
  let best = pts[0], bs = -Infinity;
  for (let i = 0; i < 6; i++) {
    const p = pts[(world.rng() * pts.length) | 0];
    let s = world.rng() * 200;
    const dist = Math.hypot(p.x - d.x, p.y - d.y);
    s += Math.min(dist, 500) * 0.5;
    if (world.zone && world.zone.active && Math.hypot(p.x - world.zone.x, p.y - world.zone.y) > world.zone.r - 60) s -= 5000;
    if (s > bs) { bs = s; best = p; }
  }
  br.goalX = best.x; br.goalY = best.y;
  br.wanderT = 3 + world.rng() * 4;
}

function steerTo(world, d, br, gx, gy) {
  const map = world.map;
  let tx = gx, ty = gy;
  if (!map.clearLine(d.x, d.y, gx, gy, 20)) {
    if (!br.path || br.pathT <= 0 || Math.hypot(gx - br.pathGX, gy - br.pathGY) > 90) {
      br.path = map.findPath(d.x, d.y, gx, gy);
      br.pathI = 0; br.pathT = 0.7 + world.rng() * 0.5; br.pathGX = gx; br.pathGY = gy;
    }
    if (br.path && br.path.length) {
      let best = Math.min(br.pathI, br.path.length - 1);
      const end = Math.min(br.path.length, best + 6);
      for (let k = best; k < end; k++) {
        if (map.clearLine(d.x, d.y, br.path[k].x, br.path[k].y, 18)) best = k;
      }
      if (best < br.path.length - 1 && Math.hypot(br.path[best].x - d.x, br.path[best].y - d.y) < 26) best++;
      br.pathI = best;
      tx = br.path[best].x; ty = br.path[best].y;
    }
  } else {
    br.path = null;
  }
  const dx = tx - d.x, dy = ty - d.y;
  const l = Math.hypot(dx, dy);
  if (l < 6) { br.mvx = 0; br.mvy = 0; return; }
  br.mvx = dx / l; br.mvy = dy / l;
}

function perceive(world, d, br) {
  const skill = d.skill;
  const map = world.map;
  br.mode = "wander";
  br.tgt = null;

  // 1. Stay out of the piranhas.
  const z = world.zone;
  if (z && z.active && Math.hypot(d.x - z.x, d.y - z.y) > z.r - 55) {
    br.mode = "goto"; br.goalX = z.x; br.goalY = z.y;
  }

  // 2. Nearest enemy worth shooting.
  let best = null, bs = Infinity;
  for (let i = 0; i < world.ducks.length; i++) {
    const o = world.ducks[i];
    if (o === d || !o.alive || o.ghost) continue;
    const dist = Math.hypot(o.x - d.x, o.y - d.y);
    if (o.hidden && dist > 150) continue;
    let s = dist;
    if (o === br.lastTgt) s *= 0.75;
    if (world.loaf && world.loaf.holder === o.seat) s *= 0.35;
    if (!map.clearLine(d.x, d.y, o.x, o.y, 0)) s += 250;
    if (s < bs) { bs = s; best = o; }
  }
  br.tgt = best;
  if (best !== br.lastTgt) { br.react = REACT[skill] * (0.7 + world.rng() * 0.6); br.lastTgt = best; }

  if (br.mode === "goto") return;

  if (d.ghost) { br.mode = best ? "haunt" : "wander"; return; }

  // 3. Golden loaf.
  const loaf = world.loaf;
  if (loaf) {
    if (loaf.holder === d.seat) { br.mode = "keepaway"; return; }
    if (loaf.holder < 0) { br.mode = "goto"; br.goalX = loaf.x; br.goalY = loaf.y; br.fireOnTheWay = true; return; }
  }

  // 4. Pickups.
  let want = null, wd = Infinity;
  for (let i = 0; i < world.pickups.length; i++) {
    const p = world.pickups[i];
    const dist = Math.hypot(p.x - d.x, p.y - d.y);
    let range = 0;
    if (p.kind === "bread") range = d.hp < 45 ? 900 : (d.hp < 75 ? 300 : 0);
    else if (p.kind === "w") range = d.weapon === 0 ? CRATE_RANGE[skill] : 0;
    else range = 260;
    if (z && z.active && Math.hypot(p.x - z.x, p.y - z.y) > z.r - 20) range = 0;
    if (dist < range && dist < wd) { wd = dist; want = p; }
  }
  if (want && (!best || wd < bs * 1.4 || d.hp < 45)) {
    br.mode = "goto"; br.goalX = want.x; br.goalY = want.y; br.fireOnTheWay = true;
    return;
  }

  if (best) { br.mode = "attack"; return; }
}

function threatened(world, d) {
  for (let i = 0; i < world.bullets.length; i++) {
    const b = world.bullets[i];
    if (b.owner === d.seat || b.under) continue;
    if (b.type === "egg") {
      if (Math.hypot(b.tx - d.x, b.ty - d.y) < 100 && b.dur - b.age < 0.35) return true;
      continue;
    }
    const rx = d.x - b.x, ry = d.y - b.y;
    const dist = Math.hypot(rx, ry);
    if (dist > 230) continue;
    const sp = Math.hypot(b.vx, b.vy) || 1;
    const along = (rx * b.vx + ry * b.vy) / sp;
    if (along <= 0) continue;
    const side = Math.abs(rx * b.vy - ry * b.vx) / sp;
    if (side < 30 && along / sp < 0.3) return true;
  }
  for (let i = 0; i < world.waves.length; i++) {
    const w = world.waves[i];
    if (w.owner !== d.seat && Math.hypot(w.x - d.x, w.y - d.y) < 110) return true;
  }
  return false;
}

export function thinkBot(world, d, dt) {
  const br = d.brain;
  const inp = d.input;
  const skill = d.skill;
  const map = world.map;

  // Lobby: just paddle about and look pleased.
  if (world.passive) {
    br.wanderT -= dt;
    if (br.wanderT <= 0 || Math.hypot(br.goalX - d.x, br.goalY - d.y) < 40) { pickWander(world, d, br); br.idleT = world.rng() < 0.4 ? 1 + world.rng() * 2 : 0; }
    if (br.idleT > 0) { br.idleT -= dt; inp.mx = 0; inp.my = 0; return; }
    steerTo(world, d, br, br.goalX, br.goalY);
    inp.mx = br.mvx * 0.45; inp.my = br.mvy * 0.45;
    return;
  }

  br.pathT -= dt;
  br.strafeT -= dt;
  br.errT -= dt;
  if (br.react > 0) br.react -= dt;
  if (br.strafeT <= 0) { br.strafeT = 0.9 + world.rng() * 1.8; if (world.rng() < 0.6) br.strafe = -br.strafe; }
  if (br.errT <= 0) { br.errT = 0.35 + world.rng() * 0.4; br.aimErr = (world.rng() - 0.5) * 2 * AIM_ERR[skill]; }

  br.t -= dt;
  if (br.t <= 0) {
    br.t = THINK[skill] * (0.8 + world.rng() * 0.4);
    br.fireOnTheWay = false;
    perceive(world, d, br);
    // Reflexes: dive under incoming fire, or to put out flames.
    if (d.alive && d.dive <= 0 && d.diveCd <= 0 && world.phase === "play") {
      if (threatened(world, d) && world.rng() < DODGE[skill]) inp.dive = true;
      else if (d.burn > 0.8 && world.rng() < 0.25 + skill * 0.3) inp.dive = true;
    }
  }

  let fire = false;
  const tgt = br.tgt && br.tgt.alive ? br.tgt : null;

  if (br.mode === "attack" && tgt) {
    const def = WEAPON_DEFS[d.weapon];
    const dx = tgt.x - d.x, dy = tgt.y - d.y;
    const dist = Math.hypot(dx, dy) || 1;
    const los = map.clearLine(d.x, d.y, tgt.x, tgt.y, 0) || d.weapon === 11;
    if (!los) {
      steerTo(world, d, br, tgt.x, tgt.y);
    } else {
      const ux = dx / dist, uy = dy / dist;
      let keep = def.keep;
      if (d.hp < 35 && d.weapon !== 1 && d.weapon !== 7) keep += 110;        // hurt: fight from further away
      const radial = dist > keep + 45 ? 1 : (dist < keep - 45 ? -1 : 0);
      let mx = ux * radial - uy * br.strafe * 0.85, my = uy * radial + ux * br.strafe * 0.85;
      // Do not strafe into the shore.
      if (map.depth(d.x + mx * 60, d.y + my * 60) < 26) { br.strafe = -br.strafe; mx = ux * radial - uy * br.strafe * 0.85; my = uy * radial + ux * br.strafe * 0.85; }
      const l = Math.hypot(mx, my) || 1;
      br.mvx = mx / l; br.mvy = my / l;
      br.path = null;
    }
    let reach = def.assist * 0.95;
    if (d.weapon === 1) reach = 240;
    if (d.weapon === 4) reach = 150;
    if (d.weapon === 7) reach = 195;
    if (d.weapon === 9) reach = 260;
    fire = los && dist < reach && br.react <= 0 && tgt.dive <= 0 && (!tgt.hidden || dist < 120);
    // Hold the big guns when the splash would hurt more than it helps.
    if (fire && d.weapon === 3 && dist < 95) fire = false;
  } else if (br.mode === "keepaway") {
    // Carrying the loaf: run from whoever is closest, hugging open water.
    let ax = 0, ay = 0;
    for (let i = 0; i < world.ducks.length; i++) {
      const o = world.ducks[i];
      if (o === d || !o.alive) continue;
      const dx = d.x - o.x, dy = d.y - o.y;
      const dist = Math.hypot(dx, dy) || 1;
      const wgt = 1 / (dist * dist) * 40000;
      ax += dx / dist * wgt; ay += dy / dist * wgt;
    }
    map.normal(d.x, d.y, br);                 // reuse br.x / br.y as scratch
    const depth = map.depth(d.x, d.y);
    const shore = Math.max(0, 1 - depth / 90) * 3;
    ax += br.x * shore; ay += br.y * shore;
    const sx = -ay * 0.35 * br.strafe, sy = ax * 0.35 * br.strafe;
    ax += sx; ay += sy;
    const l = Math.hypot(ax, ay);
    if (l > 0.05) { br.mvx = ax / l; br.mvy = ay / l; } else { br.mvx = 0; br.mvy = 0; }
    fire = !!tgt && Math.hypot(tgt.x - d.x, tgt.y - d.y) < WEAPON_DEFS[d.weapon].assist * 0.9 && br.react <= 0;
  } else if (br.mode === "haunt" && tgt) {
    steerTo(world, d, br, tgt.x, tgt.y);
    fire = Math.hypot(tgt.x - d.x, tgt.y - d.y) < 90;
  } else if (br.mode === "goto") {
    steerTo(world, d, br, br.goalX, br.goalY);
    if (br.fireOnTheWay && tgt) {
      const dist = Math.hypot(tgt.x - d.x, tgt.y - d.y);
      fire = dist < WEAPON_DEFS[d.weapon].assist * 0.85 && br.react <= 0 && map.clearLine(d.x, d.y, tgt.x, tgt.y, 0) && d.weapon !== 4;
    }
  } else {
    br.wanderT -= dt;
    if (br.wanderT <= 0 || Math.hypot(br.goalX - d.x, br.goalY - d.y) < 50) pickWander(world, d, br);
    steerTo(world, d, br, br.goalX, br.goalY);
  }

  // Keep clear of armed mines and the whirlpool's teeth.
  let mx = br.mvx, my = br.mvy;
  for (let i = 0; i < world.mines.length; i++) {
    const m = world.mines[i];
    const dx = d.x - m.x, dy = d.y - m.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 105 && dist > 1) { const k = (105 - dist) / 105 * 2.2; mx += dx / dist * k; my += dy / dist * k; }
  }
  for (let i = 0; i < map.whirlpools.length; i++) {
    const w = map.whirlpools[i];
    const dx = d.x - w.x, dy = d.y - w.y;
    const dist = Math.hypot(dx, dy);
    if (dist < w.r * 0.45 && dist > 1) { const k = (w.r * 0.45 - dist) / (w.r * 0.45) * 2.5; mx += dx / dist * k; my += dy / dist * k; }
  }
  const z = world.zone;
  if (z && z.active) {
    const dx = z.x - d.x, dy = z.y - d.y;
    const dist = Math.hypot(dx, dy);
    if (dist > z.r - 45 && dist > 1) { mx += dx / dist * 2.2; my += dy / dist * 2.2; }
  }
  const l = Math.hypot(mx, my);
  if (l > 1) { mx /= l; my /= l; }

  // Stuck guard: no progress for a while -> drop the path and try the other way round.
  br.stuckT -= dt;
  if (br.stuckT <= 0) {
    br.stuckT = 1;
    if (Math.hypot(d.x - br.lx, d.y - br.ly) < 10 && Math.hypot(mx, my) > 0.3) {
      br.path = null; br.pathT = 0; br.strafe = -br.strafe;
      if (br.mode === "wander") pickWander(world, d, br);
    }
    br.lx = d.x; br.ly = d.y;
  }

  br.quackT -= dt;
  if (br.quackT <= 0) { br.quackT = 5 + world.rng() * 12; inp.quack = true; }

  const thr = THROTTLE[skill];
  inp.mx = mx * thr; inp.my = my * thr;
  inp.fire = fire && world.phase === "play";
}
