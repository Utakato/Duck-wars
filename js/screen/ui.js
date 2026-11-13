// DOM overlays on the screen: lobby, results podium and toasts. The pond keeps rendering on the
// canvas behind them. All names are written with textContent because nicknames are user input.
import { COLORS, HATS, MODES, MAPS, DIFFICULTIES, MAX_PLAYERS } from "../shared/config.js";
import { drawDuck } from "../shared/duckart.js";

function $(id) { return document.getElementById(id); }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function duckCanvas(color, hat, w, h, mood, weapon) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.translate(w * 0.44, h * 0.56);
  const s = h / 52;
  ctx.scale(s, s);
  ctx.fillStyle = "rgba(8,30,60,0.25)";
  ctx.beginPath(); ctx.ellipse(3, 8, 25, 17, 0, 0, Math.PI * 2); ctx.fill();
  drawDuck(ctx, { color: color, hat: hat, facing: -0.25, aim: -0.25, mood: mood || "normal", weapon: weapon === undefined ? -1 : weapon, moving: 0, t: 1 });
  return c;
}

export function formatGoal(modeIndex, goalIndex) {
  const m = MODES[modeIndex];
  const g = m.goals[goalIndex];
  if (m.goalUnit === "time") return Math.floor(g / 60) + ":" + ("0" + (g % 60)).slice(-2) + " min";
  if (m.goalUnit === "wins") return "First to " + g + " wins";
  return "First to " + g + " points";
}

export function createUi() {
  const last = {};
  function setText(id, text) {
    const e = $(id);
    if (last[id] === text) return;
    const first = last[id] === undefined;
    last[id] = text;
    e.textContent = text;
    if (!first) { e.classList.remove("changed"); void e.offsetWidth; e.classList.add("changed"); }
  }
  let lobbyKey = "";

  return {
    show: function (name) {
      const ids = ["loading", "lobby", "results"];
      for (let i = 0; i < ids.length; i++) $(ids[i]).classList.toggle("show", ids[i] === name);
    },

    // data: { cfg, players: [{ seat, name, hat, pic, master, bot }], hint, pulse }
    lobby: function (data) {
      const cfg = data.cfg;
      const mode = MODES[cfg.mode];
      setText("set-mode", mode.name);
      $("set-desc").textContent = mode.desc;
      setText("set-map", MAPS[cfg.map].name);
      $("set-goal-label").textContent = mode.goalUnit === "time" ? "Length" : "Goal";
      setText("set-goal", formatGoal(cfg.mode, cfg.goal));
      setText("set-bots", data.botCount + (data.botCount === 1 ? " bot" : " bots"));
      setText("set-diff", DIFFICULTIES[cfg.diff]);
      const hint = $("lobby-hint");
      hint.textContent = "";
      for (let i = 0; i < data.hint.length; i++) {
        const part = data.hint[i];
        hint.appendChild(part.b ? el("b", null, part.t) : document.createTextNode(part.t));
      }
      hint.classList.toggle("pulse", !!data.pulse);

      // Rebuild the player cards only when something visible changed.
      const key = JSON.stringify(data.players);
      if (key === lobbyKey) return;
      lobbyKey = key;
      const box = $("lobby-players");
      box.textContent = "";
      const shown = data.players.length;
      for (let i = 0; i < data.players.length; i++) {
        const p = data.players[i];
        const card = el("div", "pcard" + (p.bot ? " bot" : ""));
        card.style.borderColor = COLORS[p.seat].body;
        card.appendChild(duckCanvas(p.seat, p.hat, 220, 160));
        const name = el("div", "pname", p.name);
        name.style.color = COLORS[p.seat].light;
        card.appendChild(name);
        card.appendChild(el("div", "psub", p.bot ? "Bot" : HATS[p.hat].name));
        if (p.pic) { const pic = el("div", "pic"); pic.style.backgroundImage = "url(" + JSON.stringify(p.pic) + ")"; card.appendChild(pic); }
        if (p.master) card.appendChild(el("div", "crown", "HOST"));
        box.appendChild(card);
      }
      if (shown < Math.min(MAX_PLAYERS, 4)) {
        const card = el("div", "pcard empty");
        card.appendChild(el("div", "pname", "Join in!"));
        card.appendChild(el("div", "psub", "up to " + MAX_PLAYERS + " ducks"));
        box.appendChild(card);
      }
    },

    // data: { title, ranks: [{ seat, hat, name, score, bot }], awards: [{ label, name, value }], hint }
    results: function (data) {
      $("results-title").textContent = data.title;
      const pod = $("podium");
      pod.textContent = "";
      const order = [1, 0, 2];          // visual order: 2nd, 1st, 3rd
      for (let k = 0; k < order.length; k++) {
        const r = data.ranks[order[k]];
        if (!r) continue;
        const box = el("div", "pod p" + (order[k] + 1));
        box.appendChild(duckCanvas(r.seat, r.hat, 300, 210, order[k] === 0 ? "happy" : "normal"));
        const name = el("div", "pname", r.name);
        name.style.color = COLORS[r.seat].light;
        box.appendChild(name);
        const block = el("div", "block");
        block.style.borderColor = COLORS[r.seat].body;
        block.appendChild(el("div", "place", ["1st", "2nd", "3rd"][order[k]]));
        block.appendChild(el("div", "pscore", r.score));
        box.appendChild(block);
        pod.appendChild(box);
      }
      const aw = $("awards");
      aw.textContent = "";
      for (let i = 0; i < data.awards.length; i++) {
        const a = data.awards[i];
        const row = el("div", "award");
        row.appendChild(el("b", null, a.label + "  "));
        row.appendChild(el("i", null, a.name));
        row.appendChild(document.createTextNode("  " + a.value));
        aw.appendChild(row);
      }
      const hint = $("results-hint");
      hint.textContent = "";
      for (let i = 0; i < data.hint.length; i++) {
        const part = data.hint[i];
        hint.appendChild(part.b ? el("b", null, part.t) : document.createTextNode(part.t));
      }
    },

    toast: function (text, colorIndex) {
      const box = $("toasts");
      const t = el("div", "toast", text);
      if (colorIndex !== undefined && colorIndex >= 0) t.style.borderColor = COLORS[colorIndex % COLORS.length].body;
      box.appendChild(t);
      while (box.children.length > 3) box.removeChild(box.firstChild);
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3500);
    }
  };
}
