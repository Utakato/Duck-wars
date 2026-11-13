// Headless checks of the simulation, maps, weapons and bots. Plain Node, no browser.
//
//   node tests/sim.spec.mjs
import { buildMap, MAP_IDS, ARENA_W, ARENA_H } from "../js/screen/maps.js";
import { createWorld, stepWorld, TICK, duckBySeat, aliveCount, MAX_HP } from "../js/screen/sim.js";
import { WEAPON_DEFS } from "../js/screen/weapons.js";
import { WEAPONS, MODES, MAPS, HATS, COLORS, MAX_PLAYERS } from "../js/shared/config.js";

let failures = 0, passes = 0;
function check(label, cond, detail) {
  if (cond) passes++;
  else { failures++; console.log("FAIL " + label + (detail !== undefined ? "  -> " + JSON.stringify(detail) : "")); }
}
function group(name) { console.log("-- " + name); }

function run(world, seconds, each) {
  const steps = Math.round(seconds / TICK);
  for (let i = 0; i < steps; i++) {
    stepWorld(world, TICK);
    if (each && each(world) === false) return i * TICK;
    world.events.length = 0;
  }
  return seconds;
}
function bots(n, skill) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ seat: i, name: "Bot" + i, color: i, hat: i, bot: true, skill: skill === undefined ? i % 3 : skill });
  return out;
}
function humans(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ seat: i, name: "P" + i, color: i, hat: 0, bot: false, deviceId: 10 + i });
  return out;
}
// Two ducks on open water, `dist` apart on a horizontal line, facing each other.
function duel(map, weapon, dist) {
  const world = createWorld({ map: map, mode: "dm", goal: 600, seed: 5, countdown: 0, ducks: humans(2) });
  world.pickupT = 1e9; world.barrelT = 1e9; world.barrels.length = 0;
  const a = world.ducks[0], b = world.ducks[1];
  let spot = null;
  for (const p of map.openWater) {
    if (map.depth(p.x, p.y) > 60 && map.depth(p.x + dist, p.y) > 60 && map.clearLine(p.x, p.y, p.x + dist, p.y, 30)) { spot = p; break; }
  }
  if (!spot) throw new Error("no open stretch of " + dist + " on " + map.id);
  a.x = a.px = spot.x; a.y = a.py = spot.y; a.facing = a.aim = 0;
  b.x = b.px = spot.x + dist; b.y = b.py = spot.y; b.facing = b.aim = Math.PI;
  a.weapon = weapon; a.ammo = WEAPONS[weapon].ammo || 0;
  stepWorld(world, TICK); world.events.length = 0;      // leave the countdown
  return { world, a, b };
}

// ---- data tables ---------------------------------------------------------------------------------
group("config");
check("weapon tables line up", WEAPONS.length === WEAPON_DEFS.length && WEAPONS.every((w, i) => w.id === WEAPON_DEFS[i].id), WEAPONS.map((w) => w.id));
check("one colour per seat", COLORS.length === MAX_PLAYERS);
check("every selectable map exists", MAPS.slice(1).every((m) => MAP_IDS.includes(m.id)) && MAPS.length === MAP_IDS.length + 1);
check("modes have valid default goals", MODES.every((m) => m.goals[m.goalDefault] > 0));
check("enough hats to tell eight ducks apart", HATS.length >= MAX_PLAYERS);

// ---- maps ----------------------------------------------------------------------------------------
group("maps");
const maps = {};
for (const id of MAP_IDS) {
  const map = maps[id] = buildMap(id);
  check(id + ": at least 8 spawn points", map.spawns.length >= 8, map.spawns.length);
  let minGap = Infinity;
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) minGap = Math.min(minGap, Math.hypot(map.spawns[i].x - map.spawns[j].x, map.spawns[i].y - map.spawns[j].y));
  check(id + ": first 8 spawns are spread out (min gap " + Math.round(minGap) + ")", minGap > 200, minGap);
  check(id + ": spawns are on deep, connected water", map.spawns.every((s) => map.depth(s.x, s.y) > 40 && map.inMainWater(s.x, s.y, 30)));
  check(id + ": arena border is land", [0, 1, 2, 3].every((k) => map.depth(k < 2 ? (k ? ARENA_W - 4 : 4) : 800, k < 2 ? 450 : (k === 2 ? 4 : ARENA_H - 4)) < 0));
  let paths = 0, bad = 0;
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
    const p = map.findPath(map.spawns[i].x, map.spawns[i].y, map.spawns[j].x, map.spawns[j].y);
    paths++;
    if (!p || !p.length) { bad++; continue; }
    for (let k = 1; k < p.length; k++) if (!map.clearLine(p[k - 1].x, p[k - 1].y, p[k].x, p[k].y, 0)) { bad++; break; }
  }
  check(id + ": a water path joins every pair of spawns (" + paths + " pairs)", bad === 0, bad);
  check(id + ": barrels and reeds sit on water", map.barrels.every((b) => map.depth(b.x, b.y) > 20) && map.reeds.every((r) => map.depth(r.x, r.y) > -10));
  const water = map.navOpen.length / (40 * 22);
  check(id + ": pond covers a sensible share of the screen (" + Math.round(water * 100) + "%)", water > 0.35 && water < 0.8, water);
}

// ---- movement and the shore ----------------------------------------------------------------------
group("movement");
for (const id of MAP_IDS) {
  const world = createWorld({ map: maps[id], mode: "dm", goal: 600, seed: 3, countdown: 0, ducks: humans(8) });
  let onLand = 0, nan = 0;
  const dirs = world.ducks.map((d, i) => i * Math.PI / 4);
  run(world, 12, (w) => {
    for (let i = 0; i < w.ducks.length; i++) {
      const d = w.ducks[i];
      if (Math.floor(w.time * 2) % 5 === 0) dirs[i] += 0.03;
      d.input.mx = Math.cos(dirs[i]); d.input.my = Math.sin(dirs[i]);
      if (!isFinite(d.x + d.y + d.vx + d.vy)) nan++;
      if (d.alive && w.map.depth(d.x, d.y) < 4) onLand++;
    }
  });
  check(id + ": ducks pushed against the shore from every angle never leave the water", onLand === 0 && nan === 0, { onLand, nan });
}
{
  const world = createWorld({ map: maps.lagoon, mode: "dm", goal: 600, seed: 3, countdown: 0, ducks: humans(1) });
  const d = world.ducks[0];
  d.x = 300; d.y = 420; d.vx = d.vy = 0;
  d.input.mx = 1;
  run(world, 1.2);
  const v = Math.hypot(d.vx, d.vy);
  check("top paddling speed is 245 +/- 10 units/s", Math.abs(v - 245) < 10, v);
  d.input.mx = 0;
  run(world, 2.5);
  check("a duck that stops paddling glides to a halt", Math.hypot(d.vx, d.vy) < 8, Math.hypot(d.vx, d.vy));
}

// ---- weapons -------------------------------------------------------------------------------------
group("weapons");
const RANGE = { pea: 220, shotgun: 120, smg: 220, rocket: 260, torpedo: 240, sniper: 420, flame: 120, zap: 200, wave: 150, stone: 220, egg: 240 };
for (let w = 0; w < WEAPONS.length; w++) {
  const id = WEAPONS[w].id;
  if (id === "mine") continue;
  const { world, a, b } = duel(maps.lagoon, w, RANGE[id]);
  a.input.fire = true;
  let shots = 0;
  run(world, 3.5, (wd) => { for (const e of wd.events) if (e.type === "shot" && e.seat === 0 && e.w === w) shots++; });
  check(id + ": hits a duck " + RANGE[id] + " units away (" + shots + " shots, " + Math.round(MAX_HP - b.hp) + " damage)", b.hp < MAX_HP - 5 || !b.alive || b.deaths > 0, { hp: b.hp, shots });
  check(id + ": fire rate matches its cooldown", shots >= 1 && shots <= Math.ceil(3.5 / WEAPON_DEFS[w].cd) + 1, shots);
}
{
  const { world, a, b } = duel(maps.lagoon, 4, 200);     // mines
  a.input.fire = true;
  run(world, 0.3);
  a.input.fire = false;
  check("mine: dropped behind the duck", world.mines.length === 1 && world.mines[0].x < a.x, world.mines.map((m) => [m.x, a.x]));
  run(world, 1.2);
  check("mine: arms after a moment", world.mines[0] && world.mines[0].armed);
  const m = world.mines[0];
  b.x = b.px = m.x + 30; b.y = b.py = m.y; b.invuln = 0;
  run(world, 1);
  check("mine: blows up under a rival", world.mines.length === 0 && (b.hp < MAX_HP || b.deaths > 0), { mines: world.mines.length, hp: b.hp });
}
{
  const { world, a, b } = duel(maps.lagoon, 2, 200);     // smg vs a diver
  a.input.fire = true;
  let hp = MAX_HP;
  run(world, 0.25);
  b.hp = MAX_HP; b.diveCd = 0;
  b.input.dive = true;
  run(world, 0.1);
  hp = b.hp;
  run(world, 0.6);
  check("diving ducks bullets", b.dive > 0 && b.hp === hp, { dive: b.dive, hp: b.hp, was: hp });
  run(world, 1.5);
  check("the dive ends and has a cooldown", b.dive === 0 && b.diveCd > 0, { dive: b.dive, cd: b.diveCd });
}
{
  const { world, a, b } = duel(maps.lagoon, 5, 260);     // torpedo vs a diver
  b.diveCd = 0; b.input.dive = true;
  a.input.fire = true;
  run(world, 0.85);
  check("torpedoes still hit a diving duck", b.hp < MAX_HP, b.hp);
}
{
  const { world, a, b } = duel(maps.lagoon, 7, 110);     // flamethrower
  a.input.fire = true;
  run(world, 0.4);
  a.input.fire = false;
  check("flamethrower sets ducks alight", b.burn > 0, b.burn);
  b.diveCd = 0; b.input.dive = true;
  run(world, 0.1);
  check("diving puts the fire out", b.burn === 0, b.burn);
}
{
  const { world, a, b } = duel(maps.lagoon, 1, 110);     // recoil and ammo
  a.input.fire = true;
  run(world, 0.05);
  check("shotgun recoil kicks the shooter backwards", a.vx < -100, a.vx);
  a.weapon = 1; a.ammo = 1; a.fireCd = 0;
  run(world, 0.1);
  check("an empty crate weapon falls back to the Pea Popper", a.weapon === 0 && a.ammo === 0, [a.weapon, a.ammo]);
}
{
  const world = createWorld({ map: maps.lagoon, mode: "dm", goal: 600, seed: 9, countdown: 0, ducks: humans(2) });
  const a = world.ducks[0], b = world.ducks[1];
  b.hp = 1; a.weapon = 0;
  const { world: w2, a: a2, b: b2 } = duel(maps.lagoon, 0, 150);
  b2.hp = 5; b2.weapon = 3; b2.ammo = 2;
  a2.input.fire = true;
  run(w2, 1.5);
  check("a splashed duck drops its weapon as a pickup", b2.deaths === 1 && w2.pickups.some((p) => p.kind === "w" && p.w === 3 && p.ammo === 2), w2.pickups.map((p) => [p.kind, p.w, p.ammo]));
  check("the splash is credited to the shooter", a2.kills === 1 && a2.score === 1, [a2.kills, a2.score]);
  run(w2, 4, () => !b2.alive);
  check("splashed ducks respawn in respawn modes, briefly protected", b2.alive && b2.invuln > 0 && b2.hp === MAX_HP, [b2.alive, b2.invuln, b2.hp]);
  void world; void a; void b;
}

// ---- mode rules ----------------------------------------------------------------------------------
group("modes");
{
  // Nobody touches their phone: the piranha ring must still end the round.
  const world = createWorld({ map: maps.twins, mode: "lms", goal: 3, seed: 2, ducks: humans(4) });
  const t = run(world, 150, (w) => w.phase !== "over");
  check("elimination round ends by itself even if everyone idles (" + Math.round(t) + " s)", world.phase === "over" && t < 120, { phase: world.phase, t });
  check("...with at most one duck afloat", aliveCount(world) <= 1, aliveCount(world));
}
{
  const world = createWorld({ map: maps.lagoon, mode: "dm", goal: 20, seed: 4, countdown: 0, ducks: humans(3) });
  world.ducks[1].score = 2;
  run(world, 21, (w) => w.phase !== "over");
  check("timed mode ends when the clock runs out, top score wins", world.phase === "over" && world.winner === 1, [world.phase, world.winner]);
  const tie = createWorld({ map: maps.lagoon, mode: "dm", goal: 5, seed: 4, countdown: 0, ducks: humans(3) });
  run(tie, 8);
  check("a tie at the buzzer goes to overtime instead of ending", tie.phase === "play" && tie.overtime === true, [tie.phase, tie.overtime]);
  tie.ducks[2].score = 1;
  run(tie, 0.1, (w) => w.phase !== "over");
  check("the next splash decides overtime", tie.phase === "over" && tie.winner === 2, [tie.phase, tie.winner]);
}
{
  const world = createWorld({ map: maps.lagoon, mode: "loaf", goal: 5, seed: 4, countdown: 0, ducks: humans(2) });
  const d = world.ducks[0];
  stepWorld(world, TICK);
  d.x = d.px = world.loaf.x; d.y = d.py = world.loaf.y;
  run(world, 0.2);
  check("touching the golden loaf picks it up", world.loaf.holder === 0, world.loaf.holder);
  d.input.dive = true;
  run(world, 0.2);
  check("the loaf carrier cannot dive", d.dive === 0, d.dive);
  run(world, 6, (w) => w.phase !== "over");
  check("holding the loaf scores one point per second up to the goal", world.phase === "over" && world.winner === 0 && d.score === 5, [world.phase, world.winner, d.score]);
}

// ---- bots ----------------------------------------------------------------------------------------
group("bots");
let worstStep = 0;
for (const id of MAP_IDS) {
  for (const mode of ["lms", "dm", "loaf"]) {
    const world = createWorld({ map: maps[id], mode: mode, goal: mode === "dm" ? 45 : (mode === "loaf" ? 15 : 3), seed: 7 + id.length, ducks: bots(8) });
    const stuck = world.ducks.map((d) => ({ x: d.x, y: d.y, t: 0, worst: 0 }));
    let bad = 0, onLand = 0, steps = 0;
    const t0 = process.hrtime.bigint();
    const limit = Math.round(200 / TICK);
    while (world.phase !== "over" && steps < limit) {
      stepWorld(world, TICK); steps++;
      for (let i = 0; i < world.ducks.length; i++) {
        const d = world.ducks[i], s = stuck[i];
        if (!isFinite(d.x + d.y + d.hp + d.vx + d.vy + d.aim + d.facing)) bad++;
        if (d.alive && world.map.depth(d.x, d.y) < 4) onLand++;
        // stuck guard: wants to move, but has not covered 14 units
        const wants = d.alive && world.phase === "play" && Math.hypot(d.input.mx, d.input.my) > 0.4;
        if (!wants || Math.hypot(d.x - s.x, d.y - s.y) > 14) { s.x = d.x; s.y = d.y; s.t = 0; }
        else { s.t += TICK; if (s.t > s.worst) { s.worst = s.t; s.mode = d.brain ? d.brain.mode : "?"; s.at = [Math.round(d.x), Math.round(d.y), d.ghost]; } }
      }
      world.events.length = 0;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / steps;
    worstStep = Math.max(worstStep, ms);
    const worst = Math.max(...stuck.map((s) => s.worst));
    const label = id + "/" + mode;
    check(label + ": 8 bots finish a match (" + Math.round(world.time) + " s)", world.phase === "over", world.phase);
    check(label + ": no bad numbers, nobody on land", bad === 0 && onLand === 0, { bad, onLand });
    check(label + ": no bot stays stuck (worst " + worst.toFixed(1) + " s)", worst < 4, stuck.filter((s) => s.worst >= 4).map((s) => [s.mode, s.at, s.worst.toFixed(1)]));
    if (mode === "dm") check(label + ": bots actually fight (" + world.ducks.reduce((n, d) => n + d.kills, 0) + " splashes)", world.ducks.reduce((n, d) => n + d.kills, 0) >= 4);
    check(label + ": entity lists stay bounded", world.bullets.length < 200 && world.pickups.length < 12 && world.mines.length < 30, [world.bullets.length, world.pickups.length, world.mines.length]);
  }
}
check("simulation step stays far below the frame budget (worst " + worstStep.toFixed(3) + " ms with 8 ducks)", worstStep < 2, worstStep);
{
  // Skill should matter: hard bots beat easy bots over a set of matches.
  let hard = 0, easy = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const ducks = [];
    for (let i = 0; i < 6; i++) ducks.push({ seat: i, name: "B" + i, color: i, hat: 0, bot: true, skill: i % 2 ? 2 : 0 });
    const world = createWorld({ map: maps[MAP_IDS[seed % MAP_IDS.length]], mode: "dm", goal: 60, seed: seed * 13, ducks });
    run(world, 70, (w) => w.phase !== "over");
    for (const d of world.ducks) { if (d.skill === 2) hard += d.kills; else easy += d.kills; }
  }
  check("hard bots out-splash easy bots (" + hard + " vs " + easy + ")", hard > easy * 1.3, [hard, easy]);
}
{
  // Same seed, same inputs, same result: the simulation has no hidden randomness.
  const sig = () => {
    const world = createWorld({ map: maps.stones, mode: "dm", goal: 20, seed: 99, ducks: bots(6) });
    run(world, 20);
    return world.ducks.map((d) => Math.round(d.x * 100) + ":" + Math.round(d.y * 100) + ":" + d.kills).join("|");
  };
  check("deterministic for a given seed", sig() === sig());
}
{
  // A player leaves mid-round and a bot takes over; the round carries on.
  const world = createWorld({ map: maps.lagoon, mode: "lms", goal: 3, seed: 5, countdown: 0, ducks: humans(2).concat([{ seat: 5, name: "B", color: 5, hat: 0, bot: true, skill: 1 }]) });
  run(world, 1);
  const { setBot } = await import("../js/screen/sim.js");
  setBot(world, 0, true, 1);
  const d = duckBySeat(world, 0);
  const x = d.x, y = d.y;
  run(world, 4);
  check("a duck handed to the AI starts moving", d.isBot && Math.hypot(d.x - x, d.y - y) > 20, Math.hypot(d.x - x, d.y - y));
  setBot(world, 0, false);
  check("...and can be handed back", !d.isBot && d.brain === null && d.input.mx === 0);
}

console.log("\n" + passes + " passed, " + failures + " failed");
process.exit(failures ? 1 : 0);
