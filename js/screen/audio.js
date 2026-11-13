/*
 * Duck Wars - procedural audio engine (TV screen side).
 *
 * Everything is synthesised with the Web Audio API: there are no audio asset
 * files. One-shot sfx, sustained loops, the duck quack and a small look-ahead
 * step sequencer for the music all live in this module.
 *
 * Signal graph:
 *   voices -> sfxBus  \
 *                      > master -> DynamicsCompressor (limiter-ish) -> destination
 *   tracks -> musicBus /
 *
 * Syntax is kept at ES2017 level on purpose (old embedded Chromium in TVs and
 * cars must be able to parse this file): no optional chaining, no nullish
 * coalescing, no object spread, no optional catch binding.
 */

const LOOKAHEAD = 0.2;      // seconds of music scheduled ahead of the audio clock
const TICK_MS = 50;         // scheduler wake-up interval
const MAX_VOICES = 24;      // simultaneous one-shot sfx voices
const MAX_LOOPS = 12;       // simultaneous sustained loops
const XFADE = 0.6;          // music crossfade in seconds
const MASTER_GAIN = 0.5;
const SFX_GAIN = 1.0;
const MUSIC_GAIN = 0.32;    // music bus sits about 10 dB under the sfx bus
const NOISE_RMS = 0.5;     // every noise colour is normalised to this level

function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
function num(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }
function noop() {}

const NOTE_INDEX = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

function midi(name) {
  const m = /^([a-g])([#b]?)(\d)$/.exec(name);
  if (!m) return -1;
  return NOTE_INDEX[m[1]] + (m[2] === '#' ? 1 : (m[2] === 'b' ? -1 : 0)) + (parseInt(m[3], 10) + 1) * 12;
}

function hz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

// Pitches used by the tonal sfx. They all sit on D / E / A (plus the D major
// triad for the fanfares) so they agree with every music track.
const D3 = hz(50), G2 = hz(43), A2 = hz(45);
const D4 = hz(62), A4 = hz(69), D5 = hz(74), E5 = hz(76), FS5 = hz(78), G5 = hz(79);
const A5 = hz(81), BB5 = hz(82), B5 = hz(83), CS6 = hz(85), D6 = hz(86), E6 = hz(88);
const FS6 = hz(90), A6 = hz(93), D7 = hz(98), E7 = hz(100), A7 = hz(105);

/* ------------------------------------------------------------------------ *
 * One-shot sfx table: name -> [gain, min retrigger interval (s), random
 * pitch variation (+-), priority]. Higher priority voices are never stolen by
 * lower priority ones when the voice cap is reached.
 * ------------------------------------------------------------------------ */
const SFX = {
  // weapons
  pea:           [1.42, 0.040, 0.05, 0],
  shotgun:       [2.96, 0.060, 0.04, 0],
  smg:           [4.21, 0.035, 0.05, 0],
  rocket:        [1.58, 0.050, 0.04, 0],
  torpedo:       [1.51, 0.050, 0.04, 0],
  sniper:        [4.45, 0.060, 0.03, 0],
  zap:           [0.41, 0.050, 0.05, 0],
  wave:          [1.02, 0.080, 0.02, 0],
  stone:         [1.43, 0.040, 0.05, 0],
  egg:           [2.52, 0.040, 0.05, 0],
  mine_drop:     [0.85, 0.040, 0.04, 0],
  mine_beep:     [0.12, 0.040, 0.00, 0],
  empty:         [3.08, 0.050, 0.03, 0],
  // impacts
  explosion:     [2.63, 0.050, 0.06, 1],
  explosion_big: [2.91, 0.080, 0.04, 1],
  hit:           [4.83, 0.030, 0.06, 0],
  shield_hit:    [0.75, 0.030, 0.04, 0],
  shield_pop:    [0.76, 0.050, 0.03, 0],
  bounce:        [1.29, 0.030, 0.06, 0],
  burn:          [0.76, 0.080, 0.05, 0],
  nibble:        [2.07, 0.060, 0.06, 0],
  // water
  splash_small:  [1.34, 0.050, 0.08, 0],
  splash_big:    [1.40, 0.060, 0.05, 0],
  dive:          [0.97, 0.040, 0.04, 0],
  surface:       [0.55, 0.040, 0.04, 0],
  // pickups
  pickup_weapon: [0.27, 0.040, 0.00, 1],
  pickup_bread:  [0.27, 0.040, 0.00, 1],
  pickup_power:  [0.53, 0.040, 0.00, 1],
  crate_land:    [1.63, 0.050, 0.04, 0],
  // ducks
  death:         [1.06, 0.040, 0.04, 1],
  respawn:       [0.76, 0.040, 0.02, 1],
  // flow
  countdown:     [0.34, 0.100, 0.00, 2],
  go:            [0.60, 0.200, 0.00, 2],
  round_win:     [0.35, 0.300, 0.00, 2],
  match_win:     [0.34, 0.500, 0.00, 2],
  sudden:        [0.65, 0.300, 0.00, 2],
  bread_tick:    [1.23, 0.030, 0.02, 0],
  join:          [0.39, 0.040, 0.00, 1],
  leave:         [0.53, 0.040, 0.00, 1],
  ui_move:       [2.90, 0.030, 0.00, 0],
  ui_select:     [0.25, 0.040, 0.00, 1]
};

const QUACK_GAIN = 2.15;
const LOOP_GAIN = { flame: 0.41, whirl: 0.22 };

/*
 * Quack recipe. A narrow pulse (reed-like, nasal) is pushed through a small
 * formant bank whose resonances open and close like a bill ("kw" -> "a" ->
 * "ck"), with amplitude roughness for the rasp. Breakpoints are
 * [fraction of duration, value].
 */
const QUACK = {
  d: 0.27, f0: 290, g: 1,
  amp: [[0, 0], [0.05, 1], [0.32, 0.88], [0.42, 0.42], [0.52, 1], [0.84, 0.75], [0.94, 0]],
  pit: [[0, 0.78], [0.1, 1.14], [0.34, 1.06], [0.44, 0.94], [0.55, 1.04], [1, 0.66]],
  F1: [[0, 480], [0.16, 1150], [0.36, 1020], [0.44, 800], [0.6, 1200], [0.85, 1050], [1, 700]],
  F2: [[0, 1000], [0.16, 2300], [0.4, 2000], [0.6, 2400], [1, 1600]],
  F3: 3200, q1: 5, q2: 7,
  sub: [[0, 0.1], [0.5, 0.25], [1, 0.5]],
  rr: 78, rr1: 50, rd: 0.38, breath: 0.07, jit: 35
};

// "Deflating" variant used by the death sound: squeaky start, long sputtering
// pitch fall (a raspberry), then the builder adds a pop.
const DEATH_QUACK = {
  d: 0.6, f0: 330, g: 1.6,
  amp: [[0, 0], [0.04, 1], [0.45, 0.85], [0.85, 0.5], [1, 0]],
  pit: [[0, 1.0], [0.07, 1.55], [0.3, 1.2], [1, 0.42]],
  F1: [[0, 900], [0.1, 1350], [0.5, 1050], [1, 600]],
  F2: [[0, 1800], [0.1, 2600], [0.5, 2100], [1, 1300]],
  F3: 3300, q1: 5, q2: 7,
  sub: [[0, 0], [0.4, 0.2], [1, 0.6]],
  rr: 40, rr1: 15, rd: 0.46, breath: 0.08, jit: 50
};

/* ------------------------------------------------------------------------ *
 * Music. Original loops written for this game as 16-step bars.
 *
 * Drum parts: one char per 16th. x = hit, X = accent, o = ghost, . = rest.
 * Note parts: 16 tokens per bar. A note name starts a note, "-" holds it,
 *             "." is a rest.
 * Chord parts: "rhythm|notes" (x = short stab, l = quarter, w = whole bar),
 *             several of them can be joined with " + " inside one bar.
 * Entries of a part cycle when a section has more bars than entries.
 * ------------------------------------------------------------------------ */
const OFF8 = '..x...x...x...x.';
const TRES = 'x..x..x.x..x..x.';
const FOUR = 'x...x...x...x...';
const BACK = '....x.......x...';

// --- lobby: F major, relaxed off-beat bounce ---
const LB_BASS = [
  'f2 - - f2 . . c3 - f2 - - f2 a2 - c3 -',
  'bb2 - - bb2 . . f3 - bb2 - - bb2 d3 - f3 -',
  'a2 - - a2 . . e3 - a2 - - a2 c3 - e3 -',
  'bb2 - - bb2 . . f3 - c3 - - c3 g2 - c3 -',
  'f2 - - f2 . . c3 - f2 - - f2 a2 - c3 -',
  'd3 - - d3 . . a2 - d3 - - d3 f3 - a2 -',
  'g2 - - g2 . . d3 - g2 - - g2 bb2 - d3 -',
  'c3 - - c3 . . g2 - c3 - d3 - e3 - c3 -'
];
const LB_CHORD = [
  OFF8 + '|a3 c4 f4',
  OFF8 + '|bb3 d4 f4',
  OFF8 + '|g3 c4 e4',
  '..x...x.........|bb3 d4 f4 + ..........x...x.|c4 e4 g4',
  OFF8 + '|a3 c4 f4',
  OFF8 + '|a3 d4 f4',
  OFF8 + '|bb3 d4 f4',
  OFF8 + '|bb3 e4 g4'
];
const LB_KICK = ['x.......x.......', 'x......ox.......'];
const LB_RIM = [BACK, BACK, BACK, '....x.......x.x.'];
const LB_SHAKER = ['o.xoo.x.o.xoo.x.'];

// --- battle: D mixolydian / D major, 32 bars (A1 B A2 C) ---
const BT_BASS_A = [
  'd2 - d3 - d2 - d3 - d2 - d3 - d2 - d3 -',
  'c2 - c3 - c2 - c3 - c2 - c3 - c2 - c3 -',
  'g2 - g3 - g2 - g3 - g2 - g3 - g2 - g3 -',
  'a2 - a3 - a2 - a3 - a2 - a3 - b2 - c#3 -',
  'd2 - d3 - d2 - d3 - d2 - d3 - d2 - d3 -',
  'c2 - c3 - c2 - c3 - c2 - c3 - c2 - c3 -',
  'g2 - g3 - g2 - g3 - g2 - g3 - g2 - g3 -'
];
const BT_CHORD_A = [
  OFF8 + '|f#4 a4 d5', OFF8 + '|e4 g4 c5', OFF8 + '|d4 g4 b4', OFF8 + '|e4 a4 c#5'
];
const BT_LEAD_A = [
  'a4 - - d5 - - f#5 - e5 - - d5 - - a4 -',
  'g4 - - c5 - - e5 - d5 - - c5 - - g4 -',
  'b4 - - d5 - - g5 - f#5 - g5 - a5 - - -',
  'a5 - . . e5 - c#5 - e5 - a5 - b5 - c#6 -',
  'd6 - - a5 - - f#5 - e5 - - d5 - - a4 -',
  'g4 - - c5 - - e5 - g5 - - e5 - - c5 -',
  'd5 - - g5 - - b5 - a5 - - g5 - - d5 -'
];
const BT_ARP_A = [
  'd4 f#4 a4 d5 a4 f#4 d4 f#4 a4 d5 a4 f#4 d4 f#4 a4 d5',
  'c4 e4 g4 c5 g4 e4 c4 e4 g4 c5 g4 e4 c4 e4 g4 c5',
  'd4 g4 b4 d5 b4 g4 d4 g4 b4 d5 b4 g4 d4 g4 b4 d5',
  'e4 a4 c#5 e5 c#5 a4 e4 a4 c#5 e5 c#5 a4 e4 a4 c#5 e5'
];

// --- sudden death: D minor gallop ---
const SD_BASS_1 = [
  'd2 - d2 d2 d2 - d2 d2 d2 - d2 d2 d2 - d2 d2',
  'd2 - d2 d2 d2 - d2 d2 d2 - d2 d2 d2 - f2 e2',
  'bb2 - bb2 bb2 bb2 - bb2 bb2 bb2 - bb2 bb2 bb2 - bb2 bb2',
  'a2 - a2 a2 a2 - a2 a2 a2 - a2 a2 a2 - c#3 e3'
];
const SD_BASS_2 = [
  'd2 - d2 d2 d2 - d2 d2 d2 - d2 d2 d2 - d2 d2',
  'f2 - f2 f2 f2 - f2 f2 f2 - f2 f2 f2 - f2 f2',
  'g2 - g2 g2 g2 - g2 g2 g2 - g2 g2 g2 - g2 g2',
  'a2 - a2 a2 a2 - a2 a2 a2 - a2 a2 a2 - c#3 e3'
];

const SONGS = {
  lobby: {
    bpm: 100, swing: 0.2, transpose: 0, level: 1.69,
    inst: { bass: 'round', chord: 'marimba', lead: 'whistle', arp: 'kalimba' },
    mix: { kick: 0.7, rim: 0.8, shaker: 0.8, bass: 0.9, chord: 1.1, lead: 1.2, arp: 1.2 },
    order: ['A', 'B'],
    sections: {
      A: {
        bars: 8, kick: LB_KICK, rim: LB_RIM, shaker: LB_SHAKER, bass: LB_BASS, chord: LB_CHORD,
        arp: [
          null,
          '. . . . . . . . . . f5 - d5 - bb4 -',
          null,
          '. . . . . . . . g5 - e5 - c5 - . .',
          null,
          '. . . . . . . . . . a5 - f5 - d5 -',
          null,
          '. . . . c5 - e5 - g5 - bb5 - c6 - . .'
        ]
      },
      B: {
        bars: 8, kick: LB_KICK, rim: LB_RIM, shaker: LB_SHAKER, bass: LB_BASS, chord: LB_CHORD,
        lead: [
          'a4 - c5 - d5 - - c5 a4 - - - . . . .',
          'd5 - f5 - d5 - - c5 bb4 - - - . . . .',
          'c5 - e5 - c5 - - a4 g4 - - - . . . .',
          'f4 - bb4 - d5 - - - e5 - d5 - c5 - - .',
          'c5 - f5 - a5 - - g5 f5 - - - . . c5 -',
          'd5 - f5 - a5 - - f5 d5 - - - . . . .',
          'bb4 - d5 - g5 - - f5 d5 - - - . . . .',
          'e5 - g5 - bb5 - g5 - e5 - c5 - g4 - - .'
        ]
      }
    }
  },

  battle: {
    bpm: 132, swing: 0, transpose: 0, level: 0.98,
    inst: { bass: 'chip', chord: 'stab', lead: 'square', arp: 'pluck' },
    mix: { kick: 1.0, snare: 1.0, hat: 1.0, ohat: 0.8, rim: 0.8, crash: 1.0, tom: 1.0, bass: 1.0, chord: 1.0, lead: 1.0, arp: 0.8 },
    order: ['A1', 'B', 'A2', 'C'],
    sections: {
      A1: {
        bars: 8,
        crash: ['x...............', null, null, null, null, null, null, null],
        kick: [FOUR],
        snare: [BACK, BACK, BACK, BACK, BACK, BACK, BACK, '....x.......x.xx'],
        hat: [OFF8],
        bass: BT_BASS_A.concat(['a2 - a3 - a2 - a3 - a2 - a2 - a2 - a#2 -']),
        chord: BT_CHORD_A,
        lead: BT_LEAD_A.concat(['e5 - e5 - f#5 - e5 - c#5 - - - a4 - - -'])
      },
      B: {
        bars: 8,
        crash: ['x...............', null, null, null, 'x...............', null, null, null],
        kick: [FOUR, FOUR, FOUR, 'x...x...x...x.x.'],
        snare: [BACK, BACK, BACK, BACK, BACK, BACK, BACK, '....x.......xxxX'],
        hat: ['xoxoxoxoxoxoxoxo'],
        bass: [
          'b2 - . b2 - . b2 - b2 - . b2 - . f#2 -',
          'g2 - . g2 - . g2 - g2 - . g2 - . d3 -',
          'd3 - . d3 - . d3 - d3 - . d3 - . a2 -',
          'a2 - . a2 - . a2 - a2 - . a2 - . e3 -',
          'b2 - . b2 - . b2 - b2 - . b2 - . f#2 -',
          'g2 - . g2 - . g2 - g2 - . g2 - . d3 -',
          'a2 - . a2 - . a2 - a2 - . a2 - . e3 -',
          'a2 - . a2 - . a2 - a2 - a2 - b2 - c#3 -'
        ],
        chord: [
          TRES + '|d4 f#4 b4', TRES + '|d4 g4 b4', TRES + '|d4 f#4 a4', TRES + '|e4 a4 c#5',
          TRES + '|d4 f#4 b4', TRES + '|d4 g4 b4', TRES + '|e4 a4 c#5', TRES + '|e4 a4 c#5'
        ],
        lead: [
          'f#5 - - - d5 - b4 - d5 - - - f#5 - d5 -',
          'g5 - - - d5 - b4 - d5 - - - g5 - b5 -',
          'a5 - - - - - f#5 - d5 - - - f#5 - a5 -',
          'e5 - - - c#5 - - - e5 - f#5 - e5 - c#5 -',
          'b5 - - - f#5 - d5 - f#5 - - - b5 - f#5 -',
          'b5 - - - g5 - d5 - g5 - - - b5 - d6 -',
          'c#6 - - a5 - - e5 - c#6 - - a5 - - e5 -',
          'e5 f#5 a5 b5 c#6 - a5 - e6 - - - . . . .'
        ]
      },
      A2: {
        bars: 8,
        crash: ['x...............', null, null, null, null, null, null, null],
        kick: [FOUR, FOUR, FOUR, FOUR, FOUR, FOUR, FOUR, 'x...x...x.......'],
        snare: [BACK, BACK, BACK, BACK, BACK, BACK, BACK, '....x...x.x.xxxX'],
        hat: ['o.xoo.xoo.xoo.xo'],
        ohat: [null, '..............x.'],
        bass: BT_BASS_A.concat(['a2 - a3 - a2 - a3 - a2 - a3 - b2 - c#3 -']),
        chord: BT_CHORD_A,
        arp: BT_ARP_A,
        lead: BT_LEAD_A.concat(['e5 - e5 - f#5 - e5 - a5 - - - c#6 - - -'])
      },
      C: {
        bars: 8,
        crash: ['x...............', null, null, null, null, null, null, null],
        kick: ['x.....x.....x...', 'x.....x.....x...', 'x.....x.....x...', 'x.....x.....x.x.', FOUR, FOUR, FOUR, FOUR],
        rim: [BACK, BACK, BACK, BACK, null, null, null, null],
        hat: [OFF8, OFF8, OFF8, OFF8, 'x.x.x.x.x.x.x.x.', 'x.x.x.x.x.x.x.x.', 'xoxoxoxoxoxoxoxo', 'xoxoxoxoxoxoxoxo'],
        snare: [null, null, null, null, 'o...o...o...o...', 'o.o.o.o.o.o.o.o.', 'x.x.x.x.x.x.x.x.', 'xxxxxxxxxxxxXXXX'],
        tom: [null, null, null, null, null, null, null, '............xxxx'],
        bass: [
          'd2 - - - - - . . d2 - - - - - . .',
          'd2 - - - - - . . d2 - - - d3 - d2 -',
          'c2 - - - - - . . c2 - - - - - . .',
          'c2 - - - - - . . c2 - - - c3 - c2 -',
          'g2 - g2 - g2 - g2 - g2 - g2 - g2 - g2 -',
          'g2 - g2 - g2 - g2 - g2 - g2 - g3 - g2 -',
          'a2 - a2 - a2 - a2 - a2 - a2 - a2 - a2 -',
          'a2 a2 a2 a2 a2 a2 a2 a2 a2 a2 a2 a2 a2 - c#3 -'
        ],
        arp: [
          'd5 a4 f#5 a4 d5 a4 e5 a4 d5 a4 f#5 a4 a5 a4 f#5 a4',
          'd5 a4 f#5 a4 d5 a4 e5 a4 d5 a4 a5 a4 f#5 a4 e5 a4',
          'c5 g4 e5 g4 c5 g4 d5 g4 c5 g4 e5 g4 g5 g4 e5 g4',
          'c5 g4 e5 g4 c5 g4 d5 g4 c5 g4 g5 g4 e5 g4 d5 g4',
          'b4 g4 d5 g4 b4 g4 d5 g4 g5 g4 d5 g4 b4 g4 d5 g4',
          'b4 g4 d5 g4 g5 g4 d5 g4 b5 g4 g5 g4 d5 g4 b4 g4',
          'c#5 a4 e5 a4 c#5 a4 e5 a4 a5 a4 e5 a4 c#5 a4 e5 a4',
          'c#5 a4 e5 a4 a5 a4 e5 a4 c#6 a4 a5 a4 e5 a4 c#6 a4'
        ],
        lead: [
          null, null, null, null,
          'd5 - - - - - - - g5 - - - - - - -',
          'b5 - - - - - - - a5 - - - g5 - - -',
          'a5 - - - - - - - c#6 - - - - - - -',
          'e6 - - - - - - - . . . . . . . .'
        ]
      }
    }
  },

  sudden: {
    bpm: 150, swing: 0, transpose: 0, level: 1.24,
    inst: { bass: 'drive', chord: 'stab', lead: 'saw', arp: 'pluck' },
    mix: { kick: 1.0, snare: 1.0, hat: 0.75, crash: 0.8, tom: 1.0, bass: 1.0, chord: 0.9, lead: 1.0, arp: 0.7 },
    order: ['S1', 'S2'],
    sections: {
      S1: {
        bars: 8,
        crash: ['x...............', null, null, null, null, null, null, null],
        kick: [FOUR, FOUR, FOUR, 'x...x...x...x.x.'],
        snare: [BACK, BACK, BACK, '....x.......x.xx'],
        hat: ['xoxoxoxoxoxoxoxo'],
        tom: [null, null, null, '..........x.x...'],
        bass: SD_BASS_1,
        chord: [OFF8 + '|d4 f4 a4', OFF8 + '|d4 f4 a4', OFF8 + '|d4 f4 bb4', OFF8 + '|c#4 e4 a4'],
        lead: [
          'a5 - - - - - - - g5 - - - f5 - - -',
          'e5 - - - f5 - - - d5 - - - - - - .',
          'd5 - - - f5 - - - bb5 - - - - - - -',
          'a5 - - - g5 - e5 - c#5 - - - - - . .',
          'a5 - - - - - - - g5 - - - f5 - - -',
          'e5 - - - f5 - - - d5 - - - - - - .',
          'd5 - - - f5 - - - bb5 - - - - - - -',
          'a5 - - - g5 - e5 - a5 - - - c#6 - - -'
        ]
      },
      S2: {
        bars: 8,
        crash: ['x...............', null, null, null, 'x...............', null, null, null],
        kick: [FOUR, FOUR, FOUR, 'x...x...x...x.x.'],
        snare: [BACK, BACK, BACK, BACK, BACK, BACK, BACK, '....x...x.x.xxxX'],
        hat: ['xoxoxoxoxoxoxoxo'],
        tom: [null, null, null, '............x.x.', null, null, null, null],
        bass: SD_BASS_2,
        chord: [OFF8 + '|d4 f4 a4', OFF8 + '|c4 f4 a4', OFF8 + '|d4 g4 bb4', OFF8 + '|c#4 e4 a4'],
        arp: [
          'd5 a4 f5 a4 d5 a4 f5 a4 d5 a4 f5 a4 d5 a4 f5 a4',
          'c5 a4 f5 a4 c5 a4 f5 a4 c5 a4 f5 a4 c5 a4 f5 a4',
          'd5 bb4 g5 bb4 d5 bb4 g5 bb4 d5 bb4 g5 bb4 d5 bb4 g5 bb4',
          'c#5 a4 e5 a4 c#5 a4 e5 a4 c#5 a4 e5 a4 c#5 a4 e5 a4'
        ],
        lead: [
          'd6 - - - - - - - a5 - - - - - - -',
          'c6 - - - a5 - - - f5 - - - - - a5 -',
          'bb5 - - - g5 - - - d5 - - - g5 - - -',
          'a5 - - - e5 - - - c#6 - - - - - - .',
          'd6 - - - - - - - a5 - - - - - - -',
          'c6 - - - a5 - - - f5 - - - - - a5 -',
          'bb5 - - - g5 - - - d5 - - - g5 - - -',
          'a5 - . . c#6 - . . e6 d6 c#6 bb5 a5 g5 f5 e5'
        ]
      }
    }
  },

  // Written in C, played in D (transpose +2) so it agrees with the fanfare sfx.
  victory: {
    bpm: 120, swing: 0, transpose: 2, level: 1.25,
    inst: { bass: 'march', chord: 'brass', lead: 'brass', arp: 'pluck' },
    mix: { kick: 0.9, snare: 0.7, hat: 0.5, crash: 0.8, bass: 1.0, chord: 0.9, lead: 1.0 },
    order: ['V'],
    sections: {
      V: {
        bars: 8,
        crash: ['x...............', null, null, null, 'x...............', null, null, null],
        kick: ['x.......x.......', 'x.......x.....x.'],
        snare: ['....x.oo....x.oo', '....x.oo....x.oo', '....x.oo....x.oo', '....x.oo....x.oo',
          '....x.oo....x.oo', '....x.oo....x.oo', '....x.oo....x.oo', 'x.oox.oox.ooxxxX'],
        hat: ['x.x.x.x.x.x.x.x.'],
        bass: [
          'c3 - - . g2 - - . c3 - - . g2 - - .',
          'f2 - - . c3 - - . f2 - - . c3 - - .',
          'g2 - - . d3 - - . g2 - - . d3 - - .',
          'c3 - - . g2 - - . c3 - - . g2 - - .',
          'a2 - - . e3 - - . a2 - - . e3 - - .',
          'f2 - - . c3 - - . f2 - - . c3 - - .',
          'g2 - - . d3 - - . g2 - - . d3 - - .',
          'g2 - - . g2 - - . g2 - g2 - a2 - b2 -'
        ],
        chord: [
          'x...x.x.x...x.x.|e4 g4 c5', 'x...x.x.x...x.x.|f4 a4 c5', 'x...x.x.x...x.x.|d4 g4 b4', 'x...x.x.x...x.x.|e4 g4 c5',
          'x...x.x.x...x.x.|e4 a4 c5', 'x...x.x.x...x.x.|f4 a4 c5', 'x...x.x.x...x.x.|d4 g4 b4', 'x...x.x.x...x.x.|d4 f4 b4'
        ],
        lead: [
          'g4 - c5 - e5 - g5 - - - e5 - g5 - - -',
          'a5 - - - f5 - c5 - f5 - a5 - c6 - - -',
          'b5 - - - g5 - d5 - g5 - b5 - d6 - - -',
          'c6 - - - - - g5 - e5 - g5 - c6 - - .',
          'e5 - a5 - c6 - e6 - - - c6 - a5 - - -',
          'c6 - a5 - f5 - a5 - c6 - - - a5 - f5 -',
          'd6 - b5 - g5 - b5 - d6 - - - d6 - d6 -',
          'd6 - - - c6 - b5 - a5 - g5 - f5 - d5 -'
        ]
      }
    }
  }
};

const DRUM_PARTS = ['kick', 'snare', 'hat', 'ohat', 'rim', 'shaker', 'crash', 'tom'];
const NOTE_PARTS = ['bass', 'lead', 'arp'];
const songCache = {};
const songWarnings = [];

function compileSong(name) {
  if (songCache[name]) return songCache[name];
  const def = SONGS[name];
  const steps = [];
  const warn = function (msg) { songWarnings.push(name + ': ' + msg); };

  def.order.forEach(function (secName) {
    const sec = def.sections[secName];
    for (let b = 0; b < sec.bars; b++) {
      const base = steps.length;
      const where = secName + ' bar ' + (b + 1);
      let i;
      for (i = 0; i < 16; i++) steps.push([]);

      DRUM_PARTS.forEach(function (part) {
        const arr = sec[part];
        const str = arr ? arr[b % arr.length] : null;
        if (!str) return;
        if (str.length !== 16) warn(where + ' ' + part + ' has ' + str.length + ' steps');
        for (let s = 0; s < 16 && s < str.length; s++) {
          const ch = str.charAt(s);
          const vel = ch === 'x' ? 0.8 : (ch === 'X' ? 1 : (ch === 'o' ? 0.4 : 0));
          if (vel > 0) steps[base + s].push({ i: part, v: vel });
          else if (ch !== '.') warn(where + ' ' + part + ' bad char ' + ch);
        }
      });

      NOTE_PARTS.forEach(function (part) {
        const arr = sec[part];
        const str = arr ? arr[b % arr.length] : null;
        if (!str) return;
        const toks = str.trim().split(/\s+/);
        if (toks.length !== 16) warn(where + ' ' + part + ' has ' + toks.length + ' steps');
        let cur = null;
        for (let s = 0; s < 16 && s < toks.length; s++) {
          const tk = toks[s];
          if (tk === '-') { if (cur) cur.l++; continue; }
          cur = null;
          if (tk === '.') continue;
          const m = midi(tk);
          if (m < 0) { warn(where + ' ' + part + ' bad note ' + tk); continue; }
          cur = { i: part, n: m, l: 1 };
          steps[base + s].push(cur);
        }
      });

      const carr = sec.chord;
      const cstr = carr ? carr[b % carr.length] : null;
      if (cstr) {
        cstr.split('+').forEach(function (piece) {
          const halves = piece.split('|');
          const rh = (halves[0] || '').trim();
          const ns = (halves[1] || '').trim().split(/\s+/).map(midi);
          if (rh.length !== 16) warn(where + ' chord has ' + rh.length + ' steps');
          if (!ns.length || ns.some(function (m) { return m < 0; })) { warn(where + ' chord bad notes'); return; }
          for (let s = 0; s < 16 && s < rh.length; s++) {
            const ch = rh.charAt(s);
            const len = ch === 'x' ? 1 : (ch === 'l' ? 4 : (ch === 'w' ? 16 : 0));
            if (len) steps[base + s].push({ i: 'chord', ns: ns, l: len });
            else if (ch !== '.') warn(where + ' chord bad char ' + ch);
          }
        });
      }
    }
  });

  const song = {
    name: name,
    steps: steps,
    total: steps.length,
    sd: 60 / def.bpm / 4,
    swing: def.swing || 0,
    tr: def.transpose || 0,
    level: def.level || 1,
    inst: def.inst,
    mix: def.mix
  };
  songCache[name] = song;
  return song;
}

/* ======================================================================== */

export function createAudio(opts) {
  opts = opts || {};
  const win = (typeof window !== 'undefined') ? window : null;
  const Ctor = win ? (win.AudioContext || win.webkitAudioContext || null) : null;
  const injected = opts.context || null;

  let ctx = null;           // BaseAudioContext, created lazily (or injected)
  let offline = false;      // true for an OfflineAudioContext
  let broken = false;       // Web Audio unavailable: everything becomes a no-op
  let master = null;
  let comp = null;
  let sfxBus = null;
  let musicBus = null;
  let noise = null;         // { white, pink, brown } AudioBuffers
  let pulse = null;         // PeriodicWave for the quack source
  let hasPan = false;

  let paused = false;
  let disposed = false;
  const vol = { music: 1, sfx: 1 };

  const sfxVoices = [];     // live one-shot voices, oldest first
  const lastPlay = {};      // name -> context time of the last trigger
  const loops = {};         // key -> live loop
  const wantLoops = {};     // key -> { name, pan, vol } requested by the game

  let wantTrack = null;     // music the game asked for
  let cur = null;           // track instance currently playing
  const tracks = [];        // cur plus tracks that are still fading out
  let resumeStep = 0;       // where to pick the music up again after a pause
  let timer = null;
  let ticks = 0;
  const counters = { steps: 0, starts: 0, played: 0, dropped: 0, stolen: 0 };

  /* ---------------------------------------------------------------- setup */

  function makeNoise(kind) {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 2);
    const fade = 4096;
    const warm = 4096;
    const n = len + fade;
    const tmp = new Float32Array(n);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    let i, w, x;
    for (i = -warm; i < n; i++) {
      w = Math.random() * 2 - 1;
      if (kind === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        x = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
      } else if (kind === 'brown') {
        last = (last + 0.02 * w) / 1.02;
        x = last;
      } else {
        x = w;
      }
      if (i >= 0) tmp[i] = x;
    }
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (i = 0; i < len; i++) d[i] = tmp[i];
    if (kind !== 'white') {
      // Blend the tail into the head so the buffer loops without a click.
      for (i = 0; i < fade; i++) {
        w = i / fade;
        d[i] = tmp[i] * Math.sqrt(w) + tmp[len + i] * Math.sqrt(1 - w);
      }
    }
    let mean = 0, sum = 0;
    for (i = 0; i < len; i++) mean += d[i];
    mean /= len;
    for (i = 0; i < len; i++) { d[i] -= mean; sum += d[i] * d[i]; }
    const k = NOISE_RMS / Math.sqrt(sum / len || 1);
    for (i = 0; i < len; i++) d[i] *= k;
    return buf;
  }

  function makePulse() {
    if (typeof ctx.createPeriodicWave !== 'function') return null;
    const n = 40, duty = 0.1;
    const re = new Float32Array(n + 1), im = new Float32Array(n + 1);
    for (let k = 1; k <= n; k++) re[k] = Math.sin(Math.PI * k * duty) / k;
    return ctx.createPeriodicWave(re, im);
  }

  function setup(c) {
    ctx = c;
    offline = typeof c.startRendering === 'function';
    hasPan = typeof c.createStereoPanner === 'function';

    master = c.createGain();
    master.gain.value = paused ? 0 : MASTER_GAIN;
    sfxBus = c.createGain();
    sfxBus.gain.value = SFX_GAIN * vol.sfx;
    musicBus = c.createGain();
    musicBus.gain.value = MUSIC_GAIN * vol.music;
    sfxBus.connect(master);
    musicBus.connect(master);

    comp = (typeof c.createDynamicsCompressor === 'function') ? c.createDynamicsCompressor() : null;
    if (comp) {
      comp.threshold.value = -14;
      comp.knee.value = 10;
      comp.ratio.value = 14;
      comp.attack.value = 0.002;
      comp.release.value = 0.2;
      master.connect(comp);
      comp.connect(c.destination);
    } else {
      master.connect(c.destination);
    }

    noise = { white: makeNoise('white'), pink: makeNoise('pink'), brown: makeNoise('brown') };
    try { pulse = makePulse(); } catch (e) { pulse = null; }

    if (!offline) {
      try {
        if (typeof c.addEventListener === 'function') c.addEventListener('statechange', onState);
        else c.onstatechange = onState;
      } catch (e2) { /* ignore */ }
    }
  }

  // Makes sure a context exists. Returns false when Web Audio is unavailable.
  function ensure() {
    if (ctx) return true;
    if (broken || disposed) return false;
    try {
      if (injected) {
        setup(injected);
      } else {
        if (!Ctor) { broken = true; return false; }
        let c = null;
        try { c = new Ctor({ latencyHint: 'interactive' }); } catch (e) { c = new Ctor(); }
        setup(c);
      }
      return true;
    } catch (e3) {
      broken = true;
      ctx = null;
      return false;
    }
  }

  // True when sound scheduled right now would actually be heard.
  function live() {
    if (!ctx || paused || disposed) return false;
    if (offline) return ctx.state !== 'closed';
    return ctx.state === 'running' || ctx.state === undefined;
  }

  function onState() {
    try {
      if (!live()) return;
      syncMusic();
      syncLoops();
    } catch (e) { /* ignore */ }
  }

  /* --------------------------------------------------------------- voices */

  // A voice is a small bundle of nodes feeding one output gain. It frees
  // itself (disconnects everything) when its last source has ended.
  function newVoice(dest, t0, rate) {
    const out = ctx.createGain();
    out.connect(dest);
    return { out: out, t0: t0, rate: rate, nodes: [out], srcs: [], live: 0, end: t0, owner: null, pri: 0, dead: false };
  }

  function disconnectAll(nodes) {
    for (let i = 0; i < nodes.length; i++) {
      try { nodes[i].disconnect(); } catch (e) { /* ignore */ }
    }
    nodes.length = 0;
  }

  function freeVoice(V) {
    if (V.dead) return;
    V.dead = true;
    for (let i = 0; i < V.srcs.length; i++) V.srcs[i].onended = null;
    V.srcs.length = 0;
    disconnectAll(V.nodes);
    const tr = V.owner;
    if (tr) {
      tr.voices.delete(V);
      if (tr.dead && tr.voices.size === 0) disconnectAll(tr.nodes);
    } else {
      const idx = sfxVoices.indexOf(V);
      if (idx >= 0) sfxVoices.splice(idx, 1);
    }
  }

  function startSrc(V, src, t, stopAt, offset) {
    V.nodes.push(src);
    V.srcs.push(src);
    V.live++;
    if (stopAt > V.end) V.end = stopAt;
    src.onended = function () {
      V.live--;
      if (V.live <= 0) freeVoice(V);
    };
    if (offset !== undefined) src.start(t, offset); else src.start(t);
    src.stop(stopAt);
  }

  // Fast fade and stop. The voice frees itself once its sources have ended.
  function killVoice(V, when) {
    if (V.dead) return;
    try { V.out.gain.setTargetAtTime(0, when, 0.004); } catch (e) { /* ignore */ }
    const at = when + 0.03;
    for (let i = 0; i < V.srcs.length; i++) {
      try { V.srcs[i].stop(at); } catch (e2) { /* ignore */ }
    }
    if (at < V.end) V.end = at;
  }

  // Safety net in case an "ended" event got lost: free anything overdue.
  function sweep(now) {
    let i;
    for (i = sfxVoices.length - 1; i >= 0; i--) {
      if (sfxVoices[i].end + 0.3 < now) freeVoice(sfxVoices[i]);
    }
    for (i = 0; i < tracks.length; i++) {
      const stale = [];
      tracks[i].voices.forEach(function (V) { if (V.end + 0.3 < now) stale.push(V); });
      for (let k = 0; k < stale.length; k++) freeVoice(stale[k]);
    }
  }

  function node(V, n) { V.nodes.push(n); return n; }

  function biquad(V, type, freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = Math.min(freq, ctx.sampleRate * 0.45);
    f.Q.value = q;
    V.nodes.push(f);
    return f;
  }

  // Piecewise linear automation from [fraction, value] breakpoints.
  function line(param, pts, t, d, k) {
    param.setValueAtTime(pts[0][1] * k, t + pts[0][0] * d);
    for (let i = 1; i < pts.length; i++) param.linearRampToValueAtTime(pts[i][1] * k, t + pts[i][0] * d);
  }

  /*
   * E: envelope stage (optional filter -> gain with attack / hold / decay).
   *   t offset from voice start, d total length, a attack, h hold at peak,
   *   v peak level, lin linear decay (default exponential),
   *   c filter cutoff (ft type, c1 sweep target, ct sweep time, q), to dest.
   * Returns { in, t, d, end } where `in` is the node to feed.
   */
  function E(V, p) {
    const t = V.t0 + (p.t || 0);
    const a = p.a === undefined ? 0.003 : p.a;
    const h = p.h || 0;
    const d = Math.max(p.d, a + h + 0.01);
    const v = p.v === undefined ? 1 : p.v;
    const g = ctx.createGain();
    const gg = g.gain;
    let end = t + d;
    gg.setValueAtTime(0, t);
    gg.linearRampToValueAtTime(v, t + a);
    if (h > 0) gg.setValueAtTime(v, t + a + h);
    if (p.lin) {
      gg.linearRampToValueAtTime(0, end);
    } else {
      gg.exponentialRampToValueAtTime(v * 0.004 + 0.000001, end);
      end += 0.008;
      gg.linearRampToValueAtTime(0, end);
    }
    g.connect(p.to || V.out);
    V.nodes.push(g);
    let input = g;
    if (p.c) {
      const lim = ctx.sampleRate * 0.45;
      const f = ctx.createBiquadFilter();
      f.type = p.ft || 'lowpass';
      f.frequency.setValueAtTime(Math.min(p.c * V.rate, lim), t);
      if (p.c1) f.frequency.exponentialRampToValueAtTime(Math.min(p.c1 * V.rate, lim), t + (p.ct || d));
      f.Q.value = p.q === undefined ? (f.type === 'bandpass' ? 1 : 0) : p.q;
      f.connect(g);
      V.nodes.push(f);
      input = f;
    }
    return { in: input, t: t, d: d, end: end };
  }

  /*
   * O: oscillator into an envelope stage.
   *   w waveform (name or PeriodicWave), f frequency, f1 glide target,
   *   gt glide time, gl linear glide, det detune in cents, g level,
   *   vib [rate Hz, depth cents, delay s].
   */
  function O(V, p, e) {
    const o = ctx.createOscillator();
    const w = p.w || 'sine';
    const r = V.rate;
    const t = e.t;
    const stopAt = e.end + 0.01;
    if (typeof w === 'string') o.type = w; else o.setPeriodicWave(w);
    o.frequency.setValueAtTime(p.f * r, t);
    if (p.f1) {
      if (p.gl) o.frequency.linearRampToValueAtTime(p.f1 * r, t + (p.gt || e.d));
      else o.frequency.exponentialRampToValueAtTime(p.f1 * r, t + (p.gt || e.d));
    }
    if (p.det) o.detune.value = p.det;
    if (p.vib) {
      const lfo = ctx.createOscillator();
      const lg = node(V, ctx.createGain());
      lfo.frequency.value = p.vib[0];
      lg.gain.setValueAtTime(0, t + (p.vib[2] || 0));
      lg.gain.linearRampToValueAtTime(p.vib[1], t + (p.vib[2] || 0) + 0.08);
      lfo.connect(lg);
      lg.connect(o.detune);
      startSrc(V, lfo, t, stopAt);
    }
    if (p.g !== undefined && p.g !== 1) {
      const og = node(V, ctx.createGain());
      og.gain.value = p.g;
      o.connect(og);
      og.connect(e.in);
    } else {
      o.connect(e.in);
    }
    startSrc(V, o, t, stopAt);
    return o;
  }

  // T: one enveloped tone. N: one enveloped noise burst (n = white|pink|brown).
  function T(V, p) { return O(V, p, E(V, p)); }

  function N(V, p) {
    const e = E(V, p);
    const s = ctx.createBufferSource();
    s.buffer = noise[p.n || 'white'];
    s.loop = true;
    if (p.r) s.playbackRate.value = p.r;
    s.connect(e.in);
    startSrc(V, s, e.t, e.end + 0.01, Math.random() * 1.8);
    return e;
  }

  // Brass-like note for the fanfares: two detuned saws, opening lowpass.
  function brass(V, f, t, d, v) {
    const e = E(V, { t: t, d: d + 0.07, h: Math.max(d - 0.03, 0.01), a: 0.016, v: v, c: 900, c1: 3000, ct: 0.07, q: 1, lin: true });
    O(V, { w: 'sawtooth', f: f, det: -6 }, e);
    O(V, { w: 'sawtooth', f: f, det: 7, g: 0.8 }, e);
  }

  // Random on/off (or level) stutter on a gain: crackle for zap and sizzle.
  function stutter(V, lo, hi, d, minStep, maxStep) {
    const g = node(V, ctx.createGain());
    let t = V.t0;
    const end = V.t0 + d;
    while (t < end) {
      g.gain.setValueAtTime(lo + Math.random() * (hi - lo), t);
      t += minStep + Math.random() * (maxStep - minStep);
    }
    g.connect(V.out);
    return g;
  }

  /* ---------------------------------------------------------------- quack */

  function buildQuack(V, q, off, dscale) {
    const t = V.t0 + (off || 0);
    const r = V.rate;
    const d = q.d * (dscale || 1);
    const fs = Math.pow(r, 0.4);          // a smaller duck has a smaller bill
    const end = t + d + 0.03;

    const src = ctx.createOscillator();
    const sub = ctx.createOscillator();
    if (pulse && typeof src.setPeriodicWave === 'function') {
      src.setPeriodicWave(pulse);
      sub.setPeriodicWave(pulse);
    } else {
      src.type = 'sawtooth';
      sub.type = 'sawtooth';
    }
    line(src.frequency, q.pit, t, d, q.f0 * r);
    line(sub.frequency, q.pit, t, d, q.f0 * r * 0.5);   // octave below: the growl
    const sg = node(V, ctx.createGain());
    line(sg.gain, q.sub, t, d, 1);
    sub.connect(sg);

    // Hoarseness: slow random pitch wobble shared by both oscillators.
    const jn = ctx.createBufferSource();
    jn.buffer = noise.brown;
    jn.loop = true;
    const jg = node(V, ctx.createGain());
    jg.gain.value = q.jit * 2;
    jn.connect(jg);
    jg.connect(src.detune);
    jg.connect(sub.detune);

    // Rasp: amplitude modulation that slows down as the pitch falls.
    const am = node(V, ctx.createGain());
    am.gain.value = 1 - q.rd;
    const lfo = ctx.createOscillator();
    lfo.frequency.setValueAtTime(q.rr * r, t);
    lfo.frequency.linearRampToValueAtTime(q.rr1 * r, t + d);
    const lg = node(V, ctx.createGain());
    lg.gain.value = q.rd;
    lfo.connect(lg);
    lg.connect(am.gain);
    src.connect(am);
    sg.connect(am);

    // Output: formants -> highpass -> lowpass (takes the fizz off) -> envelope.
    const env = node(V, ctx.createGain());
    line(env.gain, q.amp, t, d, q.g);
    const hp = biquad(V, 'highpass', 240 * fs, 0);
    const lp = biquad(V, 'lowpass', 5200, 0);
    hp.connect(lp);
    lp.connect(env);
    env.connect(V.out);

    const f1 = biquad(V, 'bandpass', 1000, q.q1);
    line(f1.frequency, q.F1, t, d, fs);
    const f2 = biquad(V, 'bandpass', 2000, q.q2);
    line(f2.frequency, q.F2, t, d, fs);
    const f3 = biquad(V, 'bandpass', q.F3 * fs, 9);
    const body = biquad(V, 'lowpass', 800 * fs, 0);
    const g1 = node(V, ctx.createGain()); g1.gain.value = 1.0;
    const g2 = node(V, ctx.createGain()); g2.gain.value = 0.8;
    const g3 = node(V, ctx.createGain()); g3.gain.value = 0.35;
    const gb = node(V, ctx.createGain()); gb.gain.value = 0.12;
    am.connect(f1); f1.connect(g1); g1.connect(hp);
    am.connect(f2); f2.connect(g2); g2.connect(hp);
    am.connect(f3); f3.connect(g3); g3.connect(hp);
    am.connect(body); body.connect(gb); gb.connect(hp);

    // A little breath through the same bill.
    const ns = ctx.createBufferSource();
    ns.buffer = noise.pink;
    ns.loop = true;
    const ng = node(V, ctx.createGain());
    ng.gain.value = q.breath;
    ns.connect(ng);
    ng.connect(f1);
    ng.connect(f2);

    startSrc(V, src, t, end);
    startSrc(V, sub, t, end);
    startSrc(V, lfo, t, end);
    startSrc(V, ns, t, end, Math.random() * 1.5);
    startSrc(V, jn, t, end, Math.random() * 1.5);
  }

  /* ------------------------------------------------------------ sfx bank */

  const build = {
    /* weapons */
    pea: function (V) {
      T(V, { w: 'triangle', f: 1250, f1: 420, d: 0.12, v: 0.8 });
      T(V, { f: 520, f1: 170, d: 0.04, v: 0.7 });
      N(V, { ft: 'highpass', c: 4000, d: 0.014, a: 0.001, v: 0.25 });
    },
    shotgun: function (V) {
      N(V, { c: 7000, c1: 1000, d: 0.28, a: 0.001, v: 1 });
      N(V, { n: 'pink', ft: 'bandpass', c: 1100, q: 0.6, d: 0.32, a: 0.001, v: 1 });
      N(V, { n: 'brown', c: 700, c1: 200, d: 0.45, a: 0.002, v: 0.7 });
      T(V, { f: 190, f1: 55, gt: 0.1, d: 0.2, a: 0.001, v: 0.6 });
      N(V, { ft: 'highpass', c: 4000, d: 0.03, a: 0.0005, v: 0.6 });
    },
    smg: function (V) {
      N(V, { ft: 'bandpass', c: 2300, q: 0.7, d: 0.08, a: 0.0005, v: 1 });
      N(V, { n: 'pink', c: 1200, d: 0.05, a: 0.0005, v: 0.6 });
      T(V, { w: 'square', f: 220, f1: 100, d: 0.05, v: 0.3, c: 1400 });
      T(V, { w: 'triangle', f: 1000, f1: 350, d: 0.03, v: 0.3 });
    },
    rocket: function (V) {
      N(V, { n: 'pink', ft: 'bandpass', c: 500, c1: 3200, q: 1, d: 0.55, a: 0.06, v: 1 });
      N(V, { ft: 'bandpass', c: 2500, c1: 6000, q: 1, d: 0.35, a: 0.04, v: 0.25 });
      N(V, { n: 'brown', c: 700, d: 0.4, a: 0.01, v: 0.6 });
      T(V, { w: 'sawtooth', f: 90, f1: 170, d: 0.4, a: 0.02, v: 0.3, c: 900 });
      T(V, { f: 260, f1: 100, d: 0.1, v: 0.5 });
    },
    torpedo: function (V) {
      T(V, { f: 180, f1: 560, gt: 0.09, d: 0.2, a: 0.006, v: 0.9 });
      T(V, { t: 0.11, f: 420, f1: 900, gt: 0.05, d: 0.1, a: 0.005, v: 0.4 });
      T(V, { t: 0.19, f: 600, f1: 1300, gt: 0.04, d: 0.08, a: 0.005, v: 0.25 });
      N(V, { n: 'brown', c: 700, c1: 250, d: 0.4, a: 0.02, v: 0.7 });
      N(V, { n: 'pink', t: 0.02, ft: 'bandpass', c: 1800, q: 1.5, d: 0.2, a: 0.02, v: 0.15 });
    },
    sniper: function (V) {
      N(V, { ft: 'highpass', c: 2200, d: 0.05, a: 0.0005, v: 1 });
      N(V, { ft: 'bandpass', c: 1500, q: 0.6, d: 0.09, a: 0.0005, v: 0.8 });
      T(V, { f: 2600, f1: 300, gt: 0.05, d: 0.07, v: 0.4 });
      N(V, { n: 'pink', ft: 'bandpass', c: 1400, c1: 600, q: 0.7, d: 0.75, a: 0.005, v: 0.5 });
      N(V, { n: 'brown', c: 500, d: 0.3, v: 0.4 });
      N(V, { t: 0.13, ft: 'bandpass', c: 1800, q: 1, d: 0.09, v: 0.15 });
    },
    zap: function (V) {
      const d = 0.3;
      const e = E(V, { d: d, a: 0.002, h: 0.12, v: 0.6, ft: 'bandpass', c: 1600, q: 0.4 });
      const o = O(V, { w: 'sawtooth', f: 900 }, e);
      O(V, { w: 'square', f: 110, g: 0.5 }, e);
      let t = e.t;
      while (t < e.t + d) {
        o.frequency.setValueAtTime((300 + Math.random() * 2400) * V.rate, t);
        t += 0.008 + Math.random() * 0.02;
      }
      const gate = stutter(V, 0, 1, d, 0.008, 0.03);
      N(V, { n: 'pink', ft: 'highpass', c: 2500, d: d, a: 0.001, h: 0.1, v: 0.6, to: gate });
      T(V, { f: 2400, f1: 600, d: 0.08, v: 0.2 });
    },
    wave: function (V) {
      const e = E(V, { d: 0.85, h: 0.35, a: 0.07, v: 0.55, c: 800, q: 1 });
      O(V, { w: 'sawtooth', f: 104, f1: 110, gt: 0.15 }, e);
      O(V, { w: 'sawtooth', f: 104, f1: 110, gt: 0.15, det: 12, g: 0.8 }, e);
      O(V, { w: 'square', f: 208, f1: 220, gt: 0.15, g: 0.25 }, e);
      N(V, { n: 'pink', ft: 'bandpass', c: 350, c1: 1700, q: 0.9, t: 0.1, d: 0.9, a: 0.25, v: 1 });
      N(V, { n: 'pink', ft: 'highpass', c: 3000, t: 0.3, d: 0.7, a: 0.2, v: 0.3 });
    },
    stone: function (V) {
      N(V, { ft: 'bandpass', c: 3000, c1: 5000, q: 2, d: 0.05, a: 0.012, v: 0.6 });
      T(V, { w: 'triangle', f: 1900, f1: 1300, d: 0.035, v: 0.7 });
      T(V, { t: 0.05, f: 900, f1: 1500, gt: 0.025, d: 0.04, v: 0.4 });
      T(V, { t: 0.1, f: 1100, f1: 1900, gt: 0.02, d: 0.035, v: 0.25 });
    },
    egg: function (V) {
      T(V, { f: 330, f1: 150, d: 0.15, v: 1 });
      T(V, { w: 'triangle', f: 660, f1: 300, d: 0.06, v: 0.3 });
      N(V, { n: 'pink', ft: 'bandpass', c: 450, q: 4, d: 0.09, v: 1 });
      N(V, { n: 'pink', ft: 'bandpass', c: 1200, q: 1, d: 0.03, a: 0.001, v: 0.4 });
      T(V, { t: 0.02, f: 500, f1: 900, d: 0.06, a: 0.01, v: 0.15 });
    },
    mine_drop: function (V) {
      T(V, { f: 420, f1: 140, gt: 0.05, d: 0.07, v: 0.9 });
      T(V, { t: 0.05, f: 260, f1: 820, gt: 0.07, d: 0.12, a: 0.008, v: 0.8 });
      N(V, { n: 'pink', t: 0.04, ft: 'bandpass', c: 2200, q: 1, d: 0.12, a: 0.01, v: 0.3 });
    },
    mine_beep: function (V) {
      T(V, { w: 'square', f: 1568, d: 0.07, h: 0.04, a: 0.002, v: 0.3, c: 5000, lin: true });
      T(V, { f: 1568, d: 0.07, h: 0.04, a: 0.002, v: 0.5, lin: true });
      T(V, { w: 'square', t: 0.1, f: 2093, d: 0.09, h: 0.05, a: 0.002, v: 0.3, c: 6000, lin: true });
      T(V, { t: 0.1, f: 2093, d: 0.09, h: 0.05, a: 0.002, v: 0.5, lin: true });
    },
    empty: function (V) {
      N(V, { ft: 'highpass', c: 2500, d: 0.012, a: 0.0005, v: 0.9 });
      T(V, { w: 'triangle', f: 1100, f1: 700, d: 0.02, v: 0.5 });
      N(V, { t: 0.045, ft: 'bandpass', c: 1500, q: 2, d: 0.016, a: 0.0005, v: 0.6 });
      T(V, { w: 'triangle', t: 0.045, f: 600, f1: 450, d: 0.02, v: 0.3 });
    },

    /* impacts */
    explosion: function (V) {
      T(V, { f: 160, f1: 42, gt: 0.25, d: 0.5, a: 0.002, v: 0.8 });
      N(V, { n: 'pink', c: 1800, c1: 220, d: 0.75, a: 0.002, v: 1 });
      N(V, { n: 'brown', c: 900, c1: 150, d: 0.8, a: 0.002, v: 0.7 });
      N(V, { ft: 'bandpass', c: 2200, c1: 800, q: 0.5, d: 0.28, a: 0.001, v: 0.8 });
      N(V, { n: 'pink', ft: 'highpass', c: 2500, t: 0.06, d: 0.85, a: 0.1, v: 0.45 });
      N(V, { n: 'pink', ft: 'bandpass', c: 1200, q: 0.8, t: 0.15, d: 0.7, a: 0.15, v: 0.4 });
      for (let i = 0; i < 3; i++) {
        const f = 700 + Math.random() * 900;
        T(V, { t: 0.3 + i * 0.13 + Math.random() * 0.08, f: f, f1: f * 1.7, gt: 0.03, d: 0.045, a: 0.004, v: 0.1 });
      }
    },
    explosion_big: function (V) {
      T(V, { f: 130, f1: 34, gt: 0.4, d: 0.9, a: 0.002, v: 0.8 });
      T(V, { t: 0.12, f: 100, f1: 36, d: 0.5, v: 0.5 });
      N(V, { n: 'pink', c: 2000, c1: 180, d: 1.2, a: 0.002, v: 1 });
      N(V, { n: 'brown', c: 1000, c1: 120, d: 1.3, a: 0.002, v: 0.8 });
      N(V, { ft: 'bandpass', c: 2600, c1: 700, q: 0.5, d: 0.42, a: 0.001, v: 0.8 });
      N(V, { n: 'pink', ft: 'highpass', c: 2400, t: 0.08, d: 1.5, a: 0.18, v: 0.5 });
      N(V, { n: 'pink', ft: 'bandpass', c: 1000, q: 0.7, t: 0.2, d: 1.3, a: 0.25, v: 0.5 });
      for (let i = 0; i < 6; i++) {
        const f = 600 + Math.random() * 1000;
        T(V, { t: 0.5 + i * 0.14 + Math.random() * 0.1, f: f, f1: f * 1.7, gt: 0.03, d: 0.045, a: 0.004, v: 0.1 });
      }
    },
    hit: function (V) {
      N(V, { n: 'pink', ft: 'bandpass', c: 1400, q: 1, d: 0.07, a: 0.001, v: 1 });
      N(V, { ft: 'bandpass', c: 3000, q: 1, d: 0.02, a: 0.0005, v: 0.4 });
      T(V, { f: 380, f1: 140, d: 0.09, v: 0.7 });
      T(V, { t: 0.01, f: 1500, f1: 2100, d: 0.05, a: 0.008, v: 0.14 });
    },
    shield_hit: function (V) {
      T(V, { f: 1320, d: 0.3, v: 0.6, vib: [27, 30, 0] });
      T(V, { f: 1980, d: 0.18, v: 0.25 });
      T(V, { f: 500, f1: 1100, gt: 0.04, d: 0.06, v: 0.5 });
      T(V, { f: 2640, f1: 2500, d: 0.1, v: 0.1 });
    },
    shield_pop: function (V) {
      T(V, { f: 380, f1: 1900, gt: 0.05, d: 0.07, a: 0.004, v: 0.9, lin: true });
      N(V, { n: 'pink', t: 0.045, ft: 'highpass', c: 1500, d: 0.05, a: 0.0005, v: 0.7 });
      T(V, { t: 0.045, f: 240, f1: 90, d: 0.08, v: 0.5 });
      T(V, { t: 0.08, f: 2200, d: 0.09, v: 0.2 });
      T(V, { t: 0.13, f: 1800, d: 0.09, v: 0.15 });
      T(V, { t: 0.18, f: 1500, d: 0.09, v: 0.1 });
    },
    bounce: function (V) {
      T(V, { w: 'triangle', f: 2100, f1: 2900, d: 0.03, v: 0.7 });
      T(V, { t: 0.01, f: 3200, f1: 1700, d: 0.12, v: 0.3 });
      N(V, { ft: 'highpass', c: 5000, d: 0.008, a: 0.0005, v: 0.3 });
    },
    burn: function (V) {
      const gate = stutter(V, 0.15, 1, 0.3, 0.012, 0.04);
      N(V, { n: 'pink', ft: 'highpass', c: 3000, d: 0.3, a: 0.02, v: 1, to: gate });
      N(V, { ft: 'bandpass', c: 2500, q: 1.5, d: 0.22, a: 0.01, v: 0.6 });
    },
    nibble: function (V) {
      N(V, { n: 'pink', c: 2500, d: 0.035, a: 0.001, v: 1 });
      N(V, { ft: 'bandpass', c: 2500, q: 1.2, d: 0.015, a: 0.0005, v: 0.5 });
      T(V, { w: 'square', f: 240, f1: 130, d: 0.04, v: 0.35, c: 1000 });
      N(V, { n: 'pink', t: 0.07, c: 2000, d: 0.045, a: 0.001, v: 1 });
      N(V, { t: 0.07, ft: 'bandpass', c: 2200, q: 1.2, d: 0.018, a: 0.0005, v: 0.6 });
      T(V, { w: 'square', t: 0.07, f: 190, f1: 95, d: 0.06, v: 0.4, c: 900 });
      T(V, { t: 0.07, f: 900, f1: 400, d: 0.03, v: 0.2 });
    },

    /* water */
    splash_small: function (V) {
      N(V, { n: 'pink', ft: 'bandpass', c: 2800, c1: 1400, q: 0.8, d: 0.22, a: 0.004, v: 1 });
      N(V, { n: 'pink', c: 900, d: 0.12, a: 0.003, v: 0.5 });
      T(V, { t: 0.03, f: 650, f1: 1300, gt: 0.04, d: 0.06, a: 0.005, v: 0.3 });
    },
    splash_big: function (V) {
      N(V, { n: 'pink', c: 3000, c1: 500, d: 0.7, a: 0.006, v: 1 });
      N(V, { n: 'pink', ft: 'highpass', c: 2500, t: 0.03, d: 0.6, a: 0.07, v: 0.4 });
      T(V, { f: 150, f1: 60, d: 0.25, v: 0.6 });
      N(V, { n: 'brown', c: 500, d: 0.4, a: 0.004, v: 0.6 });
      T(V, { t: 0.3, f: 700, f1: 1300, gt: 0.03, d: 0.05, a: 0.005, v: 0.12 });
      T(V, { t: 0.42, f: 900, f1: 1600, gt: 0.03, d: 0.05, a: 0.005, v: 0.1 });
    },
    dive: function (V) {
      T(V, { f: 620, f1: 120, gt: 0.2, d: 0.26, a: 0.01, v: 0.9, vib: [34, 70, 0.03] });
      T(V, { t: 0.02, f: 900, f1: 300, d: 0.1, a: 0.006, v: 0.25 });
      N(V, { n: 'brown', c: 900, c1: 200, d: 0.3, a: 0.02, v: 0.6 });
      N(V, { n: 'pink', ft: 'bandpass', c: 2000, q: 1, d: 0.08, v: 0.25 });
    },
    surface: function (V) {
      T(V, { f: 140, f1: 720, gt: 0.16, d: 0.2, a: 0.01, v: 0.9, lin: true });
      T(V, { t: 0.1, f: 300, f1: 1100, gt: 0.06, d: 0.08, a: 0.005, v: 0.3 });
      N(V, { n: 'pink', t: 0.13, ft: 'bandpass', c: 2600, c1: 1500, q: 0.8, d: 0.3, a: 0.01, v: 0.9 });
      N(V, { n: 'pink', t: 0.13, c: 1000, d: 0.18, a: 0.004, v: 0.35 });
    },

    /* pickups */
    pickup_weapon: function (V) {
      N(V, { ft: 'bandpass', c: 1600, q: 2, d: 0.025, a: 0.0005, v: 1 });
      T(V, { w: 'square', f: 320, f1: 200, d: 0.03, v: 0.4, c: 1500 });
      N(V, { t: 0.075, ft: 'highpass', c: 3000, d: 0.04, a: 0.001, v: 0.6 });
      T(V, { w: 'triangle', t: 0.075, f: 900, f1: 600, d: 0.02, v: 0.3 });
      T(V, { w: 'square', t: 0.14, f: D5, d: 0.07, h: 0.04, v: 0.28, c: 3500, lin: true });
      T(V, { w: 'square', t: 0.2, f: A5, d: 0.07, h: 0.04, v: 0.28, c: 3500, lin: true });
      T(V, { w: 'square', t: 0.26, f: D6, d: 0.16, h: 0.05, v: 0.3, c: 4000 });
      T(V, { t: 0.26, f: D6, d: 0.2, v: 0.3 });
    },
    pickup_bread: function (V) {
      N(V, { n: 'pink', c: 900, q: 1, d: 0.06, a: 0.008, v: 0.8 });
      N(V, { n: 'pink', t: 0.08, c: 700, q: 1, d: 0.07, a: 0.008, v: 0.7 });
      T(V, { w: 'triangle', t: 0.13, f: A5, d: 0.14, v: 0.4 });
      T(V, { t: 0.13, f: A5, d: 0.14, v: 0.35 });
      T(V, { w: 'triangle', t: 0.22, f: D6, d: 0.26, v: 0.45 });
      T(V, { t: 0.22, f: D6, d: 0.3, v: 0.4 });
    },
    pickup_power: function (V) {
      const ns = [D5, A5, D6, E6, A6, D7];
      for (let i = 0; i < ns.length; i++) {
        T(V, { t: i * 0.045, f: ns[i], d: 0.36, v: 0.36 - i * 0.03, vib: [9, 12, 0.05] });
        T(V, { w: 'triangle', t: i * 0.045, f: ns[i] * 2, d: 0.1, v: 0.07 });
      }
      N(V, { n: 'pink', ft: 'highpass', c: 6000, d: 0.55, a: 0.15, v: 0.15 });
    },
    crate_land: function (V) {
      T(V, { f: 190, f1: 110, d: 0.12, v: 0.9 });
      T(V, { w: 'triangle', f: 440, f1: 380, d: 0.07, v: 0.5 });
      N(V, { n: 'pink', ft: 'bandpass', c: 700, q: 3, d: 0.06, a: 0.001, v: 1 });
      N(V, { n: 'pink', t: 0.03, ft: 'bandpass', c: 2400, c1: 1200, q: 0.7, d: 0.4, a: 0.015, v: 0.7 });
      N(V, { n: 'pink', t: 0.03, c: 800, d: 0.3, a: 0.01, v: 0.4 });
    },

    /* ducks */
    death: function (V) {
      buildQuack(V, DEATH_QUACK, 0, 1);
      T(V, { f: 2300, f1: 650, d: 0.56, a: 0.02, h: 0.2, v: 0.07, vib: [15, 90, 0] });
      const p = 0.65;
      T(V, { t: p, f: 760, f1: 210, d: 0.07, a: 0.001, v: 0.45 });
      N(V, { n: 'pink', t: p, ft: 'highpass', c: 1400, d: 0.035, a: 0.0005, v: 0.4 });
      T(V, { t: p + 0.09, f: 520, f1: 1150, gt: 0.05, d: 0.07, a: 0.005, v: 0.16 });
      T(V, { t: p + 0.17, f: 700, f1: 1500, gt: 0.04, d: 0.06, a: 0.005, v: 0.1 });
    },
    respawn: function (V) {
      T(V, { f: 280, f1: 880, gt: 0.28, d: 0.42, a: 0.05, v: 0.6 });
      T(V, { w: 'triangle', f: 560, f1: 1760, gt: 0.28, d: 0.32, a: 0.06, v: 0.12 });
      N(V, { n: 'pink', ft: 'bandpass', c: 1200, c1: 4000, q: 2, d: 0.3, a: 0.1, v: 0.2 });
      T(V, { t: 0.27, f: A6, d: 0.22, v: 0.15 });
    },

    /* flow */
    countdown: function (V) {
      T(V, { w: 'square', f: D5, d: 0.17, h: 0.1, a: 0.003, v: 0.28, c: 3000, lin: true });
      T(V, { f: D5, d: 0.17, h: 0.1, a: 0.003, v: 0.5, lin: true });
    },
    go: function (V) {
      const e = E(V, { d: 0.72, h: 0.5, a: 0.012, v: 0.5, c: 2600, q: 1, lin: true });
      O(V, { w: 'sawtooth', f: 409, f1: A4, gt: 0.07 }, e);
      O(V, { w: 'sawtooth', f: 546, f1: D5, gt: 0.07, det: 8, g: 0.9 }, e);
      O(V, { w: 'square', f: 205, f1: 220, gt: 0.07, g: 0.4 }, e);
      O(V, { w: 'sawtooth', f: 818, f1: A5, gt: 0.07, det: -6, g: 0.3 }, e);
      N(V, { ft: 'bandpass', c: 1800, q: 0.8, d: 0.12, v: 0.2 });
    },
    round_win: function (V) {
      brass(V, A4, 0, 0.09, 0.5);
      brass(V, D5, 0.1, 0.09, 0.5);
      brass(V, FS5, 0.2, 0.09, 0.5);
      brass(V, A5, 0.3, 0.2, 0.55);
      brass(V, FS5, 0.54, 0.08, 0.45);
      brass(V, D5, 0.66, 0.5, 0.26);
      brass(V, FS5, 0.66, 0.5, 0.26);
      brass(V, A5, 0.66, 0.5, 0.26);
      brass(V, D6, 0.66, 0.5, 0.36);
      T(V, { f: 147, f1: 73, d: 0.2, v: 0.6 });
      T(V, { t: 0.66, f: 147, f1: 73, d: 0.3, v: 0.7 });
      N(V, { n: 'pink', t: 0.66, ft: 'highpass', c: 5000, d: 0.55, v: 0.2 });
    },
    match_win: function (V) {
      let i;
      brass(V, D4, 0, 0.11, 0.35);
      brass(V, A4, 0, 0.11, 0.42);
      brass(V, D5, 0.13, 0.11, 0.5);
      brass(V, FS5, 0.26, 0.11, 0.5);
      brass(V, A5, 0.39, 0.34, 0.5);
      brass(V, FS5, 0.39, 0.34, 0.28);
      brass(V, G5, 0.8, 0.14, 0.36);
      brass(V, B5, 0.8, 0.14, 0.42);
      brass(V, G5, 0.98, 0.14, 0.36);
      brass(V, B5, 0.98, 0.14, 0.42);
      brass(V, A5, 1.16, 0.14, 0.36);
      brass(V, CS6, 1.16, 0.14, 0.42);
      brass(V, A5, 1.34, 0.2, 0.3);
      brass(V, CS6, 1.34, 0.2, 0.34);
      brass(V, E6, 1.34, 0.2, 0.4);
      brass(V, D5, 1.6, 0.85, 0.26);
      brass(V, FS5, 1.6, 0.85, 0.26);
      brass(V, A5, 1.6, 0.85, 0.26);
      brass(V, D6, 1.6, 0.85, 0.38);
      const bass = [[D3, 0, 0.7], [G2, 0.8, 0.32], [A2, 1.16, 0.4], [D3, 1.6, 0.85]];
      for (i = 0; i < bass.length; i++) {
        T(V, { w: 'sawtooth', t: bass[i][1], f: bass[i][0], d: bass[i][2] + 0.05, h: bass[i][2] - 0.06, a: 0.01, v: 0.4, c: 600, lin: true });
      }
      T(V, { f: 150, f1: 73, d: 0.3, v: 0.7 });
      T(V, { t: 0.8, f: 130, f1: 98, d: 0.25, v: 0.6 });
      for (i = 0; i < 8; i++) N(V, { t: 1.16 + i * 0.055, ft: 'highpass', c: 1800, d: 0.05, a: 0.001, v: 0.12 + i * 0.03 });
      T(V, { t: 1.6, f: 150, f1: 73, d: 0.45, v: 0.9 });
      N(V, { n: 'pink', t: 1.6, ft: 'highpass', c: 4500, d: 0.9, v: 0.25 });
      const glit = [D6, FS6, A6, D7];
      for (i = 0; i < glit.length; i++) T(V, { t: 1.66 + i * 0.07, f: glit[i], d: 0.32, v: 0.1 });
    },
    sudden: function (V) {
      for (let i = 0; i < 6; i++) {
        T(V, { w: 'square', t: i * 0.085, f: (i & 1) ? BB5 : A5, d: 0.08, h: 0.05, a: 0.003, v: 0.3, c: 3200, lin: true });
      }
      T(V, { w: 'sawtooth', f: 73.42, d: 0.95, h: 0.3, a: 0.004, v: 0.6, c: 520, q: 2 });
      T(V, { w: 'sawtooth', f: 146.83, det: 12, d: 0.8, h: 0.2, a: 0.004, v: 0.3, c: 800 });
      T(V, { f: 120, f1: 50, d: 0.3, v: 0.8 });
      N(V, { n: 'pink', ft: 'highpass', c: 3500, d: 0.6, v: 0.2 });
      T(V, { w: 'square', t: 0.51, f: BB5, f1: A4, gt: 0.4, d: 0.45, h: 0.1, a: 0.005, v: 0.2, c: 2600 });
    },
    bread_tick: function (V) {
      T(V, { f: D7, d: 0.07, a: 0.001, v: 0.5 });
      T(V, { t: 0.012, f: A7, d: 0.06, a: 0.001, v: 0.25 });
      T(V, { w: 'triangle', f: D6, d: 0.02, a: 0.001, v: 0.25 });
    },
    join: function (V) {
      const ns = [D5, A5, D6];
      for (let i = 0; i < 3; i++) {
        const last = i === 2;
        T(V, { w: 'triangle', t: i * 0.08, f: ns[i], d: last ? 0.22 : 0.09, h: last ? 0.03 : 0.05, v: 0.5, lin: !last });
        T(V, { t: i * 0.08, f: ns[i] * 2, d: last ? 0.16 : 0.06, v: 0.12 });
      }
    },
    leave: function (V) {
      T(V, { w: 'triangle', f: A5, d: 0.1, h: 0.05, v: 0.45, lin: true });
      T(V, { w: 'triangle', t: 0.09, f: D5, f1: D5 * 0.9, gt: 0.2, d: 0.22, h: 0.03, v: 0.45 });
      T(V, { t: 0.09, f: D5 * 2, f1: D5 * 1.8, gt: 0.2, d: 0.1, v: 0.08 });
    },
    ui_move: function (V) {
      T(V, { w: 'triangle', f: D6, f1: D6 * 0.93, d: 0.04, a: 0.001, v: 0.5 });
      N(V, { ft: 'highpass', c: 6000, d: 0.008, a: 0.0005, v: 0.1 });
    },
    ui_select: function (V) {
      T(V, { w: 'square', f: A5, d: 0.055, h: 0.03, v: 0.22, c: 3000, lin: true });
      T(V, { f: A5, d: 0.055, h: 0.03, v: 0.4, lin: true });
      T(V, { w: 'square', t: 0.06, f: E6, d: 0.12, h: 0.02, v: 0.22, c: 3500 });
      T(V, { t: 0.06, f: E6, d: 0.14, h: 0.02, v: 0.4 });
    }
  };

  /* ----------------------------------------------------------- one-shots */

  // Voice cap. Returns false when the new sound has to be dropped.
  function reserve(pri, now) {
    if (sfxVoices.length < MAX_VOICES) return true;
    sweep(now);
    if (sfxVoices.length < MAX_VOICES) return true;
    let idx = -1, best = pri + 1;
    for (let i = 0; i < sfxVoices.length; i++) {
      if (sfxVoices[i].pri < best) { best = sfxVoices[i].pri; idx = i; }
    }
    if (idx < 0) return false;
    const victim = sfxVoices[idx];
    sfxVoices.splice(idx, 1);
    killVoice(victim, now);
    counters.stolen++;
    return true;
  }

  function sfxVoice(now, rate, level, pan, pri) {
    let dest = sfxBus;
    let pn = null;
    const p = clamp(num(pan, 0), -1, 1);
    if (hasPan && p !== 0) {
      pn = ctx.createStereoPanner();
      pn.pan.value = p;
      pn.connect(sfxBus);
      dest = pn;
    }
    const V = newVoice(dest, now + 0.004, rate);
    if (pn) V.nodes.push(pn);
    V.out.gain.value = level;
    V.pri = pri;
    sfxVoices.push(V);
    return V;
  }

  function trigger(name, meta, o, builder) {
    if (!ensure() || !live()) return;
    const now = ctx.currentTime;
    const last = lastPlay[name];
    if (last !== undefined && now >= last && now - last < meta[1]) { counters.dropped++; return; }
    o = o || {};
    const level = meta[0] * clamp(num(o.vol, 1), 0, 1) * (meta[2] ? 0.88 + Math.random() * 0.12 : 1);
    if (!(level > 0)) return;
    if (!reserve(meta[3], now)) { counters.dropped++; return; }
    lastPlay[name] = now;
    const base = clamp(num(name === 'quack' ? o.pitch : o.rate, 1), 0.25, 4);
    const rate = base * (1 + (Math.random() * 2 - 1) * meta[2]);
    const V = sfxVoice(now, rate, level, o.pan, meta[3]);
    try {
      builder(V);
    } catch (e) {
      killVoice(V, now);
      if (V.live <= 0) freeVoice(V);
      return;
    }
    if (V.live <= 0) freeVoice(V);
    counters.played++;
  }

  function play(name, o) {
    try {
      if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(SFX, name)) return;
      trigger(name, SFX[name], o, build[name]);
    } catch (e) { /* never throw */ }
  }

  const QUACK_META = [QUACK_GAIN, 0.02, 0.025, 1];

  function quack(o) {
    try {
      trigger('quack', QUACK_META, o, function (V) {
        const big = Math.pow(V.rate, -0.35);     // bigger ducks quack a little longer
        const scale = big * (0.94 + Math.random() * 0.12);
        buildQuack(V, QUACK, 0, scale);
        // the "k" at both ends of kwa-ack
        N(V, { ft: 'bandpass', c: 2600, q: 1.2, d: 0.02, a: 0.001, v: 0.07 });
        N(V, { t: QUACK.d * scale * 0.94, ft: 'bandpass', c: 2200, q: 1.5, d: 0.025, a: 0.001, v: 0.05 });
      });
    } catch (e) { /* never throw */ }
  }

  /* ---------------------------------------------------------------- loops */

  function loopNoise(L, kind, type, freq, q, gain, dest) {
    const s = ctx.createBufferSource();
    s.buffer = noise[kind];
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    s.connect(f);
    f.connect(g);
    g.connect(dest);
    L.nodes.push(s, f, g);
    L.srcs.push(s);
    s.start(L.t0, Math.random() * 1.8);
    return f;
  }

  function loopLfo(L, freq, depth, param) {
    const o = ctx.createOscillator();
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = depth;
    o.connect(g);
    g.connect(param);
    L.nodes.push(o, g);
    L.srcs.push(o);
    o.start(L.t0);
  }

  function startLoop(key, w) {
    if (Object.keys(loops).length >= MAX_LOOPS) return;
    const now = ctx.currentTime;
    const L = { name: w.name, nodes: [], srcs: [], t0: now, env: null, out: null, pan: null, rel: 0.2, curPan: w.pan, curVol: w.vol, live: 0 };
    const out = ctx.createGain();
    out.gain.value = LOOP_GAIN[w.name] * w.vol;
    const env = ctx.createGain();
    const flut = ctx.createGain();
    flut.connect(env);
    env.connect(out);
    if (hasPan) {
      L.pan = ctx.createStereoPanner();
      L.pan.pan.value = w.pan;
      out.connect(L.pan);
      L.pan.connect(sfxBus);
      L.nodes.push(L.pan);
    } else {
      out.connect(sfxBus);
    }
    L.nodes.push(out, env, flut);
    L.env = env;
    L.out = out;

    let attack = 0.07;
    if (w.name === 'flame') {
      // roar (low) + hiss (mid) + air (high), with an uneven flutter
      L.rel = 0.16;
      loopNoise(L, 'pink', 'bandpass', 320, 0.6, 1.0, flut);
      loopNoise(L, 'brown', 'lowpass', 300, 0, 0.4, flut);
      const hiss = loopNoise(L, 'white', 'bandpass', 2600, 0.6, 0.5, flut);
      loopNoise(L, 'pink', 'highpass', 5000, 0, 0.25, flut);
      loopLfo(L, 8.7, 0.16, flut.gain);
      loopLfo(L, 19.3, 0.08, flut.gain);
      loopLfo(L, 0.9, 350, hiss.frequency);
    } else {
      // whirlpool: low rumble plus a slowly circling band
      attack = 0.45;
      L.rel = 0.5;
      loopNoise(L, 'brown', 'lowpass', 300, 0, 0.8, flut);
      const swirl = loopNoise(L, 'pink', 'bandpass', 480, 2, 0.9, flut);
      const wash = loopNoise(L, 'pink', 'bandpass', 1100, 1.5, 0.2, flut);
      loopLfo(L, 0.8, 200, swirl.frequency);
      loopLfo(L, 0.5, 300, wash.frequency);
      loopLfo(L, 0.8, 0.12, flut.gain);
    }
    env.gain.setValueAtTime(0, now);
    env.gain.setTargetAtTime(1, now, attack / 3);

    L.live = L.srcs.length;
    for (let i = 0; i < L.srcs.length; i++) {
      L.srcs[i].onended = function () {
        L.live--;
        if (L.live <= 0) disconnectAll(L.nodes);
      };
    }
    loops[key] = L;
  }

  function stopLoop(key, fast) {
    const L = loops[key];
    if (!L) return;
    delete loops[key];
    const now = ctx.currentTime;
    const rel = fast ? 0.016 : L.rel;
    try { L.env.gain.setTargetAtTime(0, now, rel / 4); } catch (e) { /* ignore */ }
    for (let i = 0; i < L.srcs.length; i++) {
      try { L.srcs[i].stop(now + rel + 0.02); } catch (e2) { /* ignore */ }
    }
  }

  function syncLoops() {
    const keys = Object.keys(wantLoops);
    for (let i = 0; i < keys.length; i++) {
      if (!loops[keys[i]]) startLoop(keys[i], wantLoops[keys[i]]);
    }
  }

  function loop(key, name, on, o) {
    try {
      key = String(key);
      if (!on) {
        delete wantLoops[key];
        if (ctx && loops[key]) stopLoop(key, false);
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(LOOP_GAIN, name)) return;
      o = o || {};
      let w = wantLoops[key];
      if (!w) {
        w = { name: name, pan: 0, vol: 1 };
        wantLoops[key] = w;
      }
      if (o.pan !== undefined) w.pan = clamp(num(o.pan, 0), -1, 1);
      if (o.vol !== undefined) w.vol = clamp(num(o.vol, 1), 0, 1);
      if (w.name !== name) {
        w.name = name;
        if (ctx && loops[key]) stopLoop(key, false);
      }
      if (!ensure() || !live()) return;
      const L = loops[key];
      if (!L) { startLoop(key, w); return; }
      const now = ctx.currentTime;
      if (L.pan && L.curPan !== w.pan) { L.curPan = w.pan; L.pan.pan.setTargetAtTime(w.pan, now, 0.03); }
      if (L.curVol !== w.vol) { L.curVol = w.vol; L.out.gain.setTargetAtTime(LOOP_GAIN[w.name] * w.vol, now, 0.03); }
    } catch (e) { /* never throw */ }
  }

  /* ---------------------------------------------------------------- music */

  function musicVoice(tr, t, dest, gain) {
    const V = newVoice(dest, t, 1);
    V.out.gain.value = gain;
    V.owner = tr;
    tr.voices.add(V);
    return V;
  }

  function musicEvent(tr, ev, t) {
    const S = tr.song;
    const sd = S.sd;
    const lv = S.mix[ev.i] === undefined ? 1 : S.mix[ev.i];
    let V, e, f, d, i, long;

    switch (ev.i) {
      case 'kick':
        V = musicVoice(tr, t, tr.C, 0.7 * lv * ev.v);
        T(V, { f: 170, f1: 52, gt: 0.07, d: 0.22, a: 0.002 });
        T(V, { w: 'triangle', f: 1200, f1: 300, d: 0.016, a: 0.001, v: 0.3 });
        break;
      case 'snare':
        V = musicVoice(tr, t, tr.C, 0.55 * lv * ev.v);
        N(V, { ft: 'highpass', c: 1700, d: 0.17, a: 0.001, v: 0.9 });
        T(V, { w: 'triangle', f: 235, f1: 165, d: 0.09, v: 0.6 });
        break;
      case 'hat':
        V = musicVoice(tr, t, tr.R, 0.2 * lv * ev.v);
        N(V, { ft: 'highpass', c: 7500, d: 0.05, a: 0.001 });
        break;
      case 'ohat':
        V = musicVoice(tr, t, tr.R, 0.2 * lv * ev.v);
        N(V, { ft: 'highpass', c: 7000, d: 0.26, a: 0.001 });
        break;
      case 'rim':
        V = musicVoice(tr, t, tr.L, 0.3 * lv * ev.v);
        T(V, { w: 'triangle', f: 1650, d: 0.03, a: 0.001, v: 0.5 });
        T(V, { f: 830, d: 0.055, a: 0.001, v: 0.8 });
        break;
      case 'shaker':
        V = musicVoice(tr, t, tr.R, 0.22 * lv * ev.v);
        N(V, { ft: 'bandpass', c: 6200, q: 1.4, d: 0.08, a: 0.012 });
        break;
      case 'crash':
        V = musicVoice(tr, t, tr.L, 0.25 * lv * ev.v);
        N(V, { n: 'pink', ft: 'highpass', c: 4000, d: 1.3, a: 0.002 });
        break;
      case 'tom':
        V = musicVoice(tr, t, tr.C, 0.6 * lv * ev.v);
        T(V, { f: 150, f1: 80, d: 0.26, a: 0.002 });
        break;

      case 'bass':
        f = hz(ev.n + S.tr);
        d = Math.max(ev.l * sd * 0.94, 0.09);
        V = musicVoice(tr, t, tr.C, 0.42 * lv);
        if (S.inst.bass === 'round') {
          e = E(V, { d: d + 0.08, h: d * 0.5, a: 0.008, c: 700 });
          O(V, { w: 'triangle', f: f }, e);
          O(V, { f: f * 2, g: 0.3 }, e);
        } else if (S.inst.bass === 'chip') {
          e = E(V, { d: d + 0.04, h: d * 0.6, a: 0.004, v: 0.7, c: 1700, c1: 380, ct: 0.14, q: 3 });
          O(V, { w: 'square', f: f }, e);
        } else if (S.inst.bass === 'drive') {
          e = E(V, { d: d + 0.04, h: d * 0.5, a: 0.004, v: 0.8, c: 1600, c1: 320, ct: 0.12, q: 5 });
          O(V, { w: 'sawtooth', f: f }, e);
        } else {
          e = E(V, { d: d + 0.06, h: d * 0.5, a: 0.006, c: 900 });
          O(V, { w: 'triangle', f: f }, e);
          O(V, { w: 'sawtooth', f: f, g: 0.3 }, e);
        }
        break;

      case 'chord':
        d = ev.l * sd;
        V = musicVoice(tr, t, tr.L, 0.38 * lv);
        if (S.inst.chord === 'marimba') {
          e = E(V, { d: 0.42, a: 0.002, v: 0.45 });
          for (i = 0; i < ev.ns.length; i++) O(V, { w: 'triangle', f: hz(ev.ns[i] + S.tr) }, e);
          T(V, { f: hz(ev.ns[ev.ns.length - 1] + S.tr) * 4, d: 0.05, a: 0.001, v: 0.12 });
        } else if (S.inst.chord === 'brass') {
          e = E(V, { d: d * 0.9 + 0.07, h: d * 0.55, a: 0.018, v: 0.33, c: 900, c1: 2600, ct: 0.06, q: 1, lin: true });
          for (i = 0; i < ev.ns.length; i++) O(V, { w: 'sawtooth', f: hz(ev.ns[i] + S.tr), det: i * 5 - 5 }, e);
        } else {
          e = E(V, { d: d * 0.9 + 0.06, a: 0.003, v: 0.33, c: 3200, c1: 700, q: 2 });
          for (i = 0; i < ev.ns.length; i++) O(V, { w: 'sawtooth', f: hz(ev.ns[i] + S.tr), det: i * 5 - 5 }, e);
        }
        break;

      case 'lead':
        f = hz(ev.n + S.tr);
        d = ev.l * sd;
        long = ev.l >= 3;
        V = musicVoice(tr, t, tr.C, 0.42 * lv);
        if (S.inst.lead === 'whistle') {
          e = E(V, { d: d * 0.95 + 0.06, h: d * 0.55, a: 0.025, v: 0.8 });
          O(V, { f: f, vib: long ? [5.5, 12, 0.1] : null }, e);
          O(V, { w: 'triangle', f: f, g: 0.35 }, e);
        } else if (S.inst.lead === 'square') {
          e = E(V, { d: d * 0.9 + 0.05, h: d * 0.65, a: 0.005, v: 0.6, c: 4200 });
          O(V, { w: 'square', f: f, g: 0.6, vib: long ? [5.8, 14, 0.12] : null }, e);
          O(V, { w: 'square', f: f, det: 9, g: 0.4 }, e);
        } else if (S.inst.lead === 'saw') {
          e = E(V, { d: d * 0.92 + 0.05, h: d * 0.65, a: 0.008, v: 0.6, c: 3200, c1: 1800, q: 3 });
          O(V, { w: 'sawtooth', f: f, g: 0.6, vib: long ? [6.2, 16, 0.15] : null }, e);
          O(V, { w: 'sawtooth', f: f, det: -11, g: 0.45 }, e);
        } else {
          e = E(V, { d: d * 0.92 + 0.07, h: d * 0.6, a: 0.018, v: 0.6, c: 1000, c1: 3200, ct: 0.07, q: 1, lin: true });
          O(V, { w: 'sawtooth', f: f, g: 0.6, vib: long ? [5.5, 10, 0.15] : null }, e);
          O(V, { w: 'sawtooth', f: f, det: 8, g: 0.45 }, e);
        }
        break;

      case 'arp':
        f = hz(ev.n + S.tr);
        V = musicVoice(tr, t, tr.L, 0.36 * lv);
        if (S.inst.arp === 'kalimba') {
          T(V, { f: f, d: 0.45, a: 0.002, v: 0.8 });
          T(V, { f: f * 3, d: 0.06, a: 0.001, v: 0.2 });
        } else {
          e = E(V, { d: 0.17, a: 0.002, v: 0.6, c: 3600, c1: 700, q: 4 });
          O(V, { w: 'square', f: f }, e);
        }
        break;

      default:
        break;
    }
  }

  function playStep(tr, t) {
    const S = tr.song;
    const evs = S.steps[tr.step];
    const at = t + ((tr.step & 1) ? S.swing * S.sd : 0);
    for (let i = 0; i < evs.length; i++) {
      try { musicEvent(tr, evs[i], at); } catch (e) { /* skip a bad note, keep the beat */ }
    }
    counters.steps++;
  }

  function scheduleTrack(tr, until, maxSteps) {
    const S = tr.song;
    let n = 0;
    while (tr.nextTime < until && n < maxSteps) {
      playStep(tr, tr.nextTime);
      tr.step = (tr.step + 1) % S.total;
      tr.nextTime += S.sd;
      n++;
    }
  }

  function horizon() { return ctx.length / ctx.sampleRate; }

  function startTrack(name, now, fadeIn, fromStep) {
    const song = compileSong(name);
    const g = ctx.createGain();
    g.connect(musicBus);
    if (fadeIn) {
      g.gain.setValueAtTime(0, now);
      g.gain.setTargetAtTime(song.level, now, 0.07);
    } else {
      g.gain.value = song.level;
    }
    const tr = {
      name: name, song: song, gain: g, C: g, L: g, R: g, nodes: [g], voices: new Set(),
      step: (fromStep || 0) % song.total, nextTime: now + 0.06, endAt: Infinity, dead: false
    };
    if (hasPan) {
      tr.L = ctx.createStereoPanner();
      tr.L.pan.value = -0.3;
      tr.L.connect(g);
      tr.R = ctx.createStereoPanner();
      tr.R.pan.value = 0.3;
      tr.R.connect(g);
      tr.nodes.push(tr.L, tr.R);
    }
    tracks.push(tr);
    counters.starts++;
    return tr;
  }

  // Stops every note of a track at `when`; its nodes are released once the
  // last voice has ended.
  function destroyTrack(tr, when) {
    if (tr.dead) return;
    tr.dead = true;
    const idx = tracks.indexOf(tr);
    if (idx >= 0) tracks.splice(idx, 1);
    if (tr === cur) cur = null;
    if (tr.voices.size === 0) { disconnectAll(tr.nodes); return; }
    try { tr.gain.gain.setTargetAtTime(0, when, 0.004); } catch (e) { /* ignore */ }
    tr.voices.forEach(function (V) { killVoice(V, when); });
  }

  function fadeOutTrack(tr, now) {
    try { tr.gain.gain.setTargetAtTime(0, now, XFADE / 4); } catch (e) { /* ignore */ }
    tr.endAt = now + XFADE;
    if (offline) {
      // No timers in an offline render: everything is already scheduled, so
      // cut the tail at the end of the fade right now.
      tr.voices.forEach(function (V) { if (V.end > tr.endAt) killVoice(V, tr.endAt); });
      tr.dead = true;
      const idx = tracks.indexOf(tr);
      if (idx >= 0) tracks.splice(idx, 1);
      if (tr.voices.size === 0) disconnectAll(tr.nodes);
    }
  }

  // Makes the playing track match `wantTrack` (only called while live).
  function syncMusic() {
    if (cur && cur.name === wantTrack) { startTimer(); return; }
    const now = ctx.currentTime;
    const had = !!cur;
    if (cur) {
      fadeOutTrack(cur, now);
      cur = null;
    }
    if (wantTrack) {
      cur = startTrack(wantTrack, now, had, resumeStep);
      resumeStep = 0;
      if (offline) scheduleTrack(cur, horizon(), 100000);
    }
    if (!offline) {
      startTimer();
      tick();
    }
  }

  function tick() {
    try {
      if (!ctx || paused) return;
      if (ctx.state !== 'running' && ctx.state !== undefined) return;
      const now = ctx.currentTime;
      for (let i = tracks.length - 1; i >= 0; i--) {
        const tr = tracks[i];
        if (now >= tr.endAt) { destroyTrack(tr, now); continue; }
        const sd = tr.song.sd;
        if (tr.nextTime < now - 0.03) {
          // Fell behind (throttled timers, suspended tab): skip ahead but stay on the beat grid.
          const skip = Math.ceil((now + 0.02 - tr.nextTime) / sd);
          tr.step = (tr.step + skip) % tr.song.total;
          tr.nextTime += skip * sd;
        }
        scheduleTrack(tr, Math.min(now + LOOKAHEAD, tr.endAt), 64);
      }
      ticks++;
      if (ticks % 20 === 0) sweep(now);
      if (!tracks.length) stopTimer();
    } catch (e) { /* never throw from a timer */ }
  }

  function startTimer() {
    if (timer === null && !offline && tracks.length) timer = setInterval(tick, TICK_MS);
  }

  function stopTimer() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function setMusic(track) {
    try {
      if (track === undefined) track = null;
      if (track !== null && !Object.prototype.hasOwnProperty.call(SONGS, track)) return;
      if (track === wantTrack) return;
      wantTrack = track;
      resumeStep = 0;
      if (track === null && !ctx) return;
      if (!ensure() || !live()) return;
      syncMusic();
    } catch (e) { /* never throw */ }
  }

  /* --------------------------------------------------------- public bits */

  function unlock() {
    try {
      if (!ensure()) return;
      if (!offline && ctx.state !== 'running' && ctx.state !== 'closed' && typeof ctx.resume === 'function') {
        // iOS wants an actual source started inside the gesture.
        try {
          const s = ctx.createBufferSource();
          s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
          s.connect(ctx.destination);
          s.onended = function () { try { s.disconnect(); } catch (e) { /* ignore */ } };
          s.start(0);
        } catch (e2) { /* ignore */ }
        const p = ctx.resume();
        if (p && typeof p.then === 'function') p.then(onState, noop);
      }
      onState();
    } catch (e3) { /* never throw */ }
  }

  function setPaused(p) {
    try {
      p = !!p;
      if (p === paused) return;
      paused = p;
      if (!ctx) return;
      const now = ctx.currentTime;
      const g = master.gain;
      let i;
      if (p) {
        g.cancelScheduledValues(now);
        g.setTargetAtTime(0, now, 0.003);
        g.setValueAtTime(0, now + 0.02);
        stopTimer();
        if (cur) {
          // Resume from the start of the bar that is playing right now.
          const S = cur.song;
          const behind = Math.max(0, Math.round((cur.nextTime - now) / S.sd));
          const at = ((cur.step - behind) % S.total + S.total) % S.total;
          resumeStep = at - (at % 16);
        }
        for (i = tracks.length - 1; i >= 0; i--) destroyTrack(tracks[i], now);
        cur = null;
        const keys = Object.keys(loops);
        for (i = 0; i < keys.length; i++) stopLoop(keys[i], true);
        for (i = sfxVoices.length - 1; i >= 0; i--) killVoice(sfxVoices[i], now);
      } else {
        g.cancelScheduledValues(now);
        g.setTargetAtTime(MASTER_GAIN, now, 0.008);
        onState();
      }
    } catch (e) { /* never throw */ }
  }

  function setVolumes(v) {
    try {
      if (!v) return;
      if (typeof v.music === 'number' && isFinite(v.music)) vol.music = clamp(v.music, 0, 1);
      if (typeof v.sfx === 'number' && isFinite(v.sfx)) vol.sfx = clamp(v.sfx, 0, 1);
      if (!ctx) return;
      const now = ctx.currentTime;
      musicBus.gain.setTargetAtTime(MUSIC_GAIN * vol.music, now, 0.02);
      sfxBus.gain.setTargetAtTime(SFX_GAIN * vol.sfx, now, 0.02);
    } catch (e) { /* never throw */ }
  }

  function now() {
    try { return ctx ? ctx.currentTime : 0; } catch (e) { return 0; }
  }

  // Not part of the game-facing API: numbers for tests and leak hunting.
  function stats() {
    let mv = 0;
    for (let i = 0; i < tracks.length; i++) mv += tracks[i].voices.size;
    return {
      hasContext: !!ctx,
      state: ctx ? (ctx.state || 'running') : 'none',
      offline: offline,
      paused: paused,
      sfxVoices: sfxVoices.length,
      musicVoices: mv,
      tracks: tracks.length,
      track: cur ? cur.name : null,
      wantTrack: wantTrack,
      loops: Object.keys(loops).length,
      wantLoops: Object.keys(wantLoops).length,
      timer: timer !== null,
      steps: counters.steps,
      trackStarts: counters.starts,
      played: counters.played,
      dropped: counters.dropped,
      stolen: counters.stolen,
      songWarnings: songWarnings.slice()
    };
  }

  // Browsers keep the context suspended until a user gesture: unlock on the
  // first one we see, and again if the context ever gets interrupted.
  const GESTURES = ['pointerdown', 'mousedown', 'touchstart', 'touchend', 'keydown', 'click'];
  function onGesture() {
    if (!ctx || (ctx.state !== 'running' && ctx.state !== undefined)) unlock();
  }
  function listen(on) {
    if (!win || injected || typeof win.addEventListener !== 'function') return;
    for (let i = 0; i < GESTURES.length; i++) {
      try {
        if (on) win.addEventListener(GESTURES[i], onGesture, true);
        else win.removeEventListener(GESTURES[i], onGesture, true);
      } catch (e) { /* ignore */ }
    }
  }

  // Not part of the game-facing API: tears everything down (tests, hot reload).
  function dispose() {
    try {
      listen(false);
      stopTimer();
      wantTrack = null;
      let i;
      let keys = Object.keys(wantLoops);
      for (i = 0; i < keys.length; i++) delete wantLoops[keys[i]];
      if (ctx) {
        const t = ctx.currentTime;
        for (i = tracks.length - 1; i >= 0; i--) destroyTrack(tracks[i], t);
        keys = Object.keys(loops);
        for (i = 0; i < keys.length; i++) stopLoop(keys[i], true);
        for (i = sfxVoices.length - 1; i >= 0; i--) killVoice(sfxVoices[i], t);
        if (!injected && typeof ctx.close === 'function') {
          const p = ctx.close();
          if (p && typeof p.then === 'function') p.then(noop, noop);
        }
      }
      disposed = true;
      paused = true;
    } catch (e) { /* never throw */ }
  }

  if (injected) ensure();
  listen(true);

  return {
    unlock: unlock,
    setPaused: setPaused,
    setMusic: setMusic,
    play: play,
    loop: loop,
    quack: quack,
    setVolumes: setVolumes,
    now: now,
    _stats: stats,
    dispose: dispose
  };
}

// Names accepted by audio.play(), audio.setMusic() and audio.loop().
export const SFX_NAMES = Object.keys(SFX);
export const MUSIC_TRACKS = Object.keys(SONGS);
export const LOOP_NAMES = Object.keys(LOOP_GAIN);
