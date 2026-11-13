// Visual effects: particles, ripples, lightning, floating text and the camera's shake and zoom.
// Purely cosmetic. Nothing in here ever feeds back into the simulation.
import { COLORS } from "../shared/config.js";

const TAU = Math.PI * 2;
const MAX_PARTICLES = 1100;

export function createFx() {
  const P = [];          // particles
  const under = [];      // particles drawn below the surface (bubbles)
  const cam = { trauma: 0, t: 0, zoom: 1, zoomTo: 1, fx: 800, fy: 450, ox: 0, oy: 0, rot: 0, punch: 0 };
  let seed = 12345;
  function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
  function rr(a, b) { return a + (b - a) * rnd(); }

  function add(p) {
    if (P.length >= MAX_PARTICLES) P.shift();
    p.age = 0;
    P.push(p);
    return p;
  }

  const fx = {
    cam: cam,
    particles: P,
    under: under,
    count: function () { return P.length + under.length; },
    clear: function () { P.length = 0; under.length = 0; cam.trauma = 0; cam.zoom = cam.zoomTo = 1; cam.punch = 0; },

    shake: function (amount) { cam.trauma = Math.min(1, cam.trauma + amount); },
    punch: function (amount) { cam.punch = Math.min(0.06, cam.punch + amount); },
    focus: function (x, y, zoom) { cam.fx = x; cam.fy = y; cam.zoomTo = zoom; },
    unfocus: function () { cam.zoomTo = 1; },

    ring: function (x, y, r0, r1, life, width, color) {
      add({ k: "ring", x: x, y: y, r0: r0, r1: r1, life: life, w: width || 2, c: color || "255,255,255" });
    },
    splash: function (x, y, n, power, color) {
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU, s = rr(20, 90) * power;
        add({ k: "drop", x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.7, z: 2, vz: rr(90, 240) * power, life: 1.2, r: rr(1.6, 3.6), c: color || "235,250,255" });
      }
    },
    foam: function (x, y, r, life) {
      add({ k: "foam", x: x + rr(-3, 3), y: y + rr(-3, 3), r: r, life: life || 0.9 });
    },
    smoke: function (x, y, n, r, color, speed) {
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU, s = rr(5, speed || 40);
        add({ k: "smoke", x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 12, r: rr(r * 0.5, r), life: rr(0.5, 1.1), c: color || "70,74,84" });
      }
    },
    sparks: function (x, y, n, color, speed, a0, spread) {
      for (let i = 0; i < n; i++) {
        const a = a0 === undefined ? rnd() * TAU : a0 + rr(-1, 1) * (spread || 0.5), s = rr(0.4, 1) * (speed || 260);
        add({ k: "spark", x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rr(0.12, 0.3), c: color || "255,240,170" });
      }
    },
    flame: function (x, y, a) {
      for (let i = 0; i < 2; i++) {
        const d = a + rr(-0.24, 0.24), s = rr(330, 470);
        add({ k: "flame", x: x, y: y, vx: Math.cos(d) * s, vy: Math.sin(d) * s, r: rr(5, 9), life: rr(0.3, 0.42) });
      }
    },
    fire: function (x, y) {
      add({ k: "flame", x: x + rr(-10, 10), y: y + rr(-8, 8), vx: rr(-12, 12), vy: rr(-70, -30), r: rr(4, 8), life: rr(0.3, 0.5) });
    },
    feathers: function (x, y, n, colorIndex) {
      const c = COLORS[colorIndex % COLORS.length];
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU, s = rr(40, 260);
        add({ k: "feather", x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, z: 4, vz: rr(80, 260), rot: rnd() * TAU, vr: rr(-7, 7), life: rr(1.6, 2.8), c: i % 3 === 0 ? c.light : c.body });
      }
    },
    bubbles: function (x, y, n, spread) {
      for (let i = 0; i < n; i++) {
        if (under.length > 220) under.shift();
        under.push({ k: "bubble", x: x + rr(-1, 1) * (spread || 8), y: y + rr(-1, 1) * (spread || 8), r: rr(1.5, 4), life: rr(0.5, 1.1), age: 0 });
      }
    },
    flash: function (x, y, r, color, life) {
      add({ k: "flash", x: x, y: y, r: r, life: life || 0.18, c: color || "255,250,220" });
    },
    muzzle: function (x, y, a, size, color) {
      add({ k: "muzzle", x: x, y: y, a: a, r: size || 12, life: 0.07, c: color || "255,236,150" });
    },
    bolt: function (pts, color) {
      add({ k: "bolt", pts: pts, life: 0.2, c: color || "125,249,255" });
    },
    text: function (x, y, str, color, size, life) {
      add({ k: "text", x: x, y: y, vy: -42, str: str, c: color || "#ffffff", size: size || 22, life: life || 1.0 });
    },
    fish: function (x, y) {
      const a = rnd() < 0.5 ? 0 : Math.PI;
      add({ k: "fish", x: x, y: y, vx: Math.cos(a) * rr(40, 80), z: 0, vz: rr(150, 230), life: 0.9, flip: a ? -1 : 1 });
    },
    confetti: function (x, y, n) {
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + rr(-1.1, 1.1), s = rr(200, 620);
        add({ k: "confetti", x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, rot: rnd() * TAU, vr: rr(-9, 9), life: rr(1.6, 3), c: COLORS[(rnd() * COLORS.length) | 0].body, w: rr(5, 10) });
      }
    },
    explosion: function (x, y, r, big, onLand) {
      fx.flash(x, y, r * 0.9, "255,246,200", 0.16);
      fx.ring(x, y, r * 0.25, r * 1.05, 0.38, 7, "255,255,255");
      fx.ring(x, y, r * 0.1, r * 1.5, 0.75, 3, "255,255,255");
      fx.smoke(x, y, big ? 12 : 7, big ? 30 : 22, "80,84,96", 70);
      if (!onLand) {
        fx.splash(x, y, big ? 34 : 20, big ? 1.5 : 1.15);
        for (let i = 0; i < (big ? 12 : 7); i++) {
          const a = rnd() * TAU, d = rr(0, r * 0.7);
          fx.foam(x + Math.cos(a) * d, y + Math.sin(a) * d, rr(8, 18), rr(0.8, 1.6));
        }
      }
      fx.sparks(x, y, big ? 16 : 9, "255,200,90", 420);
      fx.shake(big ? 0.55 : 0.38);
      fx.punch(big ? 0.03 : 0.018);
    },

    update: function (dt, realDt) {
      // camera: trauma decays in real time so a hit-stop never freezes the shake off-centre
      cam.t += realDt * 30;
      cam.trauma = Math.max(0, cam.trauma - 1.5 * realDt);
      const s = cam.trauma * cam.trauma;
      cam.ox = 15 * s * Math.sin(cam.t * 1.7);
      cam.oy = 11 * s * Math.sin(cam.t * 2.3 + 1);
      cam.rot = 0.012 * s * Math.sin(cam.t * 1.1 + 2);
      cam.punch = Math.max(0, cam.punch - realDt * 0.22);
      cam.zoom += (cam.zoomTo - cam.zoom) * (1 - Math.exp(-6 * realDt));

      for (let i = P.length - 1; i >= 0; i--) {
        const p = P[i];
        p.age += dt;
        if (p.age >= p.life) { P[i] = P[P.length - 1]; P.pop(); continue; }
        switch (p.k) {
          case "drop":
          case "feather":
          case "fish":
            p.x += p.vx * dt; if (p.vy) p.y += p.vy * dt;
            p.z += p.vz * dt;
            p.vz -= (p.k === "feather" ? 260 : 620) * dt;
            if (p.k === "feather") { p.rot += p.vr * dt; p.vx *= 1 - 2.2 * dt; p.vy *= 1 - 2.2 * dt; if (p.z <= 0) { p.z = 0; p.vz = 0; p.vr *= 0.9; } }
            else if (p.z <= 0) {
              if (p.k === "drop" && p.r > 2.6) fx.ring(p.x, p.y, 1, 9, 0.35, 1.2);
              if (p.k === "fish") { fx.ring(p.x, p.y, 2, 16, 0.4, 1.5); }
              P[i] = P[P.length - 1]; P.pop();
            }
            break;
          case "smoke":
            p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - 1.5 * dt; p.vy *= 1 - 1.5 * dt;
            break;
          case "spark":
          case "flame":
            p.x += p.vx * dt; p.y += p.vy * dt;
            if (p.k === "flame") { p.vx *= 1 - 3.2 * dt; p.vy *= 1 - 3.2 * dt; }
            break;
          case "text":
            p.y += p.vy * dt; p.vy *= 1 - 2.5 * dt;
            break;
          case "confetti":
            p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 520 * dt; p.vx *= 1 - 1.2 * dt; p.rot += p.vr * dt;
            break;
          default: break;
        }
      }
      for (let i = under.length - 1; i >= 0; i--) {
        const p = under[i];
        p.age += dt;
        if (p.age >= p.life) { under[i] = under[under.length - 1]; under.pop(); }
      }
    },

    drawUnder: function (ctx) {
      ctx.lineWidth = 1.2;
      for (let i = 0; i < under.length; i++) {
        const p = under[i];
        const t = p.age / p.life;
        ctx.globalAlpha = (1 - t) * 0.7;
        ctx.strokeStyle = "#e9fbff";
        ctx.beginPath(); ctx.arc(p.x, p.y - t * 6, p.r * (0.6 + t * 0.8), 0, TAU); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },

    // layer 0: on the water surface (below ducks). layer 1: in the air (above ducks).
    draw: function (ctx, layer) {
      for (let i = 0; i < P.length; i++) {
        const p = P[i];
        const t = p.age / p.life;
        const top = p.k !== "ring" && p.k !== "foam";
        if ((layer === 1) !== top) continue;
        switch (p.k) {
          case "ring": {
            const e = 1 - (1 - t) * (1 - t);
            ctx.globalAlpha = (1 - t) * 0.8;
            ctx.strokeStyle = "rgb(" + p.c + ")";
            ctx.lineWidth = p.w * (1 - t * 0.6);
            ctx.beginPath(); ctx.ellipse(p.x, p.y, p.r0 + (p.r1 - p.r0) * e, (p.r0 + (p.r1 - p.r0) * e) * 0.92, 0, 0, TAU); ctx.stroke();
            break;
          }
          case "foam":
            ctx.globalAlpha = (1 - t) * 0.55;
            ctx.fillStyle = "#ffffff";
            ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.5 + t * 0.7), 0, TAU); ctx.fill();
            break;
          case "drop":
            ctx.globalAlpha = Math.min(1, (1 - t) * 2);
            ctx.fillStyle = "rgb(" + p.c + ")";
            ctx.beginPath(); ctx.arc(p.x, p.y - p.z, p.r, 0, TAU); ctx.fill();
            break;
          case "smoke":
            ctx.globalAlpha = (1 - t) * 0.5;
            ctx.fillStyle = "rgb(" + p.c + ")";
            ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.6 + t * 1.3), 0, TAU); ctx.fill();
            break;
          case "spark":
            ctx.globalAlpha = 1 - t;
            ctx.strokeStyle = "rgb(" + p.c + ")";
            ctx.lineWidth = 2.2;
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035); ctx.stroke();
            break;
          case "flame": {
            ctx.globalAlpha = (1 - t) * 0.85;
            const g = t < 0.35 ? "255,236,140" : (t < 0.7 ? "255,150,40" : "220,70,30");
            ctx.fillStyle = "rgb(" + g + ")";
            ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.7 + t * 1.5), 0, TAU); ctx.fill();
            break;
          }
          case "feather":
            ctx.globalAlpha = Math.min(1, (1 - t) * 2.5);
            ctx.save();
            ctx.translate(p.x, p.y - p.z); ctx.rotate(p.rot);
            ctx.fillStyle = p.c;
            ctx.beginPath(); ctx.ellipse(0, 0, 7, 2.8, 0, 0, TAU); ctx.fill();
            ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(-7, 0); ctx.lineTo(7, 0); ctx.stroke();
            ctx.restore();
            break;
          case "flash":
            ctx.globalAlpha = (1 - t) * 0.85;
            ctx.fillStyle = "rgb(" + p.c + ")";
            ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.5 + t * 0.7), 0, TAU); ctx.fill();
            break;
          case "muzzle":
            ctx.globalAlpha = 1 - t * 0.6;
            ctx.save();
            ctx.translate(p.x, p.y); ctx.rotate(p.a);
            ctx.fillStyle = "rgb(" + p.c + ")";
            ctx.beginPath();
            ctx.moveTo(-2, 0); ctx.lineTo(p.r * 0.4, -p.r * 0.5); ctx.lineTo(p.r * 0.7, -p.r * 0.12); ctx.lineTo(p.r * 1.6, 0);
            ctx.lineTo(p.r * 0.7, p.r * 0.12); ctx.lineTo(p.r * 0.4, p.r * 0.5); ctx.closePath(); ctx.fill();
            ctx.fillStyle = "#ffffff";
            ctx.beginPath(); ctx.arc(p.r * 0.3, 0, p.r * 0.22, 0, TAU); ctx.fill();
            ctx.restore();
            break;
          case "bolt": {
            ctx.globalAlpha = 1 - t;
            const pts = p.pts;
            for (let pass = 0; pass < 2; pass++) {
              ctx.strokeStyle = pass ? "#ffffff" : "rgb(" + p.c + ")";
              ctx.lineWidth = pass ? 2 : 6;
              ctx.beginPath();
              ctx.moveTo(pts[0], pts[1]);
              for (let n = 2; n < pts.length; n += 2) {
                const x0 = pts[n - 2], y0 = pts[n - 1], x1 = pts[n], y1 = pts[n + 1];
                const len = Math.hypot(x1 - x0, y1 - y0);
                const steps = Math.max(2, (len / 22) | 0);
                for (let s2 = 1; s2 <= steps; s2++) {
                  const f = s2 / steps;
                  const j = s2 === steps ? 0 : 9;
                  // jitter is re-rolled every frame on purpose: lightning should crackle
                  ctx.lineTo(x0 + (x1 - x0) * f + (Math.random() - 0.5) * 2 * j, y0 + (y1 - y0) * f + (Math.random() - 0.5) * 2 * j);
                }
              }
              ctx.stroke();
            }
            break;
          }
          case "text": {
            const pop = t < 0.15 ? t / 0.15 : 1;
            ctx.globalAlpha = t > 0.7 ? (1 - t) / 0.3 : 1;
            ctx.font = "400 " + (p.size * (0.6 + 0.4 * pop)) + "px 'Lilita One', 'Fredoka', sans-serif";
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.lineWidth = 5; ctx.strokeStyle = "rgba(20,26,40,0.9)"; ctx.lineJoin = "round";
            ctx.strokeText(p.str, p.x, p.y);
            ctx.fillStyle = p.c; ctx.fillText(p.str, p.x, p.y);
            break;
          }
          case "fish":
            ctx.globalAlpha = 1;
            ctx.save();
            ctx.translate(p.x, p.y - p.z); ctx.scale(p.flip, 1); ctx.rotate(-Math.atan2(p.vz, 120) * 0.8);
            ctx.fillStyle = "#b3122e"; ctx.strokeStyle = "#1d2433"; ctx.lineWidth = 1.6;
            ctx.beginPath(); ctx.ellipse(0, 0, 9, 5.5, 0, 0, TAU); ctx.fill(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(-15, -5); ctx.lineTo(-15, 5); ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(4, -1.5, 1.8, 0, TAU); ctx.fill();
            ctx.beginPath(); ctx.moveTo(8, 1); ctx.lineTo(5, 3.5); ctx.lineTo(3, 1.5); ctx.lineTo(1, 3.5); ctx.closePath(); ctx.fill();
            ctx.restore();
            break;
          case "confetti":
            ctx.globalAlpha = Math.min(1, (1 - t) * 3);
            ctx.save();
            ctx.translate(p.x, p.y); ctx.rotate(p.rot);
            ctx.fillStyle = p.c;
            ctx.fillRect(-p.w / 2, -p.w * 0.3 * Math.cos(p.rot * 2), p.w, p.w * 0.6 * Math.cos(p.rot * 2));
            ctx.restore();
            break;
          default: break;
        }
      }
      ctx.globalAlpha = 1;
    }
  };
  return fx;
}
