// End-to-end check: the real screen.html and controller.html, the real airconsole-1.11.0.js, and
// the stand-in platform from /dev (see dev/harness.js) in headless Chromium.
// Covers the AirConsole test cases that can be automated: lobby, master controller, start,
// input, pause/resume (twice), late joiners, leaving and returning players, results, ad break,
// too many players, message rate.
//
//   node tests/e2e.spec.mjs
//
// Needs Playwright with Chromium. The API file is downloaded once into dev/vendor/.
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "../tools/serve.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_URL = "https://www.airconsole.com/api/airconsole-1.11.0.js";
const API_FILE = path.join(root, "dev/vendor/airconsole-1.11.0.js");

async function loadApi() {
  if (!fs.existsSync(API_FILE)) {
    const res = await fetch("https://raw.githubusercontent.com/AirConsole/airconsole-api/master/airconsole-1.11.0.js");
    if (!res.ok) throw new Error("could not download the AirConsole API file: " + res.status);
    fs.mkdirSync(path.dirname(API_FILE), { recursive: true });
    fs.writeFileSync(API_FILE, await res.text());
  }
  return fs.readFileSync(API_FILE, "utf8");
}

let failures = 0, passes = 0;
function check(label, cond, detail) {
  if (cond) { passes++; console.log("PASS " + label); }
  else { failures++; console.log("FAIL " + label + (detail !== undefined ? "  -> " + JSON.stringify(detail) : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = await loadApi();
const server = createServer().listen(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 800 } });
await ctx.route("**/*", (r) => {
  const u = r.request().url();
  if (u === API_URL) return r.fulfill({ contentType: "text/javascript", body: api });
  if (u.startsWith("http://localhost")) return r.continue();
  return r.abort();                                  // profile pictures etc: not needed here
});
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error" && !/net::|Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 300)); });
page.on("pageerror", (e) => errors.push("PAGEERROR " + String(e.stack || e).slice(0, 500)));

// ---- helpers ------------------------------------------------------------------------------------
const G = (fn, arg) => page.evaluate(([src, arg]) => {
  const w = window.harness.win(0);
  return (new Function("G", "arg", "return (" + src + ")(G, arg)"))(w.__duckwars, arg);
}, [fn.toString(), arg]);
const P = (id, fn, arg) => page.evaluate(([id, src, arg]) => {
  const w = window.harness.win(id);
  if (!w || !w.__duckpad) return undefined;
  return (new Function("P", "w", "arg", "return (" + src + ")(P, w, arg)"))(w.__duckpad, w, arg);
}, [id, fn.toString(), arg]);
const H = (fn, arg) => page.evaluate(([src, arg]) => (new Function("h", "arg", "return (" + src + ")(h, arg)"))(window.harness, arg), [fn.toString(), arg]);
const press = (id, sel) => P(id, (p, w, sel) => {
  const el = w.document.querySelector(sel);
  el.dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new w.MouseEvent("mouseup", { bubbles: true }));
}, sel);
const key = (id, type, code) => P(id, (p, w, a) => { w.dispatchEvent(new w.KeyboardEvent(a[0], { code: a[1] })); }, [type, code]);
const text = (id, sel) => P(id, (p, w, sel) => { const e = w.document.querySelector(sel); return e ? e.textContent : null; }, sel);
const visible = (id, sel) => P(id, (p, w, sel) => { const e = w.document.querySelector(sel); return !!e && w.getComputedStyle(e).display !== "none"; }, sel);
const view = (id) => P(id, (p) => p.view);
async function until(fn, timeout, label) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > (timeout || 8000)) { if (label) console.log("  (timed out waiting for: " + label + ")"); return false; }
    await sleep(60);
  }
}
const addPhone = async () => { const id = await H((h) => h.addController()); await until(() => view(id).then((v) => v === "LOBBY" || v === "GAME"), 8000, "phone " + id + " seated"); return id; };
const screenText = (sel) => page.evaluate((sel) => { const e = window.harness.win(0).document.querySelector(sel); return e ? e.textContent : null; }, sel);

// Ends an elimination round at once: everybody but one duck is out.
const endRound = (keepSeat) => G((g, keep) => {
  const ducks = g.world.ducks;
  let kept = false;
  for (const d of ducks) {
    if ((keep === undefined && !kept) || d.seat === keep) { kept = true; continue; }
    d.alive = false; d.ghost = true; d.hp = 0;
  }
}, keepSeat);

try {
  // ---- 1. empty lobby ---------------------------------------------------------------------------
  await page.goto(`http://localhost:${port}/dev/?phones=0`);
  await until(() => G((g) => g && g.state === "LOBBY"), 15000, "screen lobby");
  check("screen boots into the lobby", await G((g) => g.state) === "LOBBY");
  check("empty lobby invites players to join", /join/i.test(await screenText("#lobby-hint")), await screenText("#lobby-hint"));
  check("attract mode: bot ducks paddle around the lobby pond", await G((g) => g.world.ducks.length) === 2);

  // ---- 2. first phone is the master ------------------------------------------------------------
  const a = await addPhone();
  check("device ids are not assumed consecutive (first phone is not id 1)", a !== 1, a);
  check("first phone lands in the lobby with a seat", await view(a) === "LOBBY" && await P(a, (p) => p.seat) === 0, await view(a));
  check("master sees the host panel with START", await visible(a, "#host-panel") && !(await visible(a, "#guest-panel")));
  check("a lone player always gets an opponent bot", await G((g) => g.world.ducks.filter((d) => d.deviceId === undefined).length) >= 1);
  check("screen names the master by nickname", (await screenText("#lobby-hint")).includes(await H((h, id) => h.devices[id].nickname, a)), await screenText("#lobby-hint"));

  // ---- 3. second phone is a guest -------------------------------------------------------------
  const b = await addPhone();
  check("second phone gets its own colour", await P(b, (p) => p.seat) === 1);
  check("guest sees 'waiting for <master>' and no START", await visible(b, "#guest-panel") && !(await visible(b, "#host-panel")) && /Waiting for/.test(await text(b, "#guest-text")), await text(b, "#guest-text"));
  await press(b, "#start");
  await sleep(300);
  check("start from a non-master is ignored", await G((g) => g.state) === "LOBBY");
  await P(b, (p, w) => w.eval("0"));  // keep the frame alive
  // a forged menu message from the guest must be ignored by the screen too
  await page.evaluate((id) => window.harness.frames[0].iframe.contentWindow.postMessage({ action: "message", from: id, to: 0, data: { m: "start" } }, "*"), b);
  await sleep(300);
  check("forged start message from a non-master is ignored", await G((g) => g.state) === "LOBBY");

  // ---- 4. hats and settings -------------------------------------------------------------------
  const hat0 = await G((g) => g.seats[1].hat);
  await press(b, "#hat-next");
  await until(() => G((g, h) => g.seats[1].hat !== h, hat0), 3000);
  check("a guest can change their own hat", await G((g) => g.seats[1].hat) !== hat0);
  await until(() => text(b, "#hat-name").then((t) => t && t.length > 0), 3000);
  check("hat name shows on the phone", (await text(b, "#hat-name")).length > 0, await text(b, "#hat-name"));
  const cfg0 = await G((g) => Object.assign({}, g.cfg));
  await press(a, '.set[data-k="mode"] .next');
  await press(a, '.set[data-k="bots"] .next');
  await until(() => G((g, c) => g.cfg.mode !== c.mode && g.cfg.bots !== c.bots, cfg0), 3000);
  const cfg1 = await G((g) => Object.assign({}, g.cfg));
  check("master changes mode and bot count", cfg1.mode === 1 && cfg1.bots === cfg0.bots + 1, cfg1);
  await until(() => text(a, "#c-mode").then((t) => t === "Feather Frenzy"), 3000);
  check("phone and screen show the new mode", await text(a, "#c-mode") === "Feather Frenzy" && await screenText("#set-mode") === "Feather Frenzy");
  await press(a, '.set[data-k="mode"] .prev');
  await until(() => G((g) => g.cfg.mode === 0), 3000);
  await sleep(1800);
  check("hat choice is saved under the player's uid", await H((h) => h.log.stored) >= 1, await H((h) => h.log.stored));

  // ---- 5. pause in the lobby ------------------------------------------------------------------
  await H((h) => h.setPaused(true));
  await sleep(200);
  const tA = await G((g) => g.time);
  await sleep(500);
  check("pause freezes the lobby", await G((g) => g.paused) && await G((g) => g.time) === tA);
  await press(a, "#start");
  await sleep(300);
  check("menu input is ignored while paused", await G((g) => g.state) === "LOBBY");
  await H((h) => h.setPaused(false));
  await until(() => G((g, t) => g.time > t, tA), 3000);
  check("resume continues", !(await G((g) => g.paused)));

  // ---- 6. start a match -----------------------------------------------------------------------
  await press(a, "#start");
  await until(() => G((g) => g.state === "MATCH"), 5000, "match start");
  check("master starts the match", await G((g) => g.state) === "MATCH");
  await until(() => view(a).then((v) => v === "GAME"), 4000);
  check("both phones switch to the game pad", await view(a) === "GAME" && await view(b) === "GAME", [await view(a), await view(b)]);
  const roster = await G((g) => g.world.ducks.map((d) => ({ seat: d.seat, bot: d.isBot, dev: d.deviceId })));
  check("pond holds both humans plus the configured bots", roster.filter((r) => !r.bot).length === 2 && roster.filter((r) => r.bot).length === cfg1.bots, roster);
  check("silencing is on for the round (active players set)", await page.evaluate(() => (window.harness.devices[0].players || []).length) === 2);
  await until(() => G((g) => g.world.phase === "play"), 12000, "countdown over");
  check("countdown ends and play begins", await G((g) => g.world.phase) === "play");

  // ---- 7. input ---------------------------------------------------------------------------------
  const x0 = await G((g) => g.world.ducks.find((d) => d.seat === 0).x);
  await key(a, "keydown", "KeyD");
  await until(() => G((g) => g.world.ducks.find((d) => d.seat === 0).vx > 60), 4000, "duck moving");
  check("stick input moves the player's duck", await G((g) => g.world.ducks.find((d) => d.seat === 0).vx) > 60);
  await key(a, "keyup", "KeyD");
  await key(a, "keydown", "Space");
  await until(() => G((g) => g.world.ducks.find((d) => d.seat === 0).input.fire === true), 3000);
  check("holding FIRE reaches the screen", await G((g) => g.world.ducks.find((d) => d.seat === 0).input.fire) === true);
  await key(a, "keyup", "Space");
  await until(() => G((g) => g.world.ducks.find((d) => d.seat === 0).input.fire === false), 3000);
  check("releasing FIRE reaches the screen", await G((g) => g.world.ducks.find((d) => d.seat === 0).input.fire) === false);
  const dives0 = await G((g) => g.world.ducks.find((d) => d.seat === 0).dives);
  await press(a, "#dive");
  await until(() => G((g, n) => g.world.ducks.find((d) => d.seat === 0).dives > n, dives0), 3000);
  check("DIVE tap dives exactly once", await G((g) => g.world.ducks.find((d) => d.seat === 0).dives) === dives0 + 1);
  await until(() => P(a, (p) => p.status[3] === 1), 3000);
  check("phone receives its duck's status (alive, hp)", (await P(a, (p) => p.status))[0] > 0, await P(a, (p) => p.status));

  // message budget: wiggle the stick as fast as possible for a second
  const m0 = await H((h) => h.log.messages);
  const tWiggle = Date.now();
  while (Date.now() - tWiggle < 1000) {
    await P(a, (p, w) => { const codes = ["KeyW", "KeyA", "KeyS", "KeyD"]; const c = codes[(Math.random() * 4) | 0]; w.dispatchEvent(new w.KeyboardEvent(Math.random() < 0.5 ? "keydown" : "keyup", { code: c })); });
  }
  for (const c of ["KeyW", "KeyA", "KeyS", "KeyD"]) await key(a, "keyup", c);
  const secs = (Date.now() - tWiggle) / 1000;
  await sleep(100);
  const sentByA = await P(a, (p, w) => 0) === 0 ? (await H((h) => h.log.messages)) - m0 : 0;
  check("controller + screen stay under the message budget while spamming input", sentByA / secs < 60, { perSecondAllDevices: Math.round(sentByA / secs) });

  // ---- 8. pause mid-round (twice), resume (twice) ---------------------------------------------
  await H((h) => { h.pauseRaw(); h.pauseRaw(); });
  await sleep(250);
  const wt = await G((g) => g.world.time);
  await key(a, "keydown", "KeyA");
  await sleep(500);
  check("pause twice: simulation frozen", await G((g) => g.world.time) === wt && await G((g) => g.paused));
  check("input ignored while paused", await G((g) => g.world.ducks.find((d) => d.seat === 0).input.mx) === 0);
  await key(a, "keyup", "KeyA");
  await H((h) => { h.resumeRaw(); h.resumeRaw(); });
  await until(() => G((g, t) => g.world.time > t, wt), 3000);
  check("resume twice: simulation runs", await G((g) => g.world.time) > wt && !(await G((g) => g.paused)));

  // ---- 9. late joiner during an elimination round ---------------------------------------------
  const c = await H((h) => h.addController());
  await until(() => view(c).then((v) => v === "WAIT"), 8000, "late joiner waits");
  check("late joiner is told to wait", await view(c) === "WAIT" && /Battle in progress/.test(await text(c, "#wait-text")), [await view(c), await text(c, "#wait-text")]);
  check("late joiner does not disturb the round", await G((g) => g.world.ducks.length) === roster.length && await G((g) => g.seats.filter(Boolean).length) === 2);

  // ---- 10. an active player leaves, then comes back -------------------------------------------
  await H((h, id) => h.reloadController(id), b);
  await until(() => G((g) => g.seats[1] && g.seats[1].connected === false || g.world.ducks.find((d) => d.seat === 1).isBot), 3000);
  await until(() => view(b).then((v) => v === "GAME"), 8000, "returning phone back in game view");
  check("a phone that reloads mid-round returns to the game pad", await view(b) === "GAME", await view(b));
  check("...and gets its duck back from the bot", await G((g) => { const d = g.world.ducks.find((x) => x.seat === 1); return !d.isBot && g.seats[1].connected; }));
  await key(b, "keydown", "KeyS");
  await until(() => G((g) => g.world.ducks.find((d) => d.seat === 1).input.my > 0.5), 3000);
  check("the returning player controls the duck again", await G((g) => g.world.ducks.find((d) => d.seat === 1).input.my) > 0.5);
  await key(b, "keyup", "KeyS");

  // ---- 11. round end admits the waiting phone -------------------------------------------------
  await endRound(0);
  await until(() => G((g) => g.match && g.match.phase === "roundEnd"), 5000, "round end");
  check("round ends when one duck is left, winner gets the point", await G((g) => g.match.rec["d" + g.seats[0].id].wins) === 1);
  await until(() => G((g) => g.seats.filter(Boolean).length === 3), 4000, "late joiner seated");
  check("waiting phone is admitted between rounds", await G((g) => g.seats.filter(Boolean).length) === 3);
  await until(() => G((g) => g.match && g.match.round === 2 && g.world.phase !== "over"), 12000, "round 2");
  check("round 2 starts and includes the newcomer", await G((g) => g.match.round === 2 && g.world.ducks.filter((d) => !d.isBot).length === 3));
  await until(() => view(c).then((v) => v === "GAME"), 4000);
  check("newcomer now has the game pad", await view(c) === "GAME");

  // ---- 12. a player leaves for good: bot takes over, game goes on -----------------------------
  await H((h, id) => h.removeController(id), c);
  await until(() => G((g) => g.world.ducks.find((d) => d.seat === 2).isBot), 3000);
  check("a leaving player's duck is handed to a bot", await G((g) => g.world.ducks.find((d) => d.seat === 2).isBot) && await G((g) => g.state) === "MATCH");
  check("the others are told on the screen", /left/.test(await page.evaluate(() => window.harness.win(0).document.querySelector("#toasts").textContent)));

  // ---- 13. match end, results, rematch through an ad break ------------------------------------
  await until(() => G((g) => g.world.phase === "play"), 12000);
  await G((g) => { g.match.goal = 2; });
  await endRound(0);
  await until(() => G((g) => g.state === "RESULTS"), 12000, "results");
  check("match ends when the goal is reached", await G((g) => g.state) === "RESULTS");
  await until(() => view(a).then((v) => v === "RESULTS"), 4000);
  check("phones show the results view", await view(a) === "RESULTS" && await view(b) === "RESULTS");
  check("winner's phone shows 1st place", await text(a, "#res-place") === "1st", await text(a, "#res-place"));
  check("only the master gets rematch / lobby buttons", await visible(a, "#res-buttons") && !(await visible(b, "#res-buttons")));
  check("screen podium names the winner", (await screenText("#results-title")).includes(await H((h, id) => h.devices[id].nickname, a)), await screenText("#results-title"));
  check("lifetime stats are saved at match end", await H((h) => h.log.stored) >= 2, await H((h) => h.log.stored));
  await press(b, "#rematch");
  await sleep(300);
  check("rematch from a non-master is ignored", await G((g) => g.state) === "RESULTS");
  const ads0 = await H((h) => h.log.ads);
  await press(a, "#rematch");
  await until(() => H((h, n) => h.log.ads > n, ads0), 3000);
  check("leaving the results asks for an ad break", await H((h) => h.log.ads) === ads0 + 1);
  await until(() => G((g) => g.paused), 2000);
  check("game is paused while the ad shows", await G((g) => g.paused));
  await until(() => G((g) => g.state === "MATCH" && !g.paused), 8000, "rematch after ad");
  check("rematch starts after the ad completes", await G((g) => g.state === "MATCH" && g.match.round === 1));

  // ---- 14. master leaves: the next phone takes over -------------------------------------------
  await until(() => G((g) => g.world.phase === "play"), 12000);
  await G((g) => { g.match.goal = 1; });
  await endRound(1);
  await until(() => G((g) => g.state === "RESULTS"), 12000, "results 2");
  await H((h, id) => h.removeController(id), a);
  await until(() => visible(b, "#res-buttons"), 4000);
  check("when the master leaves, the next phone gets the menu", await visible(b, "#res-buttons"));
  await press(b, "#to-lobby");
  await until(() => G((g) => g.state === "LOBBY"), 8000, "back to lobby");
  check("new master returns everyone to the lobby", await G((g) => g.state) === "LOBBY" && await view(b) === "LOBBY");
  check("host panel follows the master", await visible(b, "#host-panel"));

  // ---- 15. more phones than seats -------------------------------------------------------------
  const extra = [];
  for (let i = 0; i < 8; i++) extra.push(await H((h) => h.addController()));
  await until(() => G((g) => g.seats.filter(Boolean).length === 8), 15000, "8 seats taken");
  await until(() => text(extra[7], "#wait-text").then((t) => /full/.test(t || "")), 8000);
  check("eight phones are seated", await G((g) => g.seats.filter(Boolean).length) === 8);
  check("the ninth phone is told the pond is full", await view(extra[7]) === "WAIT" && /full/.test(await text(extra[7], "#wait-text")), await text(extra[7], "#wait-text"));
  await H((h, id) => h.removeController(id), extra[0]);
  await until(() => view(extra[7]).then((v) => v === "LOBBY"), 6000);
  check("a freed seat goes to the waiting phone", await view(extra[7]) === "LOBBY");

  // ---- 16. everyone leaves mid-match ----------------------------------------------------------
  await press(b, "#start");
  await until(() => G((g) => g.state === "MATCH"), 5000);
  for (const id of await H((h) => h.ids())) await H((h, id) => h.removeController(id), id);
  await until(() => G((g) => g.state === "LOBBY"), 5000, "lobby after everyone left");
  check("if every player leaves, the game falls back to the lobby", await G((g) => g.state) === "LOBBY");

  check("no script errors on any device", errors.length === 0, errors.slice(0, 5));
} catch (e) {
  failures++;
  console.log("FAIL test crashed: " + (e.stack || e));
  if (errors.length) console.log("page errors:", errors.slice(0, 5));
}

console.log("\n" + passes + " passed, " + failures + " failed");
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
