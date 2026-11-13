// Weapon behaviour. Indexes match WEAPONS in js/shared/config.js.
// Each entry: cd (seconds between shots), recoil (speed kick on water), assist (auto-aim range),
// keep (preferred fighting distance for bots) and fire(world, duck, api).
import { WEAPONS } from "../shared/config.js";

const TAU = Math.PI * 2;

function muzzle(duck, dist) {
  return { x: duck.x + Math.cos(duck.aim) * dist, y: duck.y + Math.sin(duck.aim) * dist };
}

function shoot(world, duck, api, angle, o) {
  const m = muzzle(duck, 30);
  const speed = o.speed;
  return api.addBullet({
    type: o.type, w: duck.weapon, owner: duck.seat,
    x: m.x, y: m.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
    dmg: o.dmg, r: o.r || 4, life: o.life, pierce: !!o.pierce, bounces: o.bounces || 0,
    under: !!o.under, knock: o.knock || 0
  });
}

export const WEAPON_DEFS = [
  { // 0 Pea Popper: the sidearm everyone starts with. Never runs dry.
    id: "pea", cd: 0.30, recoil: 18, assist: 500, keep: 280,
    fire: function (world, duck, api) {
      shoot(world, duck, api, duck.aim + (world.rng() - 0.5) * 0.06, { type: "pea", speed: 650, life: 0.82, dmg: 11, r: 5, knock: 40 });
    }
  },
  { // 1 Crumb Blaster: shotgun. Brutal up close, and the kick doubles as a jet boost.
    id: "shotgun", cd: 0.85, recoil: 270, assist: 300, keep: 150,
    fire: function (world, duck, api) {
      for (let i = 0; i < 7; i++) {
        const a = duck.aim + (i - 3) * 0.075 + (world.rng() - 0.5) * 0.05;
        shoot(world, duck, api, a, { type: "pellet", speed: 690 + world.rng() * 90, life: 0.36, dmg: 9, r: 4, knock: 90 });
      }
    }
  },
  { // 2 Reed Rattler: bullet hose.
    id: "smg", cd: 0.085, recoil: 24, assist: 460, keep: 250,
    fire: function (world, duck, api) {
      shoot(world, duck, api, duck.aim + (world.rng() - 0.5) * 0.17, { type: "smg", speed: 790, life: 0.6, dmg: 6, r: 4, knock: 30 });
    }
  },
  { // 3 Bloop Tube: rocket with a big splash.
    id: "rocket", cd: 1.0, recoil: 190, assist: 640, keep: 380,
    fire: function (world, duck, api) {
      shoot(world, duck, api, duck.aim, { type: "rocket", speed: 300, life: 2.0, dmg: 60, r: 7 });
    }
  },
  { // 4 Bobber Mines: dropped behind the duck, arm after a moment.
    id: "mine", cd: 0.7, recoil: 0, assist: 0, keep: 120,
    fire: function (world, duck, api) {
      const back = duck.facing + Math.PI;
      api.addMine(duck.x + Math.cos(back) * 30, duck.y + Math.sin(back) * 30, duck.seat);
    }
  },
  { // 5 Pike Torpedo: homes in underwater, so diving does not save anyone.
    id: "torpedo", cd: 1.0, recoil: 50, assist: 560, keep: 380,
    fire: function (world, duck, api) {
      const b = shoot(world, duck, api, duck.aim, { type: "torpedo", speed: 215, life: 4.2, dmg: 50, r: 8, under: true });
      b.seek = 0;
    }
  },
  { // 6 Long Beak: sniper. Pierces, hits like a truck, shows a laser so victims can dodge.
    id: "sniper", cd: 1.15, recoil: 230, assist: 900, keep: 520,
    fire: function (world, duck, api) {
      shoot(world, duck, api, duck.aim, { type: "sniper", speed: 2300, life: 0.7, dmg: 52, r: 5, pierce: true, knock: 220 });
    }
  },
  { // 7 Chili Breath: flamethrower. Sets ducks on fire; diving puts it out.
    id: "flame", cd: 0.05, recoil: 6, assist: 240, keep: 130,
    fire: function (world, duck, api) {
      api.flame(duck, 185, 0.30, 2.3);
    }
  },
  { // 8 Eel Zapper: chain lightning, and water conducts: divers take extra.
    id: "zap", cd: 0.75, recoil: 30, assist: 320, keep: 220,
    fire: function (world, duck, api) {
      api.zap(duck, 320, 190, [24, 16, 11]);
    }
  },
  { // 9 Tsunami Horn: a wave that shoves ducks, crates and even bullets away.
    id: "wave", cd: 1.0, recoil: 130, assist: 360, keep: 190,
    fire: function (world, duck, api) {
      const m = muzzle(duck, 26);
      api.addWave(m.x, m.y, duck.aim, duck.seat);
    }
  },
  { // 10 Skipping Stones: ricochet off the shore, gaining damage each skip.
    id: "stone", cd: 0.24, recoil: 16, assist: 520, keep: 300,
    fire: function (world, duck, api) {
      shoot(world, duck, api, duck.aim + (world.rng() - 0.5) * 0.05, { type: "stone", speed: 640, life: 2.3, dmg: 13, r: 5, bounces: 4, knock: 60 });
    }
  },
  { // 11 Egg Mortar: lobbed over rocks, lands where the target was.
    id: "egg", cd: 0.9, recoil: 60, assist: 450, keep: 320,
    fire: function (world, duck, api) {
      const t = duck.target;
      let dist = 300;
      let a = duck.aim;
      if (t) {
        dist = Math.max(130, Math.min(450, Math.hypot(t.x - duck.x, t.y - duck.y)));
        a = Math.atan2(t.y - duck.y, t.x - duck.x);
      }
      a += (world.rng() - 0.5) * 0.08;
      const m = muzzle(duck, 24);
      const b = api.addBullet({
        type: "egg", w: duck.weapon, owner: duck.seat, x: m.x, y: m.y, vx: 0, vy: 0,
        dmg: 52, r: 8, life: 9, pierce: false, bounces: 0, under: false, knock: 0
      });
      b.sx = m.x; b.sy = m.y;
      b.tx = duck.x + Math.cos(a) * dist; b.ty = duck.y + Math.sin(a) * dist;
      b.dur = 0.55 + dist / 900;
    }
  }
];

// How likely each weapon is to be inside a crate.
export const WEAPON_WEIGHTS = [0, 10, 10, 7, 6, 6, 5, 7, 7, 6, 7, 7];

export function weaponName(i) { return WEAPONS[i] ? WEAPONS[i].name : "?"; }
export function weaponAmmo(i) { return WEAPONS[i] ? WEAPONS[i].ammo : 0; }

export function normAngle(a) {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}
