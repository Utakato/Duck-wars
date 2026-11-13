// Canvas renderer. The pond itself (grass, sand, rocks, depth shading) is baked once per map from
// the same depth field the simulation uses; everything that moves is drawn on top each frame.
import { ARENA_W, ARENA_H, valueNoise, makeRng } from "./maps.js";
import { COLORS, WEAPONS } from "../shared/config.js";
import {
  drawDuck, drawCrate, drawBread, drawShieldIcon, drawTurboIcon, drawBarrel, drawMine,
  drawWeaponIcon, roundRect, WEAPON_LEN
} from "../shared/duckart.js";
import { MAX_HP } from "./sim.js";

const TAU = Math.PI * 2;
const MARGIN = 220;                 // baked land around the arena, shown on non-16:9 screens
const FONT_UI = "'Fredoka', 'Trebuchet MS', sans-serif";
const FONT_BIG = "'Lilita One', 'Fredoka', 'Arial Black', sans-serif";

const PALETTES = {
  day: {
    deep: [22, 104, 172], shallow: [104, 214, 220], sand: [240, 219, 166], wet: [201, 174, 122],
    grassA: [118, 190, 78], grassB: [88, 164, 64], rock: [152, 162, 176], tree: [58, 138, 62],
    caustic: 0.13, overlay: null, flowers: true, sky: "#bfe9ff"
  },
  sunset: {
    deep: [40, 72, 150], shallow: [140, 186, 222], sand: [246, 208, 164], wet: [190, 150, 128],
    grassA: [150, 166, 78], grassB: [120, 140, 64], rock: [158, 138, 150], tree: [104, 124, 60],
    caustic: 0.12, overlay: "rgba(255,120,60,0.11)", flowers: true, sky: "#ffc9a3"
  },
  swamp: {
    deep: [28, 84, 76], shallow: [140, 190, 128], sand: [176, 166, 114], wet: [124, 116, 80],
    grassA: [90, 146, 64], grassB: [64, 116, 54], rock: [124, 134, 122], tree: [44, 100, 52],
    caustic: 0.10, overlay: "rgba(60,90,30,0.07)", flowers: true, sky: "#cfe6c0"
  },
  frost: {
    deep: [38, 96, 156], shallow: [178, 228, 244], sand: [236, 243, 250], wet: [196, 212, 228],
    grassA: [228, 238, 248], grassB: [204, 221, 238], rock: [148, 164, 188], tree: [70, 120, 110],
    caustic: 0.14, overlay: null, flowers: false, sky: "#e8f4ff"
  },
  night: {
    deep: [12, 30, 78], shallow: [58, 118, 160], sand: [116, 122, 140], wet: [84, 90, 108],
    grassA: [38, 78, 70], grassB: [28, 60, 60], rock: [86, 96, 120], tree: [22, 58, 60],
    caustic: 0.15, overlay: "rgba(8,16,60,0.16)", flowers: false, sky: "#1a2550"
  }
};

function mix(a, b, t) { return a + (b - a) * t; }
function sstep(e0, e1, x) { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
function easeOutBack(t) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
function rgb(c) { return "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")"; }

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

// Tileable cellular pattern that reads as light caustics on water.
function makeCausticTile(size) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const rng = makeRng(99);
  const pts = [];
  for (let i = 0; i < 30; i++) pts.push([rng() * size, rng() * size]);
  const K = Math.PI * 2 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Warp the lookup with whole-period sines: wavy, and still seamless when tiled.
      const wx = x + 9 * Math.sin(K * (y * 3 + 20)) + 5 * Math.sin(K * (x * 2 + y * 5));
      const wy = y + 9 * Math.sin(K * (x * 2 + 70)) + 5 * Math.sin(K * (y * 4 - x * 3));
      let f1 = 1e9, f2 = 1e9;
      for (let i = 0; i < pts.length; i++) {
        let dx = Math.abs(wx - pts[i][0]) % size, dy = Math.abs(wy - pts[i][1]) % size;
        if (dx > size / 2) dx = size - dx;
        if (dy > size / 2) dy = size - dy;
        const d = dx * dx + dy * dy;
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
      }
      const edge = Math.sqrt(f2) - Math.sqrt(f1);
      const v = 1 - sstep(0, 13, edge);
      const o = (y * size + x) * 4;
      img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255;
      img.data[o + 3] = Math.round(v * v * v * 235);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function createRenderer(canvas, fx) {
  const ctx = canvas.getContext("2d", { alpha: false });
  const caustic = makeCausticTile(256);
  let causticPattern = null;
  let map = null;
  let pal = PALETTES.day;
  let land = null;                 // baked RGBA canvas
  let contours = [];               // Path2D per foam level
  let stalks = [];                 // reed stalks
  let lilies = [];
  let flowDust = [];
  let view = { scale: 1, ox: 0, oy: 0, w: 0, h: 0 };
  let safe = { left: 0, top: 0, right: 1, bottom: 1 };
  let quality = 1;                 // 1 full, 0 reduced (auto, see main.js)
  const cos = {};                  // per-seat cosmetic state

  function cosFor(seat) {
    return cos[seat] || (cos[seat] = { wake: 0, ring: 0, blink: 2 + Math.random() * 3, blinkT: 0, bub: 0, fire: 0, trail: 0, sx: 0, sy: 0, has: false });
  }

  // ---- baking -----------------------------------------------------------------------------------
  function bake(m) {
    map = m;
    pal = PALETTES[m.palette] || PALETTES.day;
    const BW = ARENA_W + MARGIN * 2, BH = ARENA_H + MARGIN * 2;
    land = makeCanvas(BW, BH);
    const lctx = land.getContext("2d");
    const img = lctx.createImageData(BW, BH);
    const data = img.data;
    const rocks = [];
    // Small islands read as boulders, big ones as grassy islets.
    const g = m.grid, cols = m.cols, cell = m.cell;
    const rockMask = m.rocks || [];
    for (let i = 0; i < rockMask.length; i++) rocks.push(rockMask[i]);
    const seed = m.seed;
    const L = [-0.55, -0.83];
    for (let py = 0; py < BH; py++) {
      const y = py - MARGIN;
      for (let px = 0; px < BW; px++) {
        const x = px - MARGIN;
        const d = m.depth(x, y);
        const o = (py * BW + px) * 4;
        if (d >= 0) {
          const a = 1 - sstep(0, 72, d);
          const s = 1 - sstep(0, 9, d);
          let r = mix(pal.shallow[0], pal.wet[0], s * 0.3), gg = mix(pal.shallow[1], pal.wet[1], s * 0.3), b = mix(pal.shallow[2], pal.wet[2], s * 0.3);
          let al = a * 0.86;
          if (d < 2.6) { const f = 1 - d / 2.6; r = mix(r, 255, f * 0.85); gg = mix(gg, 255, f * 0.85); b = mix(b, 255, f * 0.85); al = Math.max(al, 0.9); }
          data[o] = r; data[o + 1] = gg; data[o + 2] = b; data[o + 3] = al * 255;
          continue;
        }
        const n1 = valueNoise(x / 70, y / 70, seed + 1);
        const n2 = valueNoise(x / 7, y / 7, seed + 2);
        let lit = 0;
        if (d > -44) {
          let nx = m.depth(x + 4, y) - m.depth(x - 4, y), ny = m.depth(x, y + 4) - m.depth(x, y - 4);
          const nl = Math.hypot(nx, ny) || 1;
          lit = (nx / nl) * L[0] + (ny / nl) * L[1];
        }
        let isRock = false;
        for (let k = 0; k < rocks.length; k++) {
          const rk = rocks[k];
          if (Math.abs(x - rk.x) < rk.r + 20 && Math.abs(y - rk.y) < rk.r + 20) { isRock = true; break; }
        }
        let r, gg, b;
        if (isRock) {
          const h = sstep(0, -34, d);
          const br = 0.74 + 0.3 * lit * (1 - h * 0.6) + h * 0.2 + n2 * 0.05 + n1 * 0.04;
          r = pal.rock[0] * br; gg = pal.rock[1] * br; b = pal.rock[2] * br;
          if (d > -5) { const w = 1 - (-d) / 5; r = mix(r, pal.rock[0] * 0.5, w * 0.6); gg = mix(gg, pal.rock[1] * 0.5, w * 0.6); b = mix(b, pal.rock[2] * 0.55, w * 0.6); }
        } else {
          const band = sstep(-36, -17, d + n1 * 9);
          const wet = sstep(-9, -1, d);
          const sr = mix(pal.sand[0], pal.wet[0], wet), sg = mix(pal.sand[1], pal.wet[1], wet), sb = mix(pal.sand[2], pal.wet[2], wet);
          const gm = n1 * 0.5 + 0.5;
          const gr = mix(pal.grassA[0], pal.grassB[0], gm), ggr = mix(pal.grassA[1], pal.grassB[1], gm), gb = mix(pal.grassA[2], pal.grassB[2], gm);
          r = mix(gr, sr, band); gg = mix(ggr, sg, band); b = mix(gb, sb, band);
          const br = 1 + lit * 0.13 * band + n2 * 0.035;
          r *= br; gg *= br; b *= br;
        }
        data[o] = r > 255 ? 255 : r; data[o + 1] = gg > 255 ? 255 : gg; data[o + 2] = b > 255 ? 255 : b; data[o + 3] = 255;
      }
    }
    lctx.putImageData(img, 0, 0);

    // Decorations drawn with paths on top of the pixels.
    lctx.save();
    lctx.translate(MARGIN, MARGIN);
    const rng = makeRng(seed * 31 + 5);
    const rx = function () { return -MARGIN + rng() * BW; };
    const ry = function () { return -MARGIN + rng() * BH; };
    // reed beds: murky patch below the stalks
    for (let i = 0; i < m.reeds.length; i++) {
      const rd = m.reeds[i];
      const grd = lctx.createRadialGradient(rd.x, rd.y, rd.r * 0.2, rd.x, rd.y, rd.r * 1.05);
      grd.addColorStop(0, "rgba(40,90,50,0.5)"); grd.addColorStop(0.75, "rgba(40,90,50,0.34)"); grd.addColorStop(1, "rgba(40,90,50,0)");
      lctx.fillStyle = grd;
      lctx.beginPath(); lctx.arc(rd.x, rd.y, rd.r * 1.05, 0, TAU); lctx.fill();
    }
    // pebbles on the sand
    for (let i = 0; i < 420; i++) {
      const x = rx(), y = ry(), d = m.depth(x, y);
      if (d > -4 || d < -20) continue;
      lctx.fillStyle = "rgba(60,60,70,0.28)";
      lctx.beginPath(); lctx.ellipse(x, y, 1.5 + rng() * 2.5, 1.2 + rng() * 1.6, rng() * 3, 0, TAU); lctx.fill();
    }
    // grass tufts and flowers
    const tuft = "rgba(" + ((pal.grassB[0] * 0.72) | 0) + "," + ((pal.grassB[1] * 0.72) | 0) + "," + ((pal.grassB[2] * 0.72) | 0) + ",0.7)";
    lctx.lineCap = "round";
    for (let i = 0; i < 1500; i++) {
      const x = rx(), y = ry();
      if (m.depth(x, y) > -42) continue;
      lctx.strokeStyle = tuft; lctx.lineWidth = 1.5;
      lctx.beginPath(); lctx.moveTo(x - 3, y); lctx.lineTo(x - 4.5, y - 6); lctx.moveTo(x, y); lctx.lineTo(x, y - 8); lctx.moveTo(x + 3, y); lctx.lineTo(x + 4.5, y - 6); lctx.stroke();
    }
    if (pal.flowers) {
      const fc = ["#ffffff", "#ffe14a", "#ff9ecf", "#ffd1a8"];
      for (let i = 0; i < 260; i++) {
        const x = rx(), y = ry();
        if (m.depth(x, y) > -46) continue;
        lctx.fillStyle = fc[(rng() * fc.length) | 0];
        for (let k = 0; k < 5; k++) { const a = k / 5 * TAU; lctx.beginPath(); lctx.arc(x + Math.cos(a) * 2.2, y + Math.sin(a) * 2.2, 1.6, 0, TAU); lctx.fill(); }
        lctx.fillStyle = "#f2a900"; lctx.beginPath(); lctx.arc(x, y, 1.3, 0, TAU); lctx.fill();
      }
    }
    // cracks and moss on boulders
    for (let i = 0; i < rocks.length; i++) {
      const rk = rocks[i];
      lctx.strokeStyle = "rgba(20,26,40,0.28)"; lctx.lineWidth = 1.6;
      for (let k = 0; k < 3; k++) {
        const a = rng() * TAU, r0 = rk.r * (0.1 + rng() * 0.3), r1 = rk.r * (0.5 + rng() * 0.3);
        lctx.beginPath(); lctx.moveTo(rk.x + Math.cos(a) * r0, rk.y + Math.sin(a) * r0);
        lctx.lineTo(rk.x + Math.cos(a + 0.3) * (r0 + r1) * 0.5, rk.y + Math.sin(a + 0.3) * (r0 + r1) * 0.5);
        lctx.lineTo(rk.x + Math.cos(a + 0.1) * r1, rk.y + Math.sin(a + 0.1) * r1); lctx.stroke();
      }
      lctx.fillStyle = "rgba(255,255,255,0.16)";
      lctx.beginPath(); lctx.ellipse(rk.x - rk.r * 0.25, rk.y - rk.r * 0.3, rk.r * 0.42, rk.r * 0.26, -0.5, 0, TAU); lctx.fill();
    }
    // trees and bushes on the far land
    const trees = [];
    for (let i = 0; i < 600 && trees.length < 46; i++) {
      const x = rx(), y = ry();
      if (m.depth(x, y) > -64 && x > -40 && x < ARENA_W + 40 && y > -40 && y < ARENA_H + 40) continue;
      if (x > 60 && x < ARENA_W - 60 && y > 0 && y < 78) continue;      // keep the HUD strip readable
      let ok = true;
      for (let k = 0; k < trees.length; k++) if (Math.hypot(trees[k].x - x, trees[k].y - y) < 56) ok = false;
      if (ok) trees.push({ x: x, y: y, r: 26 + rng() * 22 });
    }
    trees.sort(function (a, b) { return a.y - b.y; });
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      lctx.fillStyle = "rgba(10,20,30,0.22)";
      lctx.beginPath(); lctx.ellipse(t.x + t.r * 0.35, t.y + t.r * 0.5, t.r * 1.05, t.r * 0.8, 0, 0, TAU); lctx.fill();
      const base = pal.tree;
      for (let k = 0; k < 5; k++) {
        const a = k / 5 * TAU + i, rr = t.r * (0.55 + rng() * 0.2);
        const sh = 0.86 + k * 0.06;
        lctx.fillStyle = rgb([base[0] * sh, base[1] * sh, base[2] * sh]);
        lctx.beginPath(); lctx.arc(t.x + Math.cos(a) * t.r * 0.42, t.y + Math.sin(a) * t.r * 0.42, rr, 0, TAU); lctx.fill();
      }
      lctx.fillStyle = rgb([base[0] * 1.25, base[1] * 1.25, base[2] * 1.2]);
      lctx.beginPath(); lctx.arc(t.x - t.r * 0.2, t.y - t.r * 0.25, t.r * 0.5, 0, TAU); lctx.fill();
      if (m.palette === "frost") {
        lctx.fillStyle = "rgba(255,255,255,0.8)";
        lctx.beginPath(); lctx.arc(t.x - t.r * 0.2, t.y - t.r * 0.3, t.r * 0.42, 0, TAU); lctx.fill();
      }
    }
    lctx.restore();

    // foam contours via marching squares on the depth grid
    contours = [];
    const levels = [5, 12, 20];
    for (let li = 0; li < levels.length; li++) {
      const lv = levels[li];
      const path = new Path2D();
      const rows = m.rows;
      for (let j = 0; j < rows - 1; j++) {
        for (let i = 0; i < cols - 1; i++) {
          const a = g[j * cols + i] - lv, b = g[j * cols + i + 1] - lv, c = g[(j + 1) * cols + i + 1] - lv, d = g[(j + 1) * cols + i] - lv;
          const idx = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (c > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
          if (idx === 0 || idx === 15) continue;
          const x0 = i * cell, y0 = j * cell;
          const top = [x0 + cell * (a / (a - b)), y0], right = [x0 + cell, y0 + cell * (b / (b - c))];
          const bottom = [x0 + cell * (d / (d - c)), y0 + cell], left = [x0, y0 + cell * (a / (a - d))];
          const seg = function (p, q) { path.moveTo(p[0], p[1]); path.lineTo(q[0], q[1]); };
          switch (idx) {
            case 1: case 14: seg(left, top); break;
            case 2: case 13: seg(top, right); break;
            case 3: case 12: seg(left, right); break;
            case 4: case 11: seg(right, bottom); break;
            case 6: case 9: seg(top, bottom); break;
            case 7: case 8: seg(left, bottom); break;
            case 5: seg(left, top); seg(right, bottom); break;
            case 10: seg(top, right); seg(left, bottom); break;
            default: break;
          }
        }
      }
      contours.push(path);
    }

    // reed stalks
    stalks = [];
    for (let i = 0; i < m.reeds.length; i++) {
      const rd = m.reeds[i];
      const n = Math.round(rd.r * rd.r / 150);
      for (let k = 0; k < n; k++) {
        const a = rng() * TAU, rr2 = Math.sqrt(rng()) * rd.r * 0.96;
        const x = rd.x + Math.cos(a) * rr2, y = rd.y + Math.sin(a) * rr2;
        if (m.depth(x, y) < -6) continue;
        stalks.push({ x: x, y: y, h: 22 + rng() * 20, ph: rng() * TAU, tail: rng() < 0.55, lean: (rng() - 0.5) * 10, sway: 0 });
      }
    }
    stalks.sort(function (a, b) { return a.y - b.y; });

    // lily pads
    lilies = [];
    for (let i = 0; i < 200 && lilies.length < m.lilyCount; i++) {
      const p = m.openWater[(rng() * m.openWater.length) | 0];
      if (!p) break;
      const x = p.x + (rng() - 0.5) * 36, y = p.y + (rng() - 0.5) * 36;
      if (m.inReeds(x, y) || m.depth(x, y) < 30) continue;
      let ok = true;
      for (let k = 0; k < lilies.length; k++) if (Math.hypot(lilies[k].x - x, lilies[k].y - y) < 70) ok = false;
      for (let k = 0; k < m.whirlpools.length; k++) if (Math.hypot(m.whirlpools[k].x - x, m.whirlpools[k].y - y) < m.whirlpools[k].r) ok = false;
      if (ok) lilies.push({ x: x, y: y, r: 11 + rng() * 9, rot: rng() * TAU, ph: rng() * TAU, flower: rng() < 0.35 });
    }

    // drifting specks that show currents and whirlpools
    flowDust = [];
    if (m.current || m.whirlpools.length) {
      for (let i = 0; i < 90; i++) {
        const p = m.openWater[(rng() * m.openWater.length) | 0];
        if (p) flowDust.push({ x: p.x + (rng() - 0.5) * 40, y: p.y + (rng() - 0.5) * 40, life: rng() * 3, px: p.x, py: p.y });
      }
    }
    for (const k in cos) delete cos[k];
  }

  // ---- sizing -----------------------------------------------------------------------------------
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = Math.max(320, Math.floor(canvas.clientWidth * dpr));
    let h = Math.max(180, Math.floor(canvas.clientHeight * dpr));
    const cap = quality > 0 ? 1920 : 1280;
    if (w > cap) { h = Math.round(h * cap / w); w = cap; }
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const sx = safe.left * w, sy = safe.top * h, sw = (safe.right - safe.left) * w, sh = (safe.bottom - safe.top) * h;
    const scale = Math.min(sw / ARENA_W, sh / ARENA_H);
    view = { scale: scale, ox: sx + (sw - ARENA_W * scale) / 2, oy: sy + (sh - ARENA_H * scale) / 2, w: w, h: h };
    causticPattern = null;
  }

  // ---- per-frame cosmetic updates (wakes, bubbles, reed rustle) ---------------------------------
  function update(world, dt, time) {
    if (!world) return;
    for (let i = 0; i < world.ducks.length; i++) {
      const d = world.ducks[i];
      const c = cosFor(d.seat);
      c.blink -= dt;
      if (c.blink <= 0) { c.blink = 2 + Math.random() * 4; c.blinkT = 0.12; }
      if (c.blinkT > 0) c.blinkT -= dt;
      if (!d.alive && !d.ghost) continue;
      const sp = Math.hypot(d.vx, d.vy);
      if (d.dive > 0) {
        c.bub -= dt;
        if (c.bub <= 0) { c.bub = 0.05; fx.bubbles(d.x, d.y, 1, 10); }
        continue;
      }
      if (d.ghost) continue;
      if (sp > 45) {
        c.wake -= dt;
        if (c.wake <= 0 && quality > 0) {
          c.wake = 0.055;
          const bx = d.x - Math.cos(d.facing) * 20, by = d.y - Math.sin(d.facing) * 20;
          fx.foam(bx, by, 4 + sp * 0.018, 0.55);
        }
        c.ring -= dt;
        if (c.ring <= 0) { c.ring = 0.3; fx.ring(d.x, d.y + 2, 16, 38, 0.8, 1.6); }
      } else {
        c.ring -= dt;
        if (c.ring <= 0) { c.ring = 1.4 + Math.random(); fx.ring(d.x, d.y + 2, 20, 34, 1.1, 1.2); }
      }
      if (d.burn > 0) { c.fire -= dt; if (c.fire <= 0) { c.fire = 0.04; fx.fire(d.x, d.y); } }
      if (d.turbo > 0 && sp > 60) { c.trail -= dt; if (c.trail <= 0) { c.trail = 0.05; fx.sparks(d.x - Math.cos(d.facing) * 18, d.y - Math.sin(d.facing) * 18, 1, "255,225,74", 80); } }
    }
    // reeds rustle when something moves through them
    for (let i = 0; i < stalks.length; i++) {
      const s = stalks[i];
      let push = 0;
      for (let k = 0; k < world.ducks.length; k++) {
        const d = world.ducks[k];
        if ((!d.alive && !d.ghost) || d.dive > 0) continue;
        const dx = s.x - d.x, dy = s.y - d.y;
        if (dx > -34 && dx < 34 && dy > -34 && dy < 34) {
          const dist = Math.hypot(dx, dy);
          if (dist < 34) push += (1 - dist / 34) * (dx >= 0 ? 1 : -1) * (0.4 + Math.min(1, Math.hypot(d.vx, d.vy) / 150));
        }
      }
      s.sway += (push * 13 - s.sway) * Math.min(1, dt * 9);
    }
    // flow specks
    const f = { x: 0, y: 0 };
    for (let i = 0; i < flowDust.length; i++) {
      const p = flowDust[i];
      p.life -= dt;
      map.flow(p.x, p.y, f);
      p.px = p.x; p.py = p.y;
      p.x += f.x * dt * 1.6; p.y += f.y * dt * 1.6;
      if (p.life <= 0 || map.depth(p.x, p.y) < 14) {
        const q = map.openWater[(Math.random() * map.openWater.length) | 0];
        p.x = p.px = q.x + (Math.random() - 0.5) * 40; p.y = p.py = q.y + (Math.random() - 0.5) * 40; p.life = 1.5 + Math.random() * 2.5;
      }
    }
  }

  // ---- drawing ----------------------------------------------------------------------------------
  function drawWater(time) {
    ctx.fillStyle = rgb(pal.deep);
    ctx.fillRect(-MARGIN, -MARGIN, ARENA_W + MARGIN * 2, ARENA_H + MARGIN * 2);
    if (quality > 0) {
      if (!causticPattern) causticPattern = ctx.createPattern(caustic, "repeat");
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = causticPattern;
      for (let l = 0; l < 2; l++) {
        const sc = l ? 1.7 : 2.6;
        const ox = (time * (l ? 9 : -6)) % (256 * sc), oy = (time * (l ? 5 : 8)) % (256 * sc);
        ctx.save();
        ctx.translate(ox, oy); ctx.scale(sc, sc);
        ctx.globalAlpha = pal.caustic * (l ? 0.8 : 1);
        ctx.fillRect(-ox / sc - 2, -oy / sc - 2, ARENA_W / sc + 4, ARENA_H / sc + 4);
        ctx.restore();
      }
      ctx.restore();
    }
  }

  function drawWhirlpools(time) {
    for (let i = 0; i < map.whirlpools.length; i++) {
      const w = map.whirlpools[i];
      ctx.save();
      ctx.translate(w.x, w.y);
      const grd = ctx.createRadialGradient(0, 0, 4, 0, 0, w.r * 0.7);
      grd.addColorStop(0, "rgba(4,10,40,0.75)"); grd.addColorStop(0.25, "rgba(6,20,60,0.4)"); grd.addColorStop(1, "rgba(6,20,60,0)");
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(0, 0, w.r * 0.7, 0, TAU); ctx.fill();
      ctx.lineCap = "round";
      for (let arm = 0; arm < 5; arm++) {
        ctx.beginPath();
        for (let s = 0; s <= 26; s++) {
          const k = s / 26;
          const r = w.r * (0.06 + k * 0.92);
          const a = arm * TAU / 5 + time * 1.5 + k * 4.2;
          const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.94;
          if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = "rgba(255,255,255,0.3)"; ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawFoam(time) {
    ctx.lineCap = "round";
    for (let i = 0; i < contours.length; i++) {
      const a = Math.max(0, Math.sin(time * 1.25 - i * 1.9)) * 0.42;
      if (a < 0.02) continue;
      ctx.strokeStyle = "rgba(255,255,255," + a.toFixed(3) + ")";
      ctx.lineWidth = 2.6 - i * 0.5;
      ctx.stroke(contours[i]);
    }
  }

  function drawLilies(time) {
    for (let i = 0; i < lilies.length; i++) {
      const l = lilies[i];
      ctx.save();
      ctx.translate(l.x + Math.sin(time * 0.6 + l.ph) * 2.5, l.y + Math.cos(time * 0.5 + l.ph) * 2);
      ctx.rotate(l.rot + Math.sin(time * 0.4 + l.ph) * 0.12);
      ctx.fillStyle = "rgba(8,30,60,0.2)";
      ctx.beginPath(); ctx.arc(2, 4, l.r, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, l.r, 0.28, TAU - 0.28); ctx.closePath();
      ctx.fillStyle = map.palette === "night" ? "#2f7d5b" : "#57b85a"; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = map.palette === "night" ? "#1c4e3d" : "#2f7d32"; ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.22)"; ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let k = 1; k < 6; k++) { const a = 0.28 + k * (TAU - 0.56) / 6; ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * l.r * 0.8, Math.sin(a) * l.r * 0.8); }
      ctx.stroke();
      if (l.flower) {
        for (let k = 0; k < 6; k++) {
          const a = k / 6 * TAU;
          ctx.beginPath(); ctx.ellipse(-2 + Math.cos(a) * 4, Math.sin(a) * 4, 4, 2.4, a, 0, TAU);
          ctx.fillStyle = "#ffc2e2"; ctx.fill();
        }
        ctx.beginPath(); ctx.arc(-2, 0, 2.4, 0, TAU); ctx.fillStyle = "#ffe14a"; ctx.fill();
      }
      ctx.restore();
    }
  }

  function drawReeds(time) {
    ctx.lineCap = "round";
    const dark = map.palette === "frost" ? "#6d8a78" : (map.palette === "night" ? "#1f5a45" : "#2f7d32");
    const lite = map.palette === "frost" ? "#9db8a4" : (map.palette === "night" ? "#2f7d5b" : "#58b04a");
    for (let i = 0; i < stalks.length; i++) {
      const s = stalks[i];
      const sw = Math.sin(time * 1.4 + s.ph) * 2.6 + s.sway + s.lean;
      const tx = s.x + sw, ty = s.y - s.h;
      ctx.strokeStyle = dark; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.quadraticCurveTo(s.x + sw * 0.2, s.y - s.h * 0.6, tx, ty); ctx.stroke();
      ctx.strokeStyle = lite; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.quadraticCurveTo(s.x + sw * 0.2, s.y - s.h * 0.6, tx, ty); ctx.stroke();
      // side blade
      ctx.strokeStyle = dark; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.quadraticCurveTo(s.x - 5 + sw * 0.3, s.y - s.h * 0.45, s.x - 9 + sw * 0.7, s.y - s.h * 0.72); ctx.stroke();
      if (s.tail) {
        ctx.save();
        ctx.translate(tx, ty + 5); ctx.rotate(sw * 0.03);
        roundRect(ctx, -3.2, -9, 6.4, 13, 3.2);
        ctx.fillStyle = "#7a4a21"; ctx.fill();
        ctx.lineWidth = 1.4; ctx.strokeStyle = "#3d230d"; ctx.stroke();
        ctx.restore();
      }
    }
  }

  function drawZone(world, time) {
    const z = world.zone;
    if (!z || !z.active) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(-MARGIN, -MARGIN, ARENA_W + MARGIN * 2, ARENA_H + MARGIN * 2);
    ctx.arc(z.x, z.y, z.r, 0, TAU, true);
    ctx.fillStyle = "rgba(150,16,44,0.3)";
    ctx.fill("evenodd");
    ctx.setLineDash([16, 12]); ctx.lineDashOffset = -time * 40;
    ctx.lineWidth = 4; ctx.strokeStyle = "rgba(255,80,110,0.9)";
    ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 9; ctx.strokeStyle = "rgba(255,80,110,0.18)";
    ctx.beginPath(); ctx.arc(z.x, z.y, z.r + 5, 0, TAU); ctx.stroke();
    ctx.restore();
  }

  function drawPickup(p, time) {
    ctx.save();
    if (p.fall > 0) {
      const k = p.fall / 1.15;             // 1 -> 0
      ctx.fillStyle = "rgba(8,30,60," + (0.3 * (1 - k)).toFixed(3) + ")";
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 4, 16 * (1.4 - k * 0.6), 11 * (1.4 - k * 0.6), 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255," + (0.5 * (1 - k)).toFixed(3) + ")"; ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]); ctx.lineDashOffset = time * 30;
      ctx.beginPath(); ctx.arc(p.x, p.y, 24, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
      const h = k * k * 520;
      ctx.translate(p.x + Math.sin(time * 3 + p.wob) * 8 * k, p.y - h);
      // parachute
      ctx.strokeStyle = "rgba(40,40,60,0.8)"; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(-26, -40); ctx.lineTo(-9, -8); ctx.moveTo(26, -40); ctx.lineTo(9, -8); ctx.moveTo(0, -52); ctx.lineTo(0, -10); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-28, -40); ctx.quadraticCurveTo(0, -82, 28, -40); ctx.quadraticCurveTo(0, -50, -28, -40); ctx.closePath();
      ctx.fillStyle = "#ff5964"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#1d2433"; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-10, -58); ctx.quadraticCurveTo(0, -78, 10, -58); ctx.quadraticCurveTo(0, -52, -10, -58); ctx.fillStyle = "#ffffff"; ctx.fill();
    } else {
      const blink = p.life < 4 && Math.sin(time * 14) > 0;
      if (blink) ctx.globalAlpha = 0.4;
      ctx.fillStyle = "rgba(8,30,60,0.26)";
      ctx.beginPath(); ctx.ellipse(p.x + 2, p.y + 6, 19, 13, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 3, 21 + Math.sin(p.wob) * 1.5, 15, 0, 0, TAU); ctx.stroke();
      ctx.translate(p.x, p.y + Math.sin(p.wob) * 1.8);
      ctx.rotate(Math.sin(p.wob * 0.7) * 0.08);
    }
    if (p.kind === "w") {
      drawCrate(ctx, 15);
      ctx.fillStyle = WEAPONS[p.w].color; ctx.globalAlpha *= 0.9;
      ctx.beginPath(); ctx.arc(0, 0, 11, 0, TAU); ctx.fill();
      ctx.lineWidth = 1.6; ctx.strokeStyle = "#1d2433"; ctx.stroke();
      drawWeaponIcon(ctx, p.w, 0.5);
    } else if (p.kind === "bread") {
      drawBread(ctx, false, time);
    } else if (p.kind === "shield") {
      drawShieldIcon(ctx);
    } else {
      ctx.fillStyle = "rgba(255,225,74,0.25)"; ctx.beginPath(); ctx.arc(0, 0, 15, 0, TAU); ctx.fill();
      drawTurboIcon(ctx);
    }
    ctx.restore();
  }

  function drawBullet(b, alpha, time) {
    const x = b.px + (b.x - b.px) * alpha, y = b.py + (b.y - b.py) * alpha;
    const sp = Math.hypot(b.vx, b.vy) || 1;
    const ux = b.vx / sp, uy = b.vy / sp;
    ctx.lineCap = "round";
    switch (b.type) {
      case "pea":
        ctx.strokeStyle = "rgba(155,229,100,0.5)"; ctx.lineWidth = 6;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - ux * 16, y - uy * 16); ctx.stroke();
        ctx.fillStyle = "#9be564"; ctx.beginPath(); ctx.arc(x, y, 5.5, 0, TAU); ctx.fill();
        ctx.lineWidth = 1.8; ctx.strokeStyle = "#2f6b12"; ctx.stroke();
        ctx.fillStyle = "#e4ffd0"; ctx.beginPath(); ctx.arc(x - 1.5, y - 1.5, 1.8, 0, TAU); ctx.fill();
        break;
      case "pellet":
        ctx.strokeStyle = "rgba(255,190,110,0.7)"; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - ux * 14, y - uy * 14); ctx.stroke();
        ctx.fillStyle = "#fff1d0"; ctx.beginPath(); ctx.arc(x, y, 3.4, 0, TAU); ctx.fill();
        break;
      case "smg":
        ctx.strokeStyle = "rgba(246,226,127,0.85)"; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - ux * 20, y - uy * 20); ctx.stroke();
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - ux * 8, y - uy * 8); ctx.stroke();
        break;
      case "sniper":
        ctx.strokeStyle = "rgba(200,182,255,0.55)"; ctx.lineWidth = 7;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - ux * 90, y - uy * 90); ctx.stroke();
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2.6;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - ux * 60, y - uy * 60); ctx.stroke();
        break;
      case "stone":
        ctx.save(); ctx.translate(x, y); ctx.rotate(time * 14 + b.id);
        ctx.fillStyle = "rgba(8,30,60,0.25)"; ctx.beginPath(); ctx.ellipse(2, 4, 7, 5, 0, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.ellipse(0, 0, 7, 5, 0, 0, TAU); ctx.fillStyle = "#cfd2cd"; ctx.fill();
        ctx.lineWidth = 1.8; ctx.strokeStyle = "#3b3f46"; ctx.stroke();
        ctx.restore();
        break;
      case "rocket":
        ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(uy, ux));
        ctx.fillStyle = "rgba(255,200,80,0.9)";
        ctx.beginPath(); ctx.moveTo(-10, -3.5); ctx.lineTo(-20 - Math.random() * 10, 0); ctx.lineTo(-10, 3.5); ctx.closePath(); ctx.fill();
        roundRect(ctx, -10, -4.5, 17, 9, 3); ctx.fillStyle = "#e9ecef"; ctx.fill(); ctx.lineWidth = 1.8; ctx.strokeStyle = "#1d2433"; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(7, -4.5); ctx.quadraticCurveTo(16, 0, 7, 4.5); ctx.closePath(); ctx.fillStyle = "#ff5964"; ctx.fill(); ctx.stroke();
        ctx.restore();
        break;
      case "egg": {
        const h = b.h || 0;
        ctx.fillStyle = "rgba(8,30,60," + (0.3 - h * 0.0016).toFixed(3) + ")";
        ctx.beginPath(); ctx.ellipse(x, y + 4, 8 + h * 0.03, 6 + h * 0.02, 0, 0, TAU); ctx.fill();
        // landing marker
        ctx.strokeStyle = "rgba(255,90,90,0.75)"; ctx.lineWidth = 2; ctx.setLineDash([7, 6]); ctx.lineDashOffset = time * 40;
        ctx.beginPath(); ctx.arc(b.tx, b.ty, 26, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
        ctx.save(); ctx.translate(x, y - h); ctx.rotate(time * 9); ctx.scale(1 + h * 0.004, 1 + h * 0.004);
        ctx.beginPath(); ctx.ellipse(0, 0, 9, 7, 0, 0, TAU); ctx.fillStyle = "#fff4d6"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#1d2433"; ctx.stroke();
        ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.ellipse(-2.5, -2, 2.6, 1.6, -0.5, 0, TAU); ctx.fill();
        ctx.restore();
        break;
      }
      default: break;
    }
  }

  function drawTorpedo(b, alpha) {
    const x = b.px + (b.x - b.px) * alpha, y = b.py + (b.y - b.py) * alpha;
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(b.vy, b.vx));
    ctx.globalAlpha = 0.8;
    roundRect(ctx, -12, -5, 22, 10, 5); ctx.fillStyle = "#0e2a4a"; ctx.fill();
    ctx.beginPath(); ctx.moveTo(10, -5); ctx.quadraticCurveTo(20, 0, 10, 5); ctx.closePath(); ctx.fillStyle = "#3aa0d8"; ctx.fill();
    ctx.restore();
  }

  function drawDuckEntity(d, alpha, time, world) {
    const x = d.px + (d.x - d.px) * alpha, y = d.py + (d.y - d.py) * alpha;
    const c = cosFor(d.seat);
    ctx.save();
    ctx.translate(x, y + Math.sin(d.wob) * 1.3);
    const sp = Math.hypot(d.vx, d.vy);
    let a = 1;
    if (d.ghost) a = 0.42;
    else if (d.hidden) a = 0.2;
    else if (d.invuln > 0) a = 0.55 + 0.3 * Math.sin(time * 22);
    if (!d.ghost) {
      ctx.fillStyle = "rgba(8,30,60," + (0.26 * a).toFixed(3) + ")";
      ctx.beginPath(); ctx.ellipse(3, 7, 24, 17, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255," + (0.32 * a).toFixed(3) + ")"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(0, 3, 26, 20, 0, 0, TAU); ctx.stroke();
    }
    const loafHere = world.loaf && world.loaf.holder === d.seat;
    if (loafHere) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 6);
      ctx.strokeStyle = "rgba(255,214,60," + (0.5 + pulse * 0.4).toFixed(3) + ")"; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(0, 0, 33 + pulse * 3, 0, TAU); ctx.stroke();
      ctx.fillStyle = "rgba(255,214,60,0.14)"; ctx.fill();
    }
    let s = 1 + d.kick * 0.05;
    if (d.spawnT > 0) s *= easeOutBack(1 - d.spawnT / 0.5);
    ctx.scale(s, s);
    ctx.globalAlpha = a;
    let mood = "normal";
    if (d.burn > 0 || (world.zone && world.zone.active && Math.hypot(d.x - world.zone.x, d.y - world.zone.y) > world.zone.r)) mood = "scared";
    else if (d.input.fire && !d.ghost) mood = "angry";
    drawDuck(ctx, {
      color: d.color, hat: d.hat, facing: d.facing, aim: d.aim, paddle: d.paddle,
      kick: d.kick, flash: d.flash > 0, weapon: d.ghost ? -1 : d.weapon, blink: c.blinkT > 0,
      mood: mood, moving: Math.min(1, sp / 160), t: time
    });
    ctx.globalAlpha = 1;
    if (d.ghost) {
      ctx.strokeStyle = "rgba(255,240,150,0.9)"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(Math.cos(d.aim) * 12, Math.sin(d.aim) * 12 - 20, 11, 4.5, 0, 0, TAU); ctx.stroke();
    }
    if (d.shield > 0) {
      ctx.fillStyle = "rgba(120,220,255,0.2)"; ctx.strokeStyle = "rgba(220,250,255,0.85)"; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(0, 0, 33 + Math.sin(time * 5) * 1.2, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, 27, Math.PI * 1.1, Math.PI * 1.5); ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.stroke();
    }
    if (d.invuln > 0 && !d.ghost) {
      ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 2; ctx.setLineDash([5, 6]); ctx.lineDashOffset = time * 30;
      ctx.beginPath(); ctx.arc(0, 0, 31, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    }
    if (d.diveCd > 0 && !d.ghost) {
      ctx.strokeStyle = "rgba(160,235,255,0.75)"; ctx.lineWidth = 3; ctx.lineCap = "round";
      ctx.beginPath(); ctx.arc(0, 0, 30, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - d.diveCd / 2.2)); ctx.stroke();
    }
    ctx.restore();
  }

  function drawPlate(d, alpha, world, time) {
    if (d.hidden || d.dive > 0) return;
    const x = d.px + (d.x - d.px) * alpha, y = d.py + (d.y - d.py) * alpha;
    const col = COLORS[d.color % COLORS.length];
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.font = "600 15px " + FONT_UI;
    ctx.lineJoin = "round";
    const name = d.name.length > 12 ? d.name.slice(0, 11) + "…" : d.name;
    ctx.globalAlpha = d.ghost ? 0.55 : 1;
    ctx.lineWidth = 4; ctx.strokeStyle = "rgba(16,22,36,0.85)";
    ctx.strokeText(name, x, y - 44);
    ctx.fillStyle = d.ghost ? "#d8dde8" : col.light; ctx.fillText(name, x, y - 44);
    if (!d.ghost) {
      const w = 46, h = 7, bx = x - w / 2, by = y - 40;
      roundRect(ctx, bx - 1.5, by - 1.5, w + 3, h + 3, 4); ctx.fillStyle = "rgba(16,22,36,0.85)"; ctx.fill();
      const f = Math.max(0, d.hp / MAX_HP);
      if (f > 0) {
        roundRect(ctx, bx, by, Math.max(4, w * f), h, 3);
        ctx.fillStyle = f > 0.55 ? "#6be36b" : (f > 0.28 ? "#ffd23f" : "#ff5964"); ctx.fill();
      }
      if (d.shield > 0) { roundRect(ctx, bx, by - 4.5, w * Math.min(1, d.shield / 45), 3, 1.5); ctx.fillStyle = "#8fe3ff"; ctx.fill(); }
      if (d.weapon !== 0) {
        ctx.font = "600 12px " + FONT_UI; ctx.textAlign = "left";
        ctx.lineWidth = 3; ctx.strokeText("" + d.ammo, bx + w + 6, by + 7.5);
        ctx.fillStyle = WEAPONS[d.weapon].color; ctx.fillText("" + d.ammo, bx + w + 6, by + 7.5);
      }
    }
    ctx.globalAlpha = 1;
    if (world.loaf && world.loaf.holder === d.seat) {
      ctx.save(); ctx.translate(x, y - 70 + Math.sin(time * 5) * 3); ctx.scale(1.15, 1.15); drawBread(ctx, true, time); ctx.restore();
    }
  }

  function drawWorld(world, alpha, time) {
    drawWater(time);
    drawWhirlpools(time);

    // below the surface
    for (let i = 0; i < flowDust.length; i++) {
      const p = flowDust[i];
      ctx.strokeStyle = "rgba(255,255,255," + (0.3 * Math.min(1, p.life)).toFixed(3) + ")"; ctx.lineWidth = 2; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - (p.x - p.px) * 9, p.y - (p.y - p.py) * 9); ctx.stroke();
    }
    for (let i = 0; i < world.ducks.length; i++) {
      const d = world.ducks[i];
      if (!d.alive || d.dive <= 0) continue;
      const x = d.px + (d.x - d.px) * alpha, y = d.py + (d.y - d.py) * alpha;
      ctx.save(); ctx.translate(x, y); ctx.rotate(d.facing);
      const col = COLORS[d.color % COLORS.length];
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = "#06183a";
      ctx.beginPath(); ctx.ellipse(-2, 0, 19, 13, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(12, 0, 9, 0, TAU); ctx.fill();
      ctx.globalAlpha = 0.3; ctx.fillStyle = col.body;
      ctx.beginPath(); ctx.ellipse(-2, 0, 15, 9, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }
    for (let i = 0; i < world.bullets.length; i++) if (world.bullets[i].under) drawTorpedo(world.bullets[i], alpha);
    fx.drawUnder(ctx);

    // shore
    ctx.drawImage(land, -MARGIN, -MARGIN);
    drawFoam(time);
    drawLilies(time);
    drawZone(world, time);
    fx.draw(ctx, 0);

    // tsunami waves
    for (let i = 0; i < world.waves.length; i++) {
      const w = world.waves[i];
      const t = w.age / w.life;
      ctx.save(); ctx.translate(w.x, w.y); ctx.rotate(w.a);
      ctx.globalAlpha = 1 - t * t;
      const half = w.half || 44;
      ctx.lineCap = "round";
      for (let k = 0; k < 3; k++) {
        ctx.strokeStyle = k === 0 ? "rgba(76,201,240,0.55)" : "rgba(255,255,255," + (0.9 - k * 0.25) + ")";
        ctx.lineWidth = k === 0 ? 20 : 6 - k * 1.5;
        ctx.beginPath();
        ctx.moveTo(-18 - k * 9, -half); ctx.quadraticCurveTo(22 - k * 9, 0, -18 - k * 9, half);
        ctx.stroke();
      }
      ctx.restore();
    }

    // floating things
    for (let i = 0; i < world.mines.length; i++) {
      const m = world.mines[i];
      ctx.save(); ctx.translate(m.x, m.y + Math.sin(m.wob) * 1.5);
      ctx.fillStyle = "rgba(8,30,60,0.25)"; ctx.beginPath(); ctx.ellipse(2, 5, 14, 10, 0, 0, TAU); ctx.fill();
      drawMine(ctx, m.armed, m.fuse >= 0 ? Math.sin(time * 60) > 0 : Math.sin(time * 7 + m.id) > 0.6);
      ctx.restore();
    }
    for (let i = 0; i < world.barrels.length; i++) {
      const b = world.barrels[i];
      ctx.save();
      if (b.fall > 0) {
        const k = b.fall / 1.1;
        ctx.fillStyle = "rgba(8,30,60," + (0.3 * (1 - k)).toFixed(3) + ")";
        ctx.beginPath(); ctx.ellipse(b.x, b.y + 4, 18, 12, 0, 0, TAU); ctx.fill();
        ctx.translate(b.x, b.y - k * k * 520);
      } else {
        ctx.fillStyle = "rgba(8,30,60,0.26)"; ctx.beginPath(); ctx.ellipse(b.x + 2, b.y + 6, 19, 14, 0, 0, TAU); ctx.fill();
        ctx.translate(b.x, b.y + Math.sin(b.wob) * 1.6);
        ctx.rotate(Math.sin(b.wob * 0.6) * 0.1);
      }
      drawBarrel(ctx, b.fuse >= 0 && Math.sin(time * 70) > 0);
      ctx.restore();
    }
    for (let i = 0; i < world.pickups.length; i++) if (world.pickups[i].fall <= 0) drawPickup(world.pickups[i], time);
    if (world.loaf && world.loaf.holder < 0) {
      const l = world.loaf;
      ctx.save();
      ctx.translate(l.x, l.y + Math.sin(time * 3) * 2);
      const pulse = 0.5 + 0.5 * Math.sin(time * 5);
      ctx.fillStyle = "rgba(255,214,60," + (0.18 + pulse * 0.14).toFixed(3) + ")";
      ctx.beginPath(); ctx.arc(0, 0, 30 + pulse * 6, 0, TAU); ctx.fill();
      ctx.save(); ctx.rotate(time * 0.8);
      ctx.strokeStyle = "rgba(255,240,170,0.5)"; ctx.lineWidth = 3;
      for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; ctx.beginPath(); ctx.moveTo(Math.cos(a) * 22, Math.sin(a) * 22); ctx.lineTo(Math.cos(a) * 36, Math.sin(a) * 36); ctx.stroke(); }
      ctx.restore();
      ctx.scale(1.35, 1.35); drawBread(ctx, true, time);
      ctx.restore();
    }

    // sniper sights
    for (let i = 0; i < world.ducks.length; i++) {
      const d = world.ducks[i];
      if (!d.alive || d.weapon !== 6 || d.dive > 0 || d.hidden) continue;
      const x0 = d.x + Math.cos(d.aim) * 40, y0 = d.y + Math.sin(d.aim) * 40;
      const x1 = d.x + Math.cos(d.aim) * 900, y1 = d.y + Math.sin(d.aim) * 900;
      const f = map.rayLand(x0, y0, x1, y1, 0);
      ctx.strokeStyle = "rgba(255,60,90,0.45)"; ctx.lineWidth = 1.6; ctx.setLineDash([10, 8]); ctx.lineDashOffset = -time * 60;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f); ctx.stroke(); ctx.setLineDash([]);
    }

    // ducks, sorted so lower ones overlap higher ones
    const order = world.ducks.slice().sort(function (a, b) { return a.y - b.y; });
    for (let i = 0; i < order.length; i++) {
      const d = order[i];
      if ((!d.alive && !d.ghost) || d.dive > 0) continue;
      drawDuckEntity(d, alpha, time, world);
    }
    for (let i = 0; i < world.bullets.length; i++) if (!world.bullets[i].under) drawBullet(world.bullets[i], alpha, time);

    drawReeds(time);
    fx.draw(ctx, 1);
    for (let i = 0; i < world.pickups.length; i++) if (world.pickups[i].fall > 0) drawPickup(world.pickups[i], time);
    for (let i = 0; i < order.length; i++) {
      const d = order[i];
      if (!d.alive && !d.ghost) continue;
      if (!world.passive || d.deviceId !== undefined) drawPlate(d, alpha, world, time);
    }
    if (pal.overlay) {
      ctx.fillStyle = pal.overlay;
      ctx.fillRect(-MARGIN, -MARGIN, ARENA_W + MARGIN * 2, ARENA_H + MARGIN * 2);
    }
  }

  // ---- HUD --------------------------------------------------------------------------------------
  function drawHud(hud, time) {
    if (!hud) return;
    ctx.lineJoin = "round";
    // scoreboard pills
    const list = hud.scores || [];
    if (list.length) {
      const pw = Math.min(170, (ARENA_W - 60) / list.length - 8), ph = 42;
      const total = list.length * (pw + 8) - 8;
      let x = (ARENA_W - total) / 2;
      const y = 12;
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        const col = COLORS[s.color % COLORS.length];
        ctx.globalAlpha = s.out ? 0.55 : 1;
        roundRect(ctx, x, y, pw, ph, 21);
        ctx.fillStyle = "rgba(16,22,36,0.82)"; ctx.fill();
        ctx.lineWidth = s.lead ? 3.5 : 2; ctx.strokeStyle = s.lead ? "#ffd23f" : col.body; ctx.stroke();
        ctx.save();
        ctx.beginPath(); ctx.arc(x + 21, y + 21, 17, 0, TAU); ctx.fillStyle = col.dark; ctx.fill();
        ctx.clip();
        ctx.translate(x + 17, y + 21); ctx.scale(0.62, 0.62);
        drawDuck(ctx, { color: s.color, hat: s.hat, facing: 0, aim: 0, mood: s.out ? "dead" : "normal", t: time, weapon: -1 });
        ctx.restore();
        ctx.textBaseline = "middle"; ctx.textAlign = "left";
        ctx.font = "600 " + (pw > 140 ? 15 : 13) + "px " + FONT_UI;
        ctx.fillStyle = col.light;
        let name = s.name;
        const maxW = pw - 44 - 36;
        while (name.length > 2 && ctx.measureText(name).width > maxW) name = name.slice(0, -2) + "…";
        ctx.fillText(name, x + 43, y + 22);
        ctx.textAlign = "right"; ctx.font = "400 24px " + FONT_BIG; ctx.fillStyle = "#ffffff";
        ctx.fillText("" + s.score, x + pw - 13, y + 23);
        ctx.globalAlpha = 1;
        x += pw + 8;
      }
    }
    // centre info pill
    if (hud.info) {
      ctx.font = "600 17px " + FONT_UI; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const w = ctx.measureText(hud.info).width + 34;
      roundRect(ctx, ARENA_W / 2 - w / 2, 62, w, 30, 15);
      ctx.fillStyle = hud.infoHot ? "rgba(190,24,60,0.9)" : "rgba(16,22,36,0.72)"; ctx.fill();
      ctx.fillStyle = "#ffffff"; ctx.fillText(hud.info, ARENA_W / 2, 78);
    }
    // kill feed
    const feed = hud.feed || [];
    ctx.textBaseline = "middle";
    for (let i = 0; i < feed.length; i++) {
      const f = feed[i];
      const age = time - f.t;
      const a = age > 4.2 ? Math.max(0, 1 - (age - 4.2) / 0.6) : Math.min(1, age / 0.15);
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      ctx.font = "600 15px " + FONT_UI;
      const wa = f.a ? ctx.measureText(f.a).width : 0, wb = ctx.measureText(f.b).width;
      const w = wa + wb + 60;
      const x = ARENA_W - 18 - w, y = 104 + i * 32;
      roundRect(ctx, x, y, w, 27, 13.5); ctx.fillStyle = "rgba(16,22,36,0.78)"; ctx.fill();
      ctx.textAlign = "left";
      if (f.a) { ctx.fillStyle = COLORS[f.ca % COLORS.length].light; ctx.fillText(f.a, x + 12, y + 14); }
      ctx.save(); ctx.translate(x + 12 + wa + 18, y + 13.5);
      if (f.w >= 0) drawWeaponIcon(ctx, f.w, 0.5);
      else { ctx.font = "400 16px " + FONT_BIG; ctx.fillStyle = "#ff8fa3"; ctx.textAlign = "center"; ctx.fillText(f.icon || "✖", 0, 1); }
      ctx.restore();
      ctx.textAlign = "left"; ctx.font = "600 15px " + FONT_UI;
      ctx.fillStyle = COLORS[f.cb % COLORS.length].light; ctx.fillText(f.b, x + 12 + wa + 36, y + 14);
      ctx.globalAlpha = 1;
    }
    // announcer
    const b = hud.banner;
    if (b) {
      const age = time - b.t;
      if (age >= 0 && age < b.dur) {
        const pop = age < 0.28 ? easeOutBack(age / 0.28) : 1;
        const fade = age > b.dur - 0.3 ? (b.dur - age) / 0.3 : 1;
        ctx.save();
        ctx.translate(ARENA_W / 2, b.y || 330);
        ctx.scale(pop, pop);
        ctx.globalAlpha = Math.max(0, fade);
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const size = b.size || 110;
        ctx.font = "400 " + size + "px " + FONT_BIG;
        ctx.lineWidth = size * 0.16; ctx.strokeStyle = "#141a2a";
        ctx.strokeText(b.text, 0, 6);
        ctx.strokeText(b.text, 0, 0);
        ctx.fillStyle = b.color || "#ffffff"; ctx.fillText(b.text, 0, 0);
        if (b.sub) {
          ctx.font = "600 " + Math.max(22, size * 0.3) + "px " + FONT_UI;
          ctx.lineWidth = 7; ctx.strokeText(b.sub, 0, size * 0.72);
          ctx.fillStyle = "#ffffff"; ctx.fillText(b.sub, 0, size * 0.72);
        }
        ctx.restore();
      }
    }
  }

  function draw(world, o) {
    const time = o.time;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = rgb(pal.grassB);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!map || !world) return;
    const cam = fx.cam;
    const z = cam.zoom + cam.punch;
    const sc = view.scale * z;
    // zoom around the focus point, then clamp so we never look past the baked margin
    let tx = view.ox + (ARENA_W / 2) * view.scale - (ARENA_W / 2 + (cam.fx - ARENA_W / 2) * (1 - 1 / z)) * sc;
    let ty = view.oy + (ARENA_H / 2) * view.scale - (ARENA_H / 2 + (cam.fy - ARENA_H / 2) * (1 - 1 / z)) * sc;
    ctx.setTransform(sc, 0, 0, sc, tx + cam.ox * view.scale, ty + cam.oy * view.scale);
    if (cam.rot) { ctx.translate(ARENA_W / 2, ARENA_H / 2); ctx.rotate(cam.rot); ctx.translate(-ARENA_W / 2, -ARENA_H / 2); }
    drawWorld(world, o.alpha, time);

    ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);
    ctx.globalAlpha = 1;
    if (o.dim) { ctx.fillStyle = "rgba(10,16,34," + o.dim + ")"; ctx.fillRect(-view.ox / view.scale, -view.oy / view.scale, view.w / view.scale, view.h / view.scale); }
    drawHud(o.hud, time);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  return {
    bake: bake,
    resize: resize,
    update: update,
    draw: draw,
    setSafeArea: function (s) { safe = s; resize(); },
    setQuality: function (q) { if (q !== quality) { quality = q; resize(); } },
    getQuality: function () { return quality; },
    palette: function () { return pal; }
  };
}

export { WEAPON_LEN };
