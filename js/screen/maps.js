// Pond geometry. Every map is a signed distance field ("depth"): positive = open water and the
// distance to the nearest shore, negative = land. Collision, bullets, bot navigation, spawn
// points and the baked background all read the same field, so what you see is what you hit.
// No DOM in this file: it also runs in Node for the headless tests.

export const ARENA_W = 1600;
export const ARENA_H = 900;
const CELL = 8;
const COLS = Math.floor(ARENA_W / CELL) + 1;
const ROWS = Math.floor(ARENA_H / CELL) + 1;

export const NAV_CELL = 40;
export const NAV_COLS = Math.floor(ARENA_W / NAV_CELL);
export const NAV_ROWS = Math.floor(ARENA_H / NAV_CELL);

// ---- small deterministic helpers ---------------------------------------------------------------
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Smooth value noise in -1..1.
export function valueNoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return (a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy) * 2 - 1;
}

// ---- shape SDFs (negative inside) --------------------------------------------------------------
function sdShape(s, x, y) {
  if (s.t === "c") {
    return Math.hypot(x - s.x, y - s.y) - s.r;
  }
  if (s.t === "b") { // rounded box: centre x,y, half sizes hw,hh, corner radius r
    const qx = Math.abs(x - s.x) - (s.hw - s.r), qy = Math.abs(y - s.y) - (s.hh - s.r);
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
    return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - s.r;
  }
  // capsule
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((x - s.x1) * dx + (y - s.y1) * dy) / len2;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return Math.hypot(x - (s.x1 + dx * t), y - (s.y1 + dy * t)) - s.r;
}

function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// ---- map definitions ---------------------------------------------------------------------------
// water / islands: shapes. reeds: hiding spots. barrels: floating explosive drums.
// whirlpools: pull everything towards the centre. current: steady flow.
const DEFS = {
  lagoon: {
    name: "Lily Lagoon", palette: "day", seed: 11,
    water: [
      { t: "b", x: 800, y: 450, hw: 690, hh: 360, r: 300 },
      { t: "c", x: 300, y: 300, r: 190 }, { t: "c", x: 1320, y: 620, r: 200 }
    ],
    islands: [
      { t: "c", x: 800, y: 450, r: 78 },
      { t: "c", x: 470, y: 590, r: 34 }, { t: "c", x: 1140, y: 300, r: 36 },
      { t: "c", x: 1010, y: 680, r: 24 }, { t: "c", x: 600, y: 230, r: 24 }
    ],
    reeds: [
      { x: 255, y: 330, r: 84 }, { x: 1350, y: 590, r: 84 },
      { x: 830, y: 150, r: 66 }, { x: 760, y: 750, r: 66 }
    ],
    barrels: [{ x: 620, y: 430 }, { x: 985, y: 475 }, { x: 1250, y: 300 }],
    lilies: 16
  },
  twins: {
    name: "Twin Ponds", palette: "sunset", seed: 23, smooth: 150,
    water: [
      { t: "c", x: 455, y: 450, r: 345 }, { t: "c", x: 1145, y: 450, r: 345 },
      { t: "cap", x1: 455, y1: 450, x2: 1145, y2: 450, r: 105 }
    ],
    islands: [
      { t: "c", x: 400, y: 450, r: 62 }, { t: "c", x: 1200, y: 450, r: 62 },
      { t: "c", x: 800, y: 372, r: 20 }, { t: "c", x: 800, y: 528, r: 20 }
    ],
    reeds: [
      { x: 280, y: 250, r: 78 }, { x: 1320, y: 650, r: 78 },
      { x: 300, y: 660, r: 64 }, { x: 1300, y: 240, r: 64 }
    ],
    barrels: [{ x: 800, y: 450 }, { x: 640, y: 450 }, { x: 960, y: 450 }, { x: 455, y: 250 }, { x: 1145, y: 650 }],
    lilies: 12
  },
  millrace: {
    name: "Mill Race", palette: "swamp", seed: 37,
    water: [{ t: "b", x: 800, y: 450, hw: 710, hh: 385, r: 330 }],
    islands: [
      { t: "b", x: 800, y: 450, hw: 330, hh: 118, r: 118 },
      { t: "c", x: 800, y: 172, r: 30 }, { t: "c", x: 800, y: 728, r: 30 },
      { t: "c", x: 245, y: 450, r: 26 }, { t: "c", x: 1355, y: 450, r: 26 }
    ],
    reeds: [
      { x: 330, y: 215, r: 70 }, { x: 1270, y: 685, r: 70 },
      { x: 1270, y: 215, r: 60 }, { x: 330, y: 685, r: 60 }
    ],
    barrels: [{ x: 560, y: 200 }, { x: 1040, y: 700 }, { x: 1040, y: 200 }, { x: 560, y: 700 }],
    current: { type: "ring", x: 800, y: 450, speed: 52 },
    lilies: 8
  },
  stones: {
    name: "Stone Garden", palette: "frost", seed: 41,
    water: [{ t: "b", x: 800, y: 450, hw: 715, hh: 385, r: 220 }],
    islands: [
      { t: "c", x: 420, y: 290, r: 46 }, { t: "c", x: 800, y: 250, r: 38 }, { t: "c", x: 1180, y: 290, r: 46 },
      { t: "c", x: 300, y: 520, r: 30 }, { t: "c", x: 610, y: 470, r: 52 }, { t: "c", x: 990, y: 470, r: 52 },
      { t: "c", x: 1300, y: 520, r: 30 }, { t: "c", x: 470, y: 690, r: 40 }, { t: "c", x: 800, y: 660, r: 44 },
      { t: "c", x: 1130, y: 690, r: 40 }
    ],
    reeds: [{ x: 210, y: 300, r: 60 }, { x: 1390, y: 300, r: 60 }, { x: 800, y: 455, r: 58 }],
    barrels: [{ x: 620, y: 300 }, { x: 980, y: 300 }, { x: 800, y: 790 }, { x: 250, y: 680 }, { x: 1350, y: 680 }],
    lilies: 6
  },
  maelstrom: {
    name: "The Maelstrom", palette: "night", seed: 53,
    water: [{ t: "b", x: 800, y: 450, hw: 670, hh: 395, r: 395 }],
    islands: [
      { t: "c", x: 360, y: 300, r: 32 }, { t: "c", x: 1240, y: 600, r: 32 },
      { t: "c", x: 420, y: 650, r: 26 }, { t: "c", x: 1180, y: 250, r: 26 }
    ],
    reeds: [{ x: 250, y: 470, r: 66 }, { x: 1350, y: 430, r: 66 }, { x: 800, y: 130, r: 56 }, { x: 800, y: 770, r: 56 }],
    barrels: [{ x: 800, y: 250 }, { x: 800, y: 650 }, { x: 560, y: 450 }, { x: 1040, y: 450 }],
    whirlpools: [{ x: 800, y: 450, r: 250, pull: 150, spin: 120 }],
    lilies: 6
  }
};

export const MAP_IDS = Object.keys(DEFS);

function fieldAt(def, x, y) {
  const k = def.smooth || 60;
  let w = 1e9;
  for (let i = 0; i < def.water.length; i++) {
    const d = sdShape(def.water[i], x, y);
    w = i === 0 ? d : smin(w, d, k);
  }
  let depth = -w;
  for (let i = 0; i < def.islands.length; i++) {
    const d = sdShape(def.islands[i], x, y);
    depth = smin(depth, d, 14);
  }
  // Organic wobble so shores do not look like compass drawings.
  depth += valueNoise(x / 90, y / 90, def.seed) * 9 + valueNoise(x / 37, y / 37, def.seed + 7) * 3.5;
  // Always closed by land at the arena border.
  const border = Math.min(x, y, ARENA_W - x, ARENA_H - y) - 26;
  return Math.min(depth, border);
}

export function buildMap(id) {
  const def = DEFS[id] || DEFS.lagoon;
  const grid = new Float32Array(COLS * ROWS);
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      grid[j * COLS + i] = fieldAt(def, i * CELL, j * CELL);
    }
  }

  const map = {
    id: DEFS[id] ? id : "lagoon",
    name: def.name,
    palette: def.palette,
    seed: def.seed,
    grid: grid, cols: COLS, rows: ROWS, cell: CELL,
    reeds: (def.reeds || []).map(function (r) { return { x: r.x, y: r.y, r: r.r }; }),
    barrels: (def.barrels || []).map(function (b) { return { x: b.x, y: b.y }; }),
    whirlpools: (def.whirlpools || []).map(function (w) { return { x: w.x, y: w.y, r: w.r, pull: w.pull, spin: w.spin }; }),
    current: def.current || null,
    lilyCount: def.lilies || 0,
    // small round islands are drawn as boulders, the big ones as grassy islets
    rocks: def.islands.filter(function (s) { return s.t === "c" && s.r <= 56; }).map(function (s) { return { x: s.x, y: s.y, r: s.r }; }),
    center: { x: ARENA_W / 2, y: ARENA_H / 2 }
  };

  // Bilinear sample of the depth field. Outside the arena counts as deep land.
  map.depth = function (x, y) {
    const gx = x / CELL, gy = y / CELL;
    if (gx < 0 || gy < 0 || gx >= COLS - 1 || gy >= ROWS - 1) return -60;
    const ix = gx | 0, iy = gy | 0;
    const fx = gx - ix, fy = gy - iy;
    const o = iy * COLS + ix;
    const a = grid[o], b = grid[o + 1], c = grid[o + COLS], d = grid[o + COLS + 1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };

  // Unit vector pointing towards deeper water (away from the shore). Written into `out`.
  map.normal = function (x, y, out) {
    const e = 5;
    let nx = map.depth(x + e, y) - map.depth(x - e, y);
    let ny = map.depth(x, y + e) - map.depth(x, y - e);
    const l = Math.hypot(nx, ny);
    if (l < 1e-6) { nx = ARENA_W / 2 - x; ny = ARENA_H / 2 - y; const m = Math.hypot(nx, ny) || 1; out.x = nx / m; out.y = ny / m; return out; }
    out.x = nx / l; out.y = ny / l;
    return out;
  };

  // March from A to B through the field. Returns the fraction (0..1) at which land is hit, or 1.
  map.rayLand = function (x1, y1, x2, y2, clearance) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) return 1;
    const c = clearance || 0;
    let t = 0;
    while (t < len) {
      const d = map.depth(x1 + dx * (t / len), y1 + dy * (t / len)) - c;
      if (d <= 0) return t / len;
      t += d > 4 ? d : 4;
    }
    return 1;
  };
  map.clearLine = function (x1, y1, x2, y2, clearance) {
    return map.rayLand(x1, y1, x2, y2, clearance) >= 1;
  };

  // Water flow at a point (currents + whirlpools), in units per second, written into `out`.
  map.flow = function (x, y, out) {
    let fx = 0, fy = 0;
    const cur = map.current;
    if (cur && cur.type === "ring") {
      const dx = x - cur.x, dy = y - cur.y;
      const l = Math.hypot(dx * 0.62, dy) || 1;      // flattened ring follows the long island
      fx += (-dy / l) * cur.speed;
      fy += (dx * 0.62 / l) * cur.speed;
    }
    for (let i = 0; i < map.whirlpools.length; i++) {
      const w = map.whirlpools[i];
      const dx = w.x - x, dy = w.y - y;
      const d = Math.hypot(dx, dy);
      if (d < w.r && d > 1) {
        const k = 1 - d / w.r;
        const s = k * (0.35 + 0.65 * k);
        fx += (dx / d) * w.pull * s + (-dy / d) * w.spin * s;
        fy += (dy / d) * w.pull * s + (dx / d) * w.spin * s;
      }
    }
    out.x = fx; out.y = fy;
    return out;
  };

  map.inReeds = function (x, y) {
    for (let i = 0; i < map.reeds.length; i++) {
      const r = map.reeds[i];
      const dx = x - r.x, dy = y - r.y;
      if (dx * dx + dy * dy < r.r * r.r) return true;
    }
    return false;
  };

  // Keep decorations and gameplay markers on real water.
  map.reeds = map.reeds.filter(function (r) { return map.depth(r.x, r.y) > -10; });
  map.barrels = map.barrels.filter(function (b) { return map.depth(b.x, b.y) > 26; });

  buildNav(map);
  buildSpawns(map);
  return map;
}

// ---- navigation grid for bots ------------------------------------------------------------------
function buildNav(map) {
  const walk = new Uint8Array(NAV_COLS * NAV_ROWS);
  for (let j = 0; j < NAV_ROWS; j++) {
    for (let i = 0; i < NAV_COLS; i++) {
      const x = (i + 0.5) * NAV_CELL, y = (j + 0.5) * NAV_CELL;
      walk[j * NAV_COLS + i] = map.depth(x, y) > 27 ? 1 : 0;
    }
  }
  map.navWalk = walk;
  map.navOpen = [];
  for (let n = 0; n < walk.length; n++) {
    if (walk[n]) map.navOpen.push(n);
  }

  // Label connected water regions so nobody spawns in a puddle the others cannot reach.
  const region = new Int16Array(walk.length).fill(-1);
  let best = -1, bestSize = 0, regions = 0;
  for (let n = 0; n < walk.length; n++) {
    if (!walk[n] || region[n] !== -1) continue;
    let size = 0;
    const stack = [n];
    region[n] = regions;
    while (stack.length) {
      const c = stack.pop();
      size++;
      const ci = c % NAV_COLS, cj = (c / NAV_COLS) | 0;
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (let k = 0; k < 4; k++) {
        const ni = ci + nb[k][0], nj = cj + nb[k][1];
        if (ni < 0 || nj < 0 || ni >= NAV_COLS || nj >= NAV_ROWS) continue;
        const m = nj * NAV_COLS + ni;
        if (walk[m] && region[m] === -1) { region[m] = regions; stack.push(m); }
      }
    }
    if (size > bestSize) { bestSize = size; best = regions; }
    regions++;
  }
  map.navRegion = region;
  map.mainRegion = best;

  map.navIndex = function (x, y) {
    const i = Math.max(0, Math.min(NAV_COLS - 1, (x / NAV_CELL) | 0));
    const j = Math.max(0, Math.min(NAV_ROWS - 1, (y / NAV_CELL) | 0));
    return j * NAV_COLS + i;
  };
  map.inMainWater = function (x, y, clearance) {
    if (map.depth(x, y) < (clearance || 0)) return false;
    return region[map.navIndex(x, y)] === best;
  };

  // A* over the nav grid (8-way, no corner cutting). Returns a list of {x,y} or null.
  const g = new Float32Array(walk.length);
  const came = new Int32Array(walk.length);
  const state = new Uint8Array(walk.length);   // 0 new, 1 open, 2 closed
  map.findPath = function (x1, y1, x2, y2) {
    let start = nearestOpen(map, x1, y1), goal = nearestOpen(map, x2, y2);
    if (start < 0 || goal < 0) return null;
    if (region[start] !== region[goal]) return null;
    state.fill(0);
    const open = [start];
    g[start] = 0; came[start] = -1; state[start] = 1;
    const gi = goal % NAV_COLS, gj = (goal / NAV_COLS) | 0;
    let guard = 0;
    let found = start === goal;
    while (open.length && guard++ < 2000) {
      let bi = 0, bf = Infinity;
      for (let k = 0; k < open.length; k++) {
        const n = open[k];
        const dx = Math.abs(n % NAV_COLS - gi), dy = Math.abs(((n / NAV_COLS) | 0) - gj);
        const f = g[n] + (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
        if (f < bf) { bf = f; bi = k; }
      }
      const cur = open[bi];
      open[bi] = open[open.length - 1]; open.pop();
      if (cur === goal) { found = true; break; }
      state[cur] = 2;
      const ci = cur % NAV_COLS, cj = (cur / NAV_COLS) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= NAV_COLS || nj >= NAV_ROWS) continue;
          const n = nj * NAV_COLS + ni;
          if (!walk[n] || state[n] === 2) continue;
          if (di && dj && (!walk[cj * NAV_COLS + ni] || !walk[nj * NAV_COLS + ci])) continue;
          const cost = g[cur] + (di && dj ? Math.SQRT2 : 1);
          if (state[n] === 0 || cost < g[n]) {
            g[n] = cost; came[n] = cur;
            if (state[n] === 0) { state[n] = 1; open.push(n); }
          }
        }
      }
    }
    if (!found) return null;
    const path = [];
    let n = goal;
    while (n !== -1 && path.length < 400) {
      path.push({ x: (n % NAV_COLS + 0.5) * NAV_CELL, y: (((n / NAV_COLS) | 0) + 0.5) * NAV_CELL });
      n = came[n];
    }
    path.reverse();
    return path;
  };
}

function nearestOpen(map, x, y) {
  const idx = map.navIndex(x, y);
  if (map.navWalk[idx]) return idx;
  const ci = idx % NAV_COLS, cj = (idx / NAV_COLS) | 0;
  for (let r = 1; r < 6; r++) {
    let best = -1, bd = Infinity;
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= NAV_COLS || nj >= NAV_ROWS) continue;
        const n = nj * NAV_COLS + ni;
        if (!map.navWalk[n]) continue;
        const d = Math.hypot((ni + 0.5) * NAV_CELL - x, (nj + 0.5) * NAV_CELL - y);
        if (d < bd) { bd = d; best = n; }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

// ---- spawn points: spread out as far as possible (farthest point sampling) ---------------------
function buildSpawns(map) {
  const cand = [];
  for (let k = 0; k < map.navOpen.length; k++) {
    const n = map.navOpen[k];
    if (map.navRegion[n] !== map.mainRegion) continue;
    const x = (n % NAV_COLS + 0.5) * NAV_CELL, y = (((n / NAV_COLS) | 0) + 0.5) * NAV_CELL;
    if (map.depth(x, y) < 48) continue;
    let nearWhirl = false;
    for (let i = 0; i < map.whirlpools.length; i++) {
      const w = map.whirlpools[i];
      if (Math.hypot(x - w.x, y - w.y) < w.r * 0.8) nearWhirl = true;
    }
    if (!nearWhirl) cand.push({ x: x, y: y });
  }
  map.openWater = cand;
  const spawns = [];
  if (cand.length) {
    // Start from the left-most candidate so the layout is stable for a given map.
    let first = cand[0];
    for (let i = 1; i < cand.length; i++) if (cand[i].x < first.x) first = cand[i];
    spawns.push(first);
    while (spawns.length < 12 && spawns.length < cand.length) {
      let best = null, bd = -1;
      for (let i = 0; i < cand.length; i++) {
        let d = Infinity;
        for (let s = 0; s < spawns.length; s++) {
          d = Math.min(d, Math.hypot(cand[i].x - spawns[s].x, cand[i].y - spawns[s].y));
        }
        if (d > bd) { bd = d; best = cand[i]; }
      }
      spawns.push(best);
    }
  }
  map.spawns = spawns;
}
