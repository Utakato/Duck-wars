// Vector art for ducks, hats, weapons and pickups. Everything is drawn with canvas paths so the
// game ships without a single image file. Used by the screen and by the controller's avatar.
// Ducks are drawn top-down, centred on the origin, body pointing along +x.
import { COLORS, HATS, WEAPONS } from "./config.js";

const TAU = Math.PI * 2;
const INK = "#1d2433";
const BEAK = "#ff9f1c";
const BEAK_DARK = "#d9730d";

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
  ctx.lineTo(x + rr, y + h);
  ctx.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + rr);
  ctx.arc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

function ell(ctx, x, y, rx, ry, rot) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot || 0, 0, TAU);
}

function fillStroke(ctx, fill, stroke, lw) {
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.lineWidth = lw || 2.4; ctx.strokeStyle = stroke; ctx.stroke(); }
}

// ---- hats (drawn around the head centre, head pointing +x) -------------------------------------
export function drawHat(ctx, hatIndex, t) {
  const id = HATS[hatIndex] ? HATS[hatIndex].id : "none";
  ctx.lineJoin = "round";
  if (id === "none") return;
  if (id === "tophat") {
    ell(ctx, -1, 0, 11, 11); fillStroke(ctx, "#23262e", INK, 2);
    ell(ctx, -1, 0, 7, 7); fillStroke(ctx, "#c1121f", null);
    ell(ctx, -1, 0, 5.6, 5.6); fillStroke(ctx, "#3a3f4b", null);
    ell(ctx, -2.5, -1.5, 2.2, 1.6, -0.6); fillStroke(ctx, "rgba(255,255,255,0.35)", null);
  } else if (id === "pirate") {
    ctx.beginPath();
    ctx.moveTo(11, 0); ctx.quadraticCurveTo(2, -4, -9, -13); ctx.quadraticCurveTo(-5, 0, -9, 13); ctx.quadraticCurveTo(2, 4, 11, 0);
    ctx.closePath(); fillStroke(ctx, "#23262e", INK, 2);
    ell(ctx, -1, 0, 3, 3); fillStroke(ctx, "#f1f1f1", null);
    ctx.strokeStyle = "#f1f1f1"; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(-5, -4); ctx.lineTo(3, 4); ctx.moveTo(-5, 4); ctx.lineTo(3, -4); ctx.stroke();
  } else if (id === "viking") {
    ctx.lineCap = "round"; ctx.strokeStyle = INK; ctx.lineWidth = 6.5;
    ctx.beginPath(); ctx.moveTo(-1, -8); ctx.quadraticCurveTo(-1, -16, 7, -17); ctx.moveTo(-1, 8); ctx.quadraticCurveTo(-1, 16, 7, 17); ctx.stroke();
    ctx.strokeStyle = "#f3e9d2"; ctx.lineWidth = 3.6;
    ctx.beginPath(); ctx.moveTo(-1, -8); ctx.quadraticCurveTo(-1, -16, 7, -17); ctx.moveTo(-1, 8); ctx.quadraticCurveTo(-1, 16, 7, 17); ctx.stroke();
    ell(ctx, -1, 0, 9.5, 9.5); fillStroke(ctx, "#9aa5b1", INK, 2);
    ctx.strokeStyle = "#6b7684"; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(8, 0); ctx.stroke();
    ell(ctx, -1, 0, 2.2, 2.2); fillStroke(ctx, "#e9c46a", null);
  } else if (id === "crown") {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = i / 10 * TAU, r = i % 2 ? 7.5 : 12.5;
      if (i === 0) ctx.moveTo(-1 + Math.cos(a) * r, Math.sin(a) * r); else ctx.lineTo(-1 + Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath(); fillStroke(ctx, "#ffd23f", "#9c6b00", 2);
    ell(ctx, -1, 0, 5, 5); fillStroke(ctx, "#c1121f", "#9c6b00", 1.4);
    ell(ctx, -2.2, -1.2, 1.6, 1.1, -0.6); fillStroke(ctx, "rgba(255,255,255,0.6)", null);
  } else if (id === "cowboy") {
    ell(ctx, -1, 0, 12.5, 15); fillStroke(ctx, "#a9713d", "#5b3716", 2);
    ell(ctx, -1, 0, 7, 8); fillStroke(ctx, "#c58b55", "#5b3716", 1.6);
    ctx.strokeStyle = "#5b3716"; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(4, 0); ctx.stroke();
  } else if (id === "propeller") {
    const cols = ["#ff5964", "#ffd23f", "#41b0ff", "#7be04a"];
    for (let i = 0; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(-1, 0); ctx.arc(-1, 0, 9.5, i * TAU / 4, (i + 1) * TAU / 4); ctx.closePath();
      ctx.fillStyle = cols[i]; ctx.fill();
    }
    ell(ctx, -1, 0, 9.5, 9.5); ctx.lineWidth = 2; ctx.strokeStyle = INK; ctx.stroke();
    ctx.save(); ctx.translate(-1, 0); ctx.rotate((t || 0) * 14);
    ell(ctx, 0, 0, 13, 2.6); fillStroke(ctx, "#f1f1f1", INK, 1.4);
    ctx.restore();
    ell(ctx, -1, 0, 2.4, 2.4); fillStroke(ctx, "#c1121f", INK, 1.2);
  } else if (id === "chef") {
    ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "#aab4c3"; ctx.lineWidth = 1.6;
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * TAU;
      ell(ctx, -1 + Math.cos(a) * 6.5, Math.sin(a) * 6.5, 5.4, 5.4); ctx.fill(); ctx.stroke();
    }
    ell(ctx, -1, 0, 7.5, 7.5); ctx.fill();
  } else if (id === "party") {
    ell(ctx, -1, 0, 9.5, 9.5); fillStroke(ctx, "#ff4fa3", INK, 2);
    ctx.strokeStyle = "#ffe14a"; ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const a = i / 40 * TAU * 2.2, r = 8.2 * (1 - i / 40);
      const x = -1 + Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ell(ctx, -1, 0, 2.8, 2.8); fillStroke(ctx, "#ffffff", INK, 1.2);
  } else if (id === "ninja") {
    const sway = Math.sin((t || 0) * 5) * 2.5;
    ctx.strokeStyle = INK; ctx.lineWidth = 6.4; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-9, 2); ctx.quadraticCurveTo(-16, 5 + sway, -22, 2 - sway); ctx.moveTo(-9, -1); ctx.quadraticCurveTo(-15, -6 - sway, -20, -5 + sway); ctx.stroke();
    ctx.strokeStyle = "#d62839"; ctx.lineWidth = 3.6;
    ctx.beginPath(); ctx.moveTo(-9, 2); ctx.quadraticCurveTo(-16, 5 + sway, -22, 2 - sway); ctx.moveTo(-9, -1); ctx.quadraticCurveTo(-15, -6 - sway, -20, -5 + sway); ctx.stroke();
    ctx.lineCap = "butt"; ctx.strokeStyle = INK; ctx.lineWidth = 8.4;
    ctx.beginPath(); ctx.arc(0, 0, 9.6, 2.0, TAU - 2.0); ctx.stroke();
    ctx.strokeStyle = "#d62839"; ctx.lineWidth = 5.6;
    ctx.beginPath(); ctx.arc(0, 0, 9.6, 2.0, TAU - 2.0); ctx.stroke();
  } else if (id === "flower") {
    ctx.beginPath(); ctx.moveTo(-1, 0); ctx.arc(-1, 0, 11, 0.35, TAU - 0.35); ctx.closePath();
    fillStroke(ctx, "#4caf50", "#256b2a", 2);
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * TAU + 0.3;
      ell(ctx, -1 + Math.cos(a) * 4.2, Math.sin(a) * 4.2, 3.6, 2.4, a); fillStroke(ctx, "#ffb3d9", "#d1589a", 1);
    }
    ell(ctx, -1, 0, 2.2, 2.2); fillStroke(ctx, "#ffe14a", null);
  } else if (id === "bucket") {
    ell(ctx, -1, 0, 12, 12); fillStroke(ctx, "#5aa9e6", "#1d4f7c", 2);
    ell(ctx, -1, 0, 7.6, 7.6); fillStroke(ctx, "#3d8bd1", "#1d4f7c", 1.6);
    ctx.setLineDash([2.4, 2.4]); ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 1.1;
    ell(ctx, -1, 0, 9.8, 9.8); ctx.stroke(); ctx.setLineDash([]);
  }
}

// ---- weapons (drawn pointing +x, grip at the origin) -------------------------------------------
export function drawWeapon(ctx, w, t) {
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  const id = WEAPONS[w] ? WEAPONS[w].id : "pea";
  if (id === "pea") {
    roundRect(ctx, 0, -3, 17, 6, 2.5); fillStroke(ctx, "#74c043", INK, 2);
    ell(ctx, 1, 0, 5, 5); fillStroke(ctx, "#9be564", INK, 2);
    ell(ctx, 17, 0, 2.4, 3.6); fillStroke(ctx, "#4c8a25", INK, 1.4);
  } else if (id === "shotgun") {
    roundRect(ctx, -6, -3.5, 12, 7, 2); fillStroke(ctx, "#8d5a2b", INK, 2);
    roundRect(ctx, 4, -4.4, 24, 4, 1.5); fillStroke(ctx, "#8e99a8", INK, 1.8);
    roundRect(ctx, 4, 0.4, 24, 4, 1.5); fillStroke(ctx, "#8e99a8", INK, 1.8);
    roundRect(ctx, 9, -5, 6, 10, 2); fillStroke(ctx, "#6b4420", INK, 1.6);
  } else if (id === "smg") {
    roundRect(ctx, -4, -4, 20, 8, 2.5); fillStroke(ctx, "#4a5362", INK, 2);
    roundRect(ctx, 15, -2, 11, 4, 1.5); fillStroke(ctx, "#2d333d", INK, 1.6);
    ell(ctx, 6, 5, 5.5, 5.5); fillStroke(ctx, "#f6e27f", INK, 1.8);
    ell(ctx, 6, 5, 2, 2); fillStroke(ctx, "#c9a227", null);
  } else if (id === "rocket") {
    roundRect(ctx, -10, -6, 34, 12, 4); fillStroke(ctx, "#5f7a3a", INK, 2.2);
    ctx.beginPath(); ctx.moveTo(24, -5); ctx.quadraticCurveTo(34, 0, 24, 5); ctx.closePath(); fillStroke(ctx, "#ff5964", INK, 2);
    roundRect(ctx, -12, -7.5, 5, 15, 2); fillStroke(ctx, "#3f5226", INK, 1.8);
    roundRect(ctx, 4, -7, 4, 14, 1.5); fillStroke(ctx, "#3f5226", INK, 1.4);
  } else if (id === "mine") {
    ctx.strokeStyle = INK; ctx.lineWidth = 2.6;
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * TAU;
      ctx.beginPath(); ctx.moveTo(12 + Math.cos(a) * 6, Math.sin(a) * 6); ctx.lineTo(12 + Math.cos(a) * 10.5, Math.sin(a) * 10.5); ctx.stroke();
    }
    ell(ctx, 12, 0, 7.5, 7.5); fillStroke(ctx, "#e63950", INK, 2);
    ell(ctx, 12, 0, 2.6, 2.6); fillStroke(ctx, "#ffe14a", INK, 1.2);
    roundRect(ctx, -3, -2.5, 9, 5, 2); fillStroke(ctx, "#4a5362", INK, 1.6);
  } else if (id === "torpedo") {
    roundRect(ctx, -8, -5.5, 28, 11, 4); fillStroke(ctx, "#3f6d8e", INK, 2.2);
    ctx.beginPath(); ctx.moveTo(20, -4.5); ctx.quadraticCurveTo(31, 0, 20, 4.5); ctx.closePath(); fillStroke(ctx, "#8fe3ff", INK, 2);
    ctx.beginPath(); ctx.moveTo(-8, -5); ctx.lineTo(-14, -9); ctx.lineTo(-11, 0); ctx.lineTo(-14, 9); ctx.lineTo(-8, 5); ctx.closePath(); fillStroke(ctx, "#2a4a61", INK, 1.8);
  } else if (id === "sniper") {
    roundRect(ctx, -8, -3.5, 16, 7, 2); fillStroke(ctx, "#6c5b9c", INK, 2);
    roundRect(ctx, 6, -1.8, 36, 3.6, 1.5); fillStroke(ctx, "#3b3454", INK, 1.6);
    roundRect(ctx, 39, -3, 5, 6, 1.5); fillStroke(ctx, "#23202f", INK, 1.2);
    roundRect(ctx, 0, -8, 14, 4.5, 2); fillStroke(ctx, "#c8b6ff", INK, 1.6);
  } else if (id === "flame") {
    ell(ctx, -3, 6, 7, 7); fillStroke(ctx, "#ff7b00", INK, 2);
    roundRect(ctx, -2, -3.5, 20, 7, 2.5); fillStroke(ctx, "#7a8594", INK, 2);
    roundRect(ctx, 17, -2.2, 9, 4.4, 1.5); fillStroke(ctx, "#3d4551", INK, 1.6);
    const f = 3 + Math.sin((t || 0) * 30) * 1.2;
    ctx.beginPath(); ctx.moveTo(26, -2); ctx.quadraticCurveTo(26 + f * 2, 0, 26, 2); ctx.closePath(); fillStroke(ctx, "#ffd23f", "#ff7b00", 1.2);
  } else if (id === "zap") {
    roundRect(ctx, -5, -4, 14, 8, 3); fillStroke(ctx, "#3a506b", INK, 2);
    ctx.strokeStyle = INK; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(8, -3); ctx.lineTo(24, -7); ctx.moveTo(8, 3); ctx.lineTo(24, 7); ctx.stroke();
    ctx.strokeStyle = "#7df9ff"; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(8, -3); ctx.lineTo(24, -7); ctx.moveTo(8, 3); ctx.lineTo(24, 7); ctx.stroke();
    ell(ctx, 24, 0, 3 + Math.sin((t || 0) * 22) * 0.9, 3 + Math.cos((t || 0) * 19) * 0.9); fillStroke(ctx, "#eaffff", "#7df9ff", 1.4);
  } else if (id === "wave") {
    ctx.beginPath(); ctx.moveTo(-5, -3); ctx.lineTo(10, -3.5); ctx.quadraticCurveTo(20, -5, 27, -12); ctx.lineTo(27, 12); ctx.quadraticCurveTo(20, 5, 10, 3.5); ctx.lineTo(-5, 3); ctx.closePath();
    fillStroke(ctx, "#f4c95d", INK, 2.2);
    ell(ctx, 27, 0, 3, 12); fillStroke(ctx, "#4cc9f0", INK, 1.8);
  } else if (id === "stone") {
    ctx.strokeStyle = INK; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(-4, 0); ctx.lineTo(8, 0); ctx.moveTo(8, 0); ctx.lineTo(19, -9); ctx.moveTo(8, 0); ctx.lineTo(19, 9); ctx.stroke();
    ctx.strokeStyle = "#a9713d"; ctx.lineWidth = 3.2;
    ctx.beginPath(); ctx.moveTo(-4, 0); ctx.lineTo(8, 0); ctx.moveTo(8, 0); ctx.lineTo(19, -9); ctx.moveTo(8, 0); ctx.lineTo(19, 9); ctx.stroke();
    ctx.strokeStyle = "#e63950"; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(19, -9); ctx.lineTo(13, 0); ctx.lineTo(19, 9); ctx.stroke();
    ell(ctx, 13, 0, 4.2, 3.4); fillStroke(ctx, "#cfd2cd", INK, 1.6);
  } else if (id === "egg") {
    roundRect(ctx, -6, -7, 22, 14, 4); fillStroke(ctx, "#6d7a8c", INK, 2.2);
    roundRect(ctx, 13, -8, 5, 16, 2); fillStroke(ctx, "#4a5362", INK, 1.8);
    ell(ctx, 21, 0, 6.5, 5.2); fillStroke(ctx, "#fff4d6", INK, 1.8);
    ell(ctx, 19.5, -1.5, 2, 1.3, -0.5); fillStroke(ctx, "rgba(255,255,255,0.9)", null);
  }
}

// How far the weapon's muzzle is from the grip, for flashes.
export const WEAPON_LEN = [18, 28, 26, 32, 20, 30, 44, 27, 26, 28, 20, 26];

// ---- the duck ----------------------------------------------------------------------------------
// o: { color (index), hat, facing, aim, paddle, kick, flash, weapon (-1 none), blink, mood,
//      moving (0..1), t }
// mood: "normal" | "angry" | "dead" | "happy" | "scared"
export function drawDuck(ctx, o) {
  const c = COLORS[o.color % COLORS.length];
  const body = o.flash ? "#ffffff" : c.body;
  const dark = o.flash ? "#ffffff" : c.dark;
  const light = o.flash ? "#ffffff" : c.light;
  const outline = o.flash ? "#ffffff" : INK;
  const t = o.t || 0;
  const moving = o.moving || 0;
  ctx.lineJoin = "round"; ctx.lineCap = "round";

  ctx.save();
  ctx.rotate(o.facing || 0);

  // feet, paddling under the surface
  const ph = o.paddle || 0;
  ctx.globalAlpha *= 0.55;
  for (let s = -1; s <= 1; s += 2) {
    const k = Math.sin(ph * 2.2 + (s > 0 ? Math.PI : 0)) * moving;
    ctx.save();
    ctx.translate(-17 - k * 5, s * 10);
    ctx.rotate(s * 0.35 + k * 0.2 * s);
    ctx.beginPath(); ctx.moveTo(4, 0); ctx.lineTo(-7, -5); ctx.lineTo(-5, 0); ctx.lineTo(-7, 5); ctx.closePath();
    ctx.fillStyle = BEAK_DARK; ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha /= 0.55;

  // tail
  const wag = Math.sin(ph * 2.2) * 0.25 * (0.3 + moving);
  ctx.save();
  ctx.translate(-20, 0); ctx.rotate(wag);
  ctx.beginPath(); ctx.moveTo(4, -7); ctx.quadraticCurveTo(-6, -5, -11, 0); ctx.quadraticCurveTo(-6, 5, 4, 7); ctx.closePath();
  fillStroke(ctx, dark, outline, 2.4);
  ctx.restore();

  // body
  ell(ctx, -3, 0, 21, 16.5); fillStroke(ctx, body, outline, 2.6);
  // belly highlight
  ell(ctx, -1, -4, 13, 8, -0.15); ctx.fillStyle = light; ctx.globalAlpha *= 0.55; ctx.fill(); ctx.globalAlpha /= 0.55;
  // wings
  const flap = (o.kick || 0) * 0.35;
  for (let s = -1; s <= 1; s += 2) {
    ctx.save();
    ctx.translate(-5, s * 11.5); ctx.rotate(s * (0.22 + flap));
    ctx.beginPath(); ctx.moveTo(10, -s * 2); ctx.quadraticCurveTo(4, s * 7, -12, s * 4); ctx.quadraticCurveTo(-6, -s * 5, 10, -s * 2); ctx.closePath();
    fillStroke(ctx, dark, outline, 2.2);
    ctx.restore();
  }
  ctx.restore();

  // head + weapon follow the aim
  const aim = o.aim === undefined ? (o.facing || 0) : o.aim;
  const fx = Math.cos(o.facing || 0), fy = Math.sin(o.facing || 0);
  ctx.save();
  ctx.translate(fx * 4, fy * 4);
  ctx.rotate(aim);
  const recoil = (o.kick || 0) * 4;

  if (o.weapon !== undefined && o.weapon >= 0) {
    ctx.save();
    ctx.translate(9 - recoil, 13.5);
    drawWeapon(ctx, o.weapon, t);
    ctx.restore();
    // wing tip holding it
    ell(ctx, 8 - recoil, 13, 5, 3.6, 0.3); fillStroke(ctx, dark, outline, 2);
  }

  ctx.translate(8, 0);
  // beak
  ctx.beginPath();
  ctx.moveTo(7, -6.5); ctx.quadraticCurveTo(19, -6.5, 21.5, -1.5); ctx.quadraticCurveTo(22.5, 0, 21.5, 1.5); ctx.quadraticCurveTo(19, 6.5, 7, 6.5);
  ctx.closePath();
  fillStroke(ctx, o.flash ? "#ffffff" : BEAK, o.flash ? "#ffffff" : BEAK_DARK, 2.2);
  if (!o.flash) {
    ctx.fillStyle = BEAK_DARK;
    ell(ctx, 16.5, -2.4, 1, 0.8); ctx.fill(); ell(ctx, 16.5, 2.4, 1, 0.8); ctx.fill();
  }
  // head
  ell(ctx, 0, 0, 12, 12); fillStroke(ctx, body, outline, 2.6);
  ell(ctx, -2, -3, 6.5, 4.5, -0.3); ctx.fillStyle = light; ctx.globalAlpha *= 0.5; ctx.fill(); ctx.globalAlpha /= 0.5;

  // eyes
  const mood = o.mood || "normal";
  for (let s = -1; s <= 1; s += 2) {
    const ex = 5.6, ey = s * 6.9;
    if (mood === "dead") {
      ctx.strokeStyle = INK; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(ex - 2.5, ey - 2.5); ctx.lineTo(ex + 2.5, ey + 2.5); ctx.moveTo(ex - 2.5, ey + 2.5); ctx.lineTo(ex + 2.5, ey - 2.5); ctx.stroke();
      continue;
    }
    if (o.blink || mood === "happy") {
      ctx.strokeStyle = INK; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.arc(ex, ey, 3, mood === "happy" ? Math.PI * 0.5 : -Math.PI * 0.5, mood === "happy" ? Math.PI * 1.5 : Math.PI * 0.5); ctx.stroke();
      continue;
    }
    ell(ctx, ex, ey, mood === "scared" ? 4.8 : 4.2, 4.4); fillStroke(ctx, "#ffffff", INK, 1.5);
    ell(ctx, ex + 1.4, ey, mood === "scared" ? 1.5 : 2.2, mood === "scared" ? 1.5 : 2.3); ctx.fillStyle = INK; ctx.fill();
    ell(ctx, ex + 2, ey - 0.8, 0.8, 0.8); ctx.fillStyle = "#ffffff"; ctx.fill();
    if (mood === "angry") {
      ctx.strokeStyle = INK; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(ex + 5.5, ey - s * 1); ctx.lineTo(ex - 0.5, ey - s * 5.5); ctx.stroke();
    }
  }
  // Hats sit on the back of the head so the eyes stay visible from above.
  ctx.translate(-4.2, 0);
  ctx.scale(0.8, 0.8);
  drawHat(ctx, o.hat || 0, t);
  ctx.restore();
}

// ---- pickups -----------------------------------------------------------------------------------
export function drawCrate(ctx, size) {
  const s = size || 15;
  roundRect(ctx, -s, -s, s * 2, s * 2, 4); fillStroke(ctx, "#c98b4f", "#5b3716", 2.4);
  ctx.strokeStyle = "#8a5a2b"; ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(-s + 3, -s / 3); ctx.lineTo(s - 3, -s / 3);
  ctx.moveTo(-s + 3, s / 3); ctx.lineTo(s - 3, s / 3);
  ctx.stroke();
  roundRect(ctx, -s, -s, s * 2, s * 2, 4); ctx.strokeStyle = "#5b3716"; ctx.lineWidth = 2.4; ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  roundRect(ctx, -s + 2.5, -s + 2.5, s * 2 - 5, s * 0.5, 2); ctx.fill();
}

export function drawBread(ctx, golden, t) {
  const crust = golden ? "#f2b600" : "#c8843c";
  const crumb = golden ? "#ffe66d" : "#f3d9a4";
  ctx.beginPath();
  ctx.moveTo(-12, 7); ctx.lineTo(-12, -2); ctx.quadraticCurveTo(-14, -11, -4, -10); ctx.quadraticCurveTo(0, -13, 4, -10); ctx.quadraticCurveTo(14, -11, 12, -2); ctx.lineTo(12, 7);
  ctx.quadraticCurveTo(0, 10, -12, 7); ctx.closePath();
  fillStroke(ctx, crust, golden ? "#8a6400" : "#6b3f12", 2.4);
  ctx.beginPath();
  ctx.moveTo(-8, 5); ctx.lineTo(-8, -1); ctx.quadraticCurveTo(-9, -7, -3, -6.5); ctx.quadraticCurveTo(0, -8.5, 3, -6.5); ctx.quadraticCurveTo(9, -7, 8, -1); ctx.lineTo(8, 5);
  ctx.quadraticCurveTo(0, 7, -8, 5); ctx.closePath();
  ctx.fillStyle = crumb; ctx.fill();
  if (golden) {
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    const k = 0.6 + 0.4 * Math.sin((t || 0) * 6);
    ctx.save(); ctx.translate(6, -6); ctx.scale(k, k);
    ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(1.2, -1.2); ctx.lineTo(5, 0); ctx.lineTo(1.2, 1.2); ctx.lineTo(0, 5); ctx.lineTo(-1.2, 1.2); ctx.lineTo(-5, 0); ctx.lineTo(-1.2, -1.2); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}

export function drawShieldIcon(ctx) {
  ell(ctx, 0, 0, 13, 13);
  ctx.fillStyle = "rgba(120,220,255,0.45)"; ctx.fill();
  ctx.lineWidth = 2.4; ctx.strokeStyle = "#e8fbff"; ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, 9, Math.PI * 1.1, Math.PI * 1.6); ctx.lineWidth = 2.2; ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.stroke();
}

export function drawTurboIcon(ctx) {
  ctx.beginPath();
  ctx.moveTo(3, -14); ctx.lineTo(-8, 2); ctx.lineTo(-1, 2); ctx.lineTo(-4, 14); ctx.lineTo(9, -3); ctx.lineTo(1.5, -3); ctx.closePath();
  fillStroke(ctx, "#ffe14a", "#a66b00", 2.2);
}

export function drawBarrel(ctx, lit) {
  ell(ctx, 0, 0, 16, 16); fillStroke(ctx, lit ? "#ffffff" : "#d7263d", INK, 2.6);
  ell(ctx, 0, 0, 11, 11); ctx.lineWidth = 2; ctx.strokeStyle = lit ? "#ffd23f" : "#8f1022"; ctx.stroke();
  if (!lit) {
    ctx.beginPath();
    ctx.moveTo(1.5, -7); ctx.lineTo(-4, 1); ctx.lineTo(-0.5, 1); ctx.lineTo(-2, 7); ctx.lineTo(4.5, -1.5); ctx.lineTo(0.8, -1.5); ctx.closePath();
    ctx.fillStyle = "#ffd23f"; ctx.fill();
  }
  ell(ctx, -5, -6, 3.5, 2, -0.6); ctx.fillStyle = "rgba(255,255,255,0.4)"; ctx.fill();
}

export function drawMine(ctx, armed, blink) {
  ctx.strokeStyle = INK; ctx.lineWidth = 3;
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * TAU;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * 8, Math.sin(a) * 8); ctx.lineTo(Math.cos(a) * 14, Math.sin(a) * 14); ctx.stroke();
  }
  ell(ctx, 0, 0, 10.5, 10.5); fillStroke(ctx, "#4a5362", INK, 2.4);
  ell(ctx, 0, 0, 4, 4); fillStroke(ctx, armed ? (blink ? "#ff2e4d" : "#7a1020") : "#ffe14a", INK, 1.4);
  ell(ctx, -3.5, -4, 2.6, 1.6, -0.6); ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.fill();
}

// A weapon drawn centred, for crate badges, the HUD and the controller.
export function drawWeaponIcon(ctx, w, scale) {
  ctx.save();
  ctx.scale(scale || 1, scale || 1);
  ctx.rotate(-0.5);
  ctx.translate(-WEAPON_LEN[w] / 2 + 2, 0);
  drawWeapon(ctx, w, 0);
  ctx.restore();
}
