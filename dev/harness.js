// A stand-in for the AirConsole platform, for local development and the automated tests.
// It loads the real screen.html and controller.html in iframes (which load the real AirConsole
// API script) and answers the API's postMessage protocol: ready, device updates, messages,
// custom device state, active players, pause/resume, ad breaks, vibration, persistent data.
// It is inferred from the API source, so treat it as a regression aid: always finish testing in
// the real AirConsole simulator and on real phones.
(function () {
  "use strict";
  var params = new URLSearchParams(location.search);
  var base = new URL("../", location.href).href;
  // index = device id; platform view of every device. The screen entry exists from the start
  // (as on the real platform), it just has no game location until its page is ready.
  var devices = [{ uid: "sim-uid-0", client: {} }];
  var frames = {};               // id -> { iframe, el, ready }
  var paused = false;
  var nextId = 2;
  var names = ["Mia", "Jonas", "Aiko", "Sam", "Lena", "Omar", "Zoe", "Finn", "Ines", "Kai"];
  var log = { vibrate: [], ads: 0, stored: 0, messages: 0 };

  function $(id) { return document.getElementById(id); }
  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function latency() { return Math.max(0, Number($("latency").value) || 0); }

  function post(id, data) {
    var f = frames[id];
    if (!f || !f.iframe.contentWindow) return;
    f.iframe.contentWindow.postMessage(clone(data), "*");
  }
  function updateOthers(id, flags) {
    Object.keys(frames).forEach(function (k) {
      var other = Number(k);
      if (other === id || !frames[other].ready) return;
      var dd = devices[id] ? Object.assign(clone(devices[id]), flags || {}) : undefined;
      post(other, { action: "update", device_id: id, device_data: dd });
    });
  }

  function onReady(id, d) {
    var old = devices[id];
    devices[id] = { uid: "sim-uid-" + id, location: d.location, client: {} };
    if (id !== 0) { devices[id].nickname = (old && old.nickname) || names[(id * 3) % names.length]; }
    else { devices[0].silencePlayers = d.silencePlayers; if (old && old.players) devices[0].players = old.players; }
    for (var i = 0; i < devices.length; i++) if (devices[i] === undefined) devices[i] = null;
    frames[id].ready = true;
    post(id, { action: "ready", device_id: id, devices: clone(devices), code: "123 456" });
    updateOthers(id);
    if (id === 0 && params.get("safe")) post(0, { action: "setGameSafeArea", gameSafeArea: { left: 0.06, top: 0.06, right: 0.94, bottom: 0.94 } });
    if (id === 0 && paused) post(0, { action: "pause" });
    refreshInfo();
  }

  function runAd() {
    log.ads++;
    if (!$("ads").checked) { broadcast({ action: "ad", complete: false }); return; }
    broadcast({ action: "ad" });
    veil("AIRCONSOLE HERO BREAK");
    setTimeout(function () { veil(paused ? "PAUSED" : ""); broadcast({ action: "ad", complete: true }); }, 1800);
  }
  function broadcast(data) { Object.keys(frames).forEach(function (k) { if (frames[k].ready) post(Number(k), data); }); }
  function veil(text) { var v = $("veil"); v.textContent = text; v.classList.toggle("on", !!text); }

  function onSet(id, d) {
    if (d.key === "custom") { devices[id].custom = d.value; updateOthers(id, { _is_custom_update: true }); }
    else if (d.key === "players") { devices[0].players = d.value; updateOthers(0, { _is_players_update: true }); }
    else if (d.key === "vibrate") {
      log.vibrate.push([id, d.value]);
      var el = frames[id] && frames[id].el;
      if (el) { el.classList.remove("buzz"); void el.offsetWidth; el.classList.add("buzz"); }
    }
    else if (d.key === "ad") { runAd(); }
    else if (d.key === "persistentstore") {
      log.stored++;
      var all = readStore();
      all[d.value.uid] = all[d.value.uid] || {};
      all[d.value.uid][d.value.key] = d.value.value;
      try { localStorage.setItem("duckwars-sim-store", JSON.stringify(all)); } catch (e) { /* private mode */ }
      post(id, { action: "persistentstore", uid: d.value.uid });
    }
    else if (d.key === "persistentrequest") {
      var store = readStore(), out = {};
      (d.value.uids || []).forEach(function (uid) { out[uid] = store[uid] || {}; });
      post(id, { action: "persistentrequest", data: out });
    }
  }
  function readStore() {
    try { return JSON.parse(localStorage.getItem("duckwars-sim-store") || "{}"); } catch (e) { return {}; }
  }

  window.addEventListener("message", function (event) {
    var d = event.data;
    if (!d || !d.action) return;
    var id = null;
    Object.keys(frames).forEach(function (k) { if (frames[k].iframe.contentWindow === event.source) id = Number(k); });
    if (id === null) return;
    if (d.action === "ready") { onReady(id, d); return; }
    if (!frames[id].ready) return;
    if (d.action === "set") { onSet(id, d); }
    else if (d.action === "message") {
      log.messages++;
      var targets = d.to === undefined ? Object.keys(frames).map(Number).filter(function (x) { return x !== id; }) : [d.to];
      var deliver = function () { targets.forEach(function (t) { post(t, { action: "message", from: id, to: d.to, data: d.data }); }); };
      if (latency() > 0) setTimeout(deliver, latency()); else deliver();
    }
  });

  // ---- frames ------------------------------------------------------------------------------------
  function makeScreen() {
    var iframe = document.createElement("iframe");
    iframe.setAttribute("allow", "autoplay");
    iframe.src = base + "screen.html";
    $("screen-box").insertBefore(iframe, $("veil"));
    frames[0] = { iframe: iframe, el: $("screen-box"), ready: false };
  }

  function addController(id) {
    if (id === undefined) { id = nextId; nextId += 1 + (nextId % 3 === 0 ? 2 : 0); }   // ids are never consecutive on purpose
    if (frames[id]) return id;
    var el = document.createElement("div");
    el.className = "phone";
    var head = document.createElement("div");
    head.className = "head";
    var label = document.createElement("span");
    label.textContent = "device " + id + "  " + names[(id * 3) % names.length];
    var reload = document.createElement("button"); reload.textContent = "reload";
    var drop = document.createElement("button"); drop.textContent = "leave";
    head.appendChild(label); head.appendChild(reload); head.appendChild(drop);
    var frame = document.createElement("div");
    frame.className = "frame";
    var iframe = document.createElement("iframe");
    iframe.src = base + "controller.html";
    frame.appendChild(iframe);
    el.appendChild(head); el.appendChild(frame);
    $("phones").appendChild(el);
    frames[id] = { iframe: iframe, el: el, ready: false };
    reload.onclick = function () { reloadController(id); };
    drop.onclick = function () { removeController(id); };
    iframe.addEventListener("load", function () {
      try {
        iframe.contentWindow.addEventListener("focus", function () {
          var all = document.querySelectorAll(".phone"); for (var i = 0; i < all.length; i++) all[i].classList.remove("focus");
          el.classList.add("focus");
        });
      } catch (e) { /* cross-origin in some setups */ }
    });
    refreshInfo();
    return id;
  }

  function removeController(id, keepEl) {
    var f = frames[id];
    if (!f) return;
    delete frames[id];
    if (!keepEl && f.el.parentNode) f.el.parentNode.removeChild(f.el);
    devices[id] = null;
    Object.keys(frames).forEach(function (k) { if (frames[k].ready) post(Number(k), { action: "update", device_id: id, device_data: undefined }); });
    refreshInfo();
    return f;
  }

  // A phone that reloads the page: it leaves, then comes back with the same device id.
  function reloadController(id) {
    var f = removeController(id, true);
    if (!f) return;
    frames[id] = { iframe: f.iframe, el: f.el, ready: false };
    f.iframe.src = base + "controller.html?r=" + Date.now();
  }

  function setPaused(p) {
    paused = p;
    $("pause").textContent = p ? "Resume" : "Pause";
    $("pause").classList.toggle("on", p);
    veil(p ? "PAUSED" : "");
    if (frames[0] && frames[0].ready) post(0, { action: p ? "pause" : "resume" });
  }

  function refreshInfo() {
    var n = Object.keys(frames).length - 1;
    $("info").textContent = n + " phone" + (n === 1 ? "" : "s") + " connected";
  }

  $("add").onclick = function () { addController(); };
  $("pause").onclick = function () { setPaused(!paused); };

  if (params.get("hidephones")) document.body.classList.add("hide-phones");
  if (params.get("ads") === "0") $("ads").checked = false;
  if (params.get("paused")) { paused = true; $("pause").textContent = "Resume"; $("pause").classList.add("on"); veil("PAUSED"); }
  makeScreen();
  var start = params.get("phones");
  var count = start === null ? 2 : Number(start);
  for (var i = 0; i < count; i++) addController();

  // For the automated tests.
  window.harness = {
    addController: addController,
    removeController: removeController,
    reloadController: reloadController,
    setPaused: setPaused,
    pauseRaw: function () { post(0, { action: "pause" }); },
    resumeRaw: function () { post(0, { action: "resume" }); },
    frames: frames,
    devices: devices,
    log: log,
    ids: function () { return Object.keys(frames).map(Number).filter(function (x) { return x !== 0; }); },
    win: function (id) { return frames[id] && frames[id].iframe.contentWindow; }
  };
})();
