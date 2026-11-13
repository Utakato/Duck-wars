# Duck Wars: Pond Royale

A couch-multiplayer pond battle for [AirConsole](https://www.airconsole.com): the TV or browser
is the pond, every phone is a gamepad. Up to eight ducks paddle around, grab weapon crates, dive
under bullets and try to be the last one floating. Empty seats are filled by bots, so it also
works with one player.

Everything is original and generated in code: the ducks, hats, ponds, effects, sound effects and
music. There are no image or audio files in the game, so the whole upload is about 210 KB.

## Playing

| On the phone | Does |
|---|---|
| Left half: thumb stick (starts wherever your thumb lands) | Paddle. Your duck aims by itself at the nearest rival. |
| **FIRE** (hold) | Shoot. As a ghost: **BOO** nearby ducks away. |
| **DIVE** | Go under for a moment: bullets pass over you, fire goes out, and you bump whoever you surface under. Short cooldown. |
| **QUACK** | Quack. Gives away your position in the reeds. Essential. |

The host (the AirConsole master controller) picks mode, pond, match length, number of bots and
bot skill in the lobby. Everyone picks a hat; hats and lifetime stats are saved per player.

**Modes**

- **Last Duck Floating**: one life per round, first to 3/5/7 round wins. After a while a ring of
  piranhas closes in so rounds always end. Splashed ducks haunt the pond as ghosts and can shove
  the living.
- **Feather Frenzy**: respawns, most splashes when the clock runs out. A tie goes to overtime.
- **Golden Loaf**: hold the golden loaf to score one point per second. The carrier is slower,
  cannot dive, and everybody knows where they are.

**Weapons** (crates drop by parachute; the starting Pea Popper never runs dry)

Crumb Blaster (shotgun whose recoil doubles as a jet), Reed Rattler (bullet hose), Bloop Tube
(rocket), Bobber Mines, Pike Torpedo (homes in under water, so diving does not help), Long Beak
(piercing sniper with a visible laser), Chili Breath (flamethrower; dive to put yourself out),
Eel Zapper (chain lightning, worse for divers), Tsunami Horn (a wave that shoves ducks, crates
and bullets), Skipping Stones (ricochet off the bank and hit harder each skip), Egg Mortar
(lobbed over rocks).

Also in the water: bread (heals), bubble shield, turbo, explosive barrels, reeds to hide in.

**Ponds**: Lily Lagoon, Twin Ponds, Mill Race (a current runs around the island), Stone Garden,
The Maelstrom (a whirlpool in the middle). "Random pond" rotates them.

## Running it

No build step. The game is plain ES modules.

```
node tools/serve.mjs            # serves the folder on http://localhost:8080
```

- **Local simulator** (no AirConsole account, works offline apart from the API script):
  open `http://localhost:8080/dev/`. It shows the screen and virtual phones, with buttons for
  adding/removing phones, pause, ad breaks and artificial latency. Click a phone and use
  WASD/arrows, Space (fire), Shift (dive), Q (quack), Enter (start).
  It is a stand-in for the platform written from the API source, good for development and the
  automated tests, not a replacement for the two options below.
- **AirConsole simulator**: `http://http.airconsole.com/simulator/#debug:http://<your-LAN-IP>:8080/`
- **Real phones**: screen at `https://www.airconsole.com/#http://<your-LAN-IP>:8080/`, phones
  join at airconsole.com with the code. Use the LAN IP, never `localhost`. If the network isolates
  clients, use a tunnel (`cloudflared tunnel --url http://localhost:8080`) and the `https` forms.

## Tests

```
npm test                        # everything below
node tests/syntax.spec.mjs      # every game file parses as ES2017 (old TV and car browsers)
node tests/sim.spec.mjs         # 160 checks: maps, movement, every weapon, mode rules, bots (plain Node)
node tests/audio.spec.mjs       # renders every sound and music track offline: no silence, no clipping, pause is silent
node tests/e2e.spec.mjs         # 63 checks in headless Chromium with the real AirConsole API file
```

The browser tests need Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`).
They download `airconsole-1.11.0.js` once into `dev/vendor/`.

The end-to-end test covers the AirConsole test plan where it can be automated: lobby and master
controller rules (including forged menu messages from non-masters), input, pause and resume
twice in a row, pause in the lobby, late joiners, a phone reloading mid-round and getting its duck
back, a player leaving (a bot takes over), round and match end, the ad break, the master leaving,
nine phones for eight seats, everyone leaving, and the message rate.

## What still needs a human

These cannot be checked from a headless container and should be done before submitting:

- Play it in the real AirConsole simulator and with real phones (iOS Safari/Chrome, Android
  Chrome, the AirConsole app on both), including a 320x480 phone.
- Listen to it. The audio is verified numerically (levels, clipping, silence while paused), but
  nobody has heard the mix or the music yet.
- Frame rate on a low-end TV stick and on an old Chrome. The screen drops caustics, foam and
  resolution by itself when it measures less than ~34 fps, but the threshold is a guess until it
  runs on real hardware. In this container (software rendering, no GPU) full quality runs at
  about 20 to 25 fps and reduced quality at about 50.
- Latency: try `?server=asia-east1-a` in the AirConsole simulator. Aiming is automatic on purpose
  so that phone latency only affects movement.
- The Hero promotion with a third non-Hero controller.
- Balance. Numbers were tuned with bot matches, not people.

## How it is put together

```
screen.html, controller.html     the two pages AirConsole loads
css/                             screen.css, controller.css
js/shared/config.js              colours, hats, modes, weapon names, the message protocol
js/shared/duckart.js             vector art for ducks, hats, weapons, pickups (canvas paths)
js/screen/main.js                AirConsole wiring, lobby/match/results flow, events -> effects
js/screen/sim.js                 the simulation: fixed 60 Hz step, no DOM, also runs in Node
js/screen/maps.js                ponds as signed distance fields, nav grid, A*, spawn points
js/screen/weapons.js             weapon behaviour
js/screen/bots.js                bot AI (perceive on a timer -> decide -> path -> steer)
js/screen/render.js              canvas renderer; the shore is baked once per pond
js/screen/fx.js                  particles, camera shake and zoom
js/screen/audio.js               procedural sound effects and music (Web Audio)
js/screen/ui.js                  lobby and results overlays
js/controller/main.js            the phone: input, views driven by the screen's state
dev/                             local simulator (stand-in for the AirConsole platform)
tests/, tools/                   tests, dev server, packaging
```

Design decisions worth knowing:

- **The screen is authoritative.** Phones send intent only. Bots write the same input struct a
  phone would, so they play by the same rules.
- **One depth field per pond** drives collision, bullets, bot navigation, spawn points and the
  baked artwork, so what you see is what you hit.
- **Phones are drawn from the screen's custom device state**, so a phone that reloads or
  reconnects lands in the right view with the right colour and gets its duck back.
- **Input is sent as whole state with tap counters**, throttled to about 22 packets per second,
  so a delayed packet can never leave a button stuck or lose a dive.
- **Leaving never stops the game.** A leaving player's duck is handed to a bot and handed back if
  they return. Late phones join straight away in the respawn modes and at the next round in
  Last Duck Floating.
- **Pause and ad breaks** freeze the simulation and silence everything; both are idempotent.
  The flow leaves the results screen only from `onAdComplete` (with a short safety timer).

### Message protocol

| Direction | Payload | When |
|---|---|---|
| controller to screen | `{ i: [x, y, bits, dive, quack] }` | input changed; x, y in -100..100, bits 1 = fire held, dive and quack are tap counters |
| controller to screen | `{ m: "start" }`, `{ m: "rematch" }`, `{ m: "lobby" }` | master taps a menu button |
| controller to screen | `{ m: "cfg", k: "mode"/"map"/"goal"/"bots"/"diff", d: -1 or 1 }` | master changes a setting |
| controller to screen | `{ m: "hat", d: -1 or 1 }`, `{ m: "quack" }` | anyone, in the lobby |
| screen to controller | `{ s: [hp, weapon, ammo, life, cd, shield, loaf, diveBusy] }` | that player's duck changed (max 10 per second) |
| screen to controller | `{ v: id }` | vibrate (hit, splashed, pickup, win...) |
| screen to controller | `{ t: "text" }` | short private toast |
| screen state | `{ view, cfg, bots, seats: { deviceId: [seat, hat] }, mode, round, late, res }` | every lobby, round or seat change |

### Tuning

Movement, health, dive and respawn times are constants at the top of `js/screen/sim.js`. Weapon
numbers are in `js/screen/weapons.js`, crate odds in `WEAPON_WEIGHTS`, bot skill tables at the top
of `js/screen/bots.js`, pond shapes in `DEFS` in `js/screen/maps.js`. After changing any of
them, run `node tests/sim.spec.mjs`.

## Publishing

```
node tools/package.mjs          # preflight checks, then dist/duck-wars.zip
```

The zip has `screen.html` and `controller.html` in its root plus `css/`, `js/` and `fonts/`.
Upload it in the AirConsole developer console. The packer refuses to build if a page has more or
fewer than one pinned API script tag, if anything references plain `http://` or an absolute path,
or if a page contains an `<img>` tag.

Before submitting, confirm the current API version at
https://github.com/AirConsole/airconsole-api (this build pins 1.11.0 in both HTML files) and go
through the list under "What still needs a human".

A note on the name: several small unrelated games already use "Duck Wars". If you want a unique
store title, change `GAME_TITLE` in `js/shared/config.js` and the two logo lines in `screen.html`
and `controller.html`.

## Credits and licences

- Fonts: Lilita One and Fredoka, SIL Open Font License 1.1 (licence texts in `fonts/`).
- AirConsole API: loaded from airconsole.com at runtime; not part of this repository.
- AirConsole is a trademark of its owner. This is an independent game for that platform.
