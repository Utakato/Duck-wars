// Shared by screen and controller. Plain data only (no DOM, no AirConsole).
// Syntax is kept at ES2017 level on purpose: embedded Chromium on TVs and cars is old.

export const GAME_TITLE = "DUCK WARS";
export const GAME_TAGLINE = "Pond Royale";

export const MAX_PLAYERS = 8;   // ducks in the pond, humans + bots
export const MIN_DUCKS = 2;     // a lone human always gets at least one bot

// Player colours. `body` is the main feather colour.
export const COLORS = [
  { name: "Sunny",     body: "#ffd23f", dark: "#c78a00", light: "#fff3b0" },
  { name: "Cherry",    body: "#ff5964", dark: "#b81f3a", light: "#ffc2c7" },
  { name: "Sky",       body: "#41b0ff", dark: "#1267c4", light: "#c3e6ff" },
  { name: "Lime",      body: "#7be04a", dark: "#2f8f1f", light: "#d6f9c1" },
  { name: "Grape",     body: "#b57bff", dark: "#6a2fc9", light: "#e6d3ff" },
  { name: "Tangerine", body: "#ff9838", dark: "#c35400", light: "#ffd9b0" },
  { name: "Bubblegum", body: "#ff80cc", dark: "#c42f8c", light: "#ffd3ee" },
  { name: "Mint",      body: "#35dcc6", dark: "#0b8f85", light: "#c2f7ef" }
];

export const HATS = [
  { id: "none",      name: "No hat" },
  { id: "tophat",    name: "Top Hat" },
  { id: "pirate",    name: "Pirate" },
  { id: "viking",    name: "Viking" },
  { id: "crown",     name: "Crown" },
  { id: "cowboy",    name: "Cowboy" },
  { id: "propeller", name: "Propeller" },
  { id: "chef",      name: "Chef" },
  { id: "party",     name: "Party Hat" },
  { id: "ninja",     name: "Ninja" },
  { id: "flower",    name: "Lily" },
  { id: "bucket",    name: "Bucket" }
];

// Game modes. `goals` are the selectable match lengths, `goalDefault` an index.
export const MODES = [
  {
    id: "lms", name: "Last Duck Floating",
    desc: "One life per round. Last duck on the water takes the point.",
    goals: [3, 5, 7], goalDefault: 0, goalUnit: "wins"
  },
  {
    id: "dm", name: "Feather Frenzy",
    desc: "Endless respawns. Most splashes when the clock runs out wins.",
    goals: [120, 180, 300], goalDefault: 1, goalUnit: "time"
  },
  {
    id: "loaf", name: "Golden Loaf",
    desc: "Grab the golden loaf and keep it. Every second you hold it scores.",
    goals: [30, 45, 60], goalDefault: 1, goalUnit: "points"
  }
];

// Map names only; geometry lives in js/screen/maps.js. Index 0 means "random".
export const MAPS = [
  { id: "random",    name: "Random pond" },
  { id: "lagoon",    name: "Lily Lagoon" },
  { id: "twins",     name: "Twin Ponds" },
  { id: "millrace",  name: "Mill Race" },
  { id: "stones",    name: "Stone Garden" },
  { id: "maelstrom", name: "The Maelstrom" }
];

export const DIFFICULTIES = ["Easy", "Normal", "Hard"];

// Weapons as the controller needs them (name, colour, magazine). Behaviour is in js/screen/weapons.js.
// Index 0 is the default sidearm with infinite ammo.
export const WEAPONS = [
  { id: "pea",     name: "Pea Popper",      color: "#9be564", ammo: 0  },
  { id: "shotgun", name: "Crumb Blaster",   color: "#f4a259", ammo: 7  },
  { id: "smg",     name: "Reed Rattler",    color: "#f6e27f", ammo: 48 },
  { id: "rocket",  name: "Bloop Tube",      color: "#ff6b6b", ammo: 4  },
  { id: "mine",    name: "Bobber Mines",    color: "#ff4d6d", ammo: 3  },
  { id: "torpedo", name: "Pike Torpedo",    color: "#5bc0eb", ammo: 3  },
  { id: "sniper",  name: "Long Beak",       color: "#c8b6ff", ammo: 5  },
  { id: "flame",   name: "Chili Breath",    color: "#ff7b00", ammo: 70 },
  { id: "zap",     name: "Eel Zapper",      color: "#7df9ff", ammo: 6  },
  { id: "wave",    name: "Tsunami Horn",    color: "#4cc9f0", ammo: 5  },
  { id: "stone",   name: "Skipping Stones", color: "#cfd2cd", ammo: 14 },
  { id: "egg",     name: "Egg Mortar",      color: "#fff4d6", ammo: 5  }
];

export const BOT_NAMES = [
  "Sir Quacksalot", "Captain Bill", "Mallory", "Puddles", "Drake Noir", "Waddles",
  "Featherstone", "Admiral Beak", "Crouton", "Soggy Bottom", "Lady Paddle", "Eider Down"
];

// ---- Message protocol (see README) -----------------------------------------------------------
// controller -> screen
//   { i: [x, y, bits, dive, quack] }   input state. x,y: -100..100. bits: 1 = fire held.
//                                      dive / quack: tap counters (mod 256), so a merged or
//                                      delayed packet never loses a tap.
//   { m: "start" } { m: "rematch" } { m: "lobby" }      master only
//   { m: "cfg", k: "mode"|"map"|"goal"|"bots"|"diff", d: -1|1 }   master only
//   { m: "hat", d: -1|1 }              change own hat (lobby)
// screen -> controller
//   { s: [hp, weapon, ammo, life, cd, shield, loaf] }   own duck status, on change (max 10/s)
//       life: 0 dead / waiting, 1 alive, 2 ghost.  cd: respawn seconds or 0.
//   { v: n }                           vibrate, n is a VIBE id
//   { t: "text" }                      short toast for this player
export const VIBE = { HIT: 1, DIE: 2, PICKUP: 3, WIN: 4, KILL: 5, START: 6 };

export const INPUT_FIRE = 1;

export function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
