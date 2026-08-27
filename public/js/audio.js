/*
 * MiviAudio — self-contained Web Audio sound-effects + generative-music engine
 * for "Mivimoose Draw".
 *
 * Everything is synthesized in real time; no samples, no network, no deps.
 * Plain script (non-module). Attaches exactly one global: window.MiviAudio.
 *
 * Usage:
 *   MiviAudio.init()            — call from a user gesture (click/tap). Safe to
 *                                 call repeatedly; creates/resumes the context.
 *   MiviAudio.sfx('correct')    — play a one-shot sound effect.
 *   MiviAudio.startMusic()      — begin the generative background loop.
 *   MiviAudio.stopMusic()
 *   MiviAudio.setMusicVolume(v) / setSfxVolume(v)      — 0..1, smoothed.
 *   MiviAudio.setMusicEnabled(b) / setSfxEnabled(b)
 *   MiviAudio.duck(seconds)     — dip music ~-10 dB, then recover.
 *   MiviAudio.getState()        — {musicEnabled, sfxEnabled, musicVolume, sfxVolume}
 *
 * Every public call silently no-ops when Web Audio is unavailable or init()
 * has not run yet — it never throws.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  Preferences (persisted to localStorage, loaded at script load)
   * ------------------------------------------------------------------ */

  var LS_MUSIC_ON = 'mivi_audio_music_on';
  var LS_SFX_ON = 'mivi_audio_sfx_on';
  var LS_MUSIC_VOL = 'mivi_audio_music_vol';
  var LS_SFX_VOL = 'mivi_audio_sfx_vol';

  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function lsSet(key, value) {
    try { window.localStorage.setItem(key, String(value)); } catch (e) { /* storage blocked; ignore */ }
  }

  function clamp01(v) {
    v = Number(v);
    if (!isFinite(v)) return 0;
    return Math.min(1, Math.max(0, v));
  }

  function loadBool(key, fallback) {
    var raw = lsGet(key);
    if (raw === null || raw === undefined) return fallback;
    return raw === 'true' || raw === '1';
  }

  function loadVol(key, fallback) {
    var raw = lsGet(key);
    if (raw === null || raw === undefined) return fallback;
    var v = parseFloat(raw);
    return isFinite(v) ? clamp01(v) : fallback;
  }

  var state = {
    musicEnabled: loadBool(LS_MUSIC_ON, true),
    sfxEnabled: loadBool(LS_SFX_ON, true),
    musicVolume: loadVol(LS_MUSIC_VOL, 0.5),
    sfxVolume: loadVol(LS_SFX_VOL, 0.8)
  };

  function persist() {
    lsSet(LS_MUSIC_ON, state.musicEnabled);
    lsSet(LS_SFX_ON, state.sfxEnabled);
    lsSet(LS_MUSIC_VOL, state.musicVolume);
    lsSet(LS_SFX_VOL, state.sfxVolume);
  }

  /* ------------------------------------------------------------------ *
   *  Audio graph
   *
   *  sfx voices ──► sfxBus ─────────────────────────┐
   *                                                  ├─► master ─► limiter ─► out
   *  music voices ─► musicFade ─► musicBus ─► duck ──┘
   *  (pads route through a shared lowpass before musicFade)
   * ------------------------------------------------------------------ */

  var AC = window.AudioContext || window.webkitAudioContext;
  var ctx = null;        // AudioContext, created on first init()
  var master = null;     // overall gain (headroom)
  var limiter = null;    // compressor acting as a safety limiter
  var sfxBus = null;     // sfx volume
  var musicBus = null;   // music volume
  var musicFade = null;  // start/stop fade so stopMusic() doesn't cut tails harshly
  var duckGain = null;   // temporary music ducking (countdown etc.)
  var padFilter = null;  // shared warm lowpass for the pad layer
  var noiseBuffer = null;

  var sfxVoices = 0;           // active one-shot sources (bounded)
  var MAX_SFX_VOICES = 48;

  function buildGraph() {
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 8;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(ctx.destination);

    master = ctx.createGain();
    master.gain.value = 0.9; // headroom before the limiter
    master.connect(limiter);

    sfxBus = ctx.createGain();
    sfxBus.gain.value = state.sfxVolume;
    sfxBus.connect(master);

    duckGain = ctx.createGain();
    duckGain.gain.value = 1;
    duckGain.connect(master);

    musicBus = ctx.createGain();
    musicBus.gain.value = state.musicVolume;
    musicBus.connect(duckGain);

    musicFade = ctx.createGain();
    musicFade.gain.value = 1;
    musicFade.connect(musicBus);

    padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 850;
    padFilter.Q.value = 0.5;
    padFilter.connect(musicFade);

    // 2 seconds of reusable white noise
    var len = Math.floor(ctx.sampleRate * 2);
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = noiseBuffer.getChannelData(0);
    for (var i = 0; i < len; i++) {
      data[i] = Math.random() * 2 - 1;
    }
  }

  /* ------------------------------------------------------------------ *
   *  Small helpers
   * ------------------------------------------------------------------ */

  function midiToFreq(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  }

  // Disconnect a chain of nodes when its source finishes (prevents leaks).
  function cleanupOnEnd(src, nodes) {
    src.onended = function () {
      src.onended = null;
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i]) {
          try { nodes[i].disconnect(); } catch (e) { /* already gone */ }
        }
      }
    };
  }

  // Same, but also tracks the bounded sfx voice count.
  function registerSfxVoice(src, nodes) {
    sfxVoices++;
    src.onended = function () {
      src.onended = null;
      sfxVoices = Math.max(0, sfxVoices - 1);
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i]) {
          try { nodes[i].disconnect(); } catch (e) { /* already gone */ }
        }
      }
    };
  }

  /*
   * One-shot oscillator with envelope, optional pitch glide and filter.
   * spec: { freq, endFreq, glide, type, delay, attack, dur, peak, detune,
   *         filter: { type, freq, endFreq, q } }
   */
  function playTone(spec) {
    if (!ctx || sfxVoices >= MAX_SFX_VOICES) return;
    var t0 = ctx.currentTime + (spec.delay || 0);
    var dur = spec.dur || 0.2;
    var attack = spec.attack !== undefined ? spec.attack : 0.005;
    var peak = spec.peak !== undefined ? spec.peak : 0.1;

    var osc = ctx.createOscillator();
    osc.type = spec.type || 'sine';
    osc.frequency.setValueAtTime(spec.freq, t0);
    if (spec.endFreq) {
      osc.frequency.exponentialRampToValueAtTime(spec.endFreq, t0 + (spec.glide || dur));
    }
    if (spec.detune) osc.detune.setValueAtTime(spec.detune, t0);

    var gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    var filter = null;
    osc.connect(gain);
    if (spec.filter) {
      filter = ctx.createBiquadFilter();
      filter.type = spec.filter.type || 'lowpass';
      filter.frequency.setValueAtTime(spec.filter.freq, t0);
      if (spec.filter.endFreq) {
        filter.frequency.linearRampToValueAtTime(spec.filter.endFreq, t0 + dur);
      }
      if (spec.filter.q) filter.Q.value = spec.filter.q;
      gain.connect(filter);
      filter.connect(sfxBus);
    } else {
      gain.connect(sfxBus);
    }

    registerSfxVoice(osc, [osc, gain, filter]);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /*
   * One-shot filtered noise burst.
   * spec: { delay, attack, dur, peak, filter: { type, freq, endFreq, q } }
   */
  function playNoise(spec) {
    if (!ctx || sfxVoices >= MAX_SFX_VOICES) return;
    var t0 = ctx.currentTime + (spec.delay || 0);
    var dur = spec.dur || 0.05;
    var attack = spec.attack !== undefined ? spec.attack : 0.002;
    var peak = spec.peak !== undefined ? spec.peak : 0.1;

    var src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    // Random start offset so repeated bursts don't sound identical.
    var offset = Math.random() * 1.2;

    var gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    var filter = null;
    src.connect(gain);
    if (spec.filter) {
      filter = ctx.createBiquadFilter();
      filter.type = spec.filter.type || 'bandpass';
      filter.frequency.setValueAtTime(spec.filter.freq, t0);
      if (spec.filter.endFreq) {
        filter.frequency.linearRampToValueAtTime(spec.filter.endFreq, t0 + dur);
      }
      if (spec.filter.q) filter.Q.value = spec.filter.q;
      gain.connect(filter);
      filter.connect(sfxBus);
    } else {
      gain.connect(sfxBus);
    }

    registerSfxVoice(src, [src, gain, filter]);
    src.start(t0, offset);
    src.stop(t0 + dur + 0.03);
  }

  /* ------------------------------------------------------------------ *
   *  Sound effects
   * ------------------------------------------------------------------ */

  // Warm chord stab used by the game-over fanfare.
  function fanfareChord(midis, delay, dur, peak) {
    for (var i = 0; i < midis.length; i++) {
      var f = midiToFreq(midis[i]);
      playTone({
        delay: delay, freq: f, type: 'sawtooth', peak: peak, attack: 0.015,
        dur: dur, filter: { type: 'lowpass', freq: 2200, q: 0.6 }
      });
      playTone({ delay: delay, freq: f, detune: 8, type: 'triangle', peak: peak * 0.7, attack: 0.015, dur: dur });
    }
  }

  var SFX = {

    // Barely-there UI tick.
    click: function () {
      playTone({
        freq: 1900, type: 'sine', peak: 0.05, attack: 0.001, dur: 0.035,
        filter: { type: 'highpass', freq: 900 }
      });
    },

    // Friendly rising pop-up blip.
    join: function () {
      playTone({ freq: 460, endFreq: 880, glide: 0.1, type: 'sine', peak: 0.12, attack: 0.004, dur: 0.2 });
      playTone({ freq: 920, endFreq: 1760, glide: 0.1, type: 'triangle', peak: 0.03, attack: 0.004, dur: 0.15 });
    },

    // Soft descending blip.
    leave: function () {
      playTone({ freq: 660, endFreq: 320, glide: 0.16, type: 'sine', peak: 0.1, attack: 0.004, dur: 0.24 });
    },

    // Bright ascending two-note chime, major third (A5 -> C#6), sparkly.
    correct: function () {
      playTone({ freq: 880.0, type: 'triangle', peak: 0.11, attack: 0.003, dur: 0.5 });
      playTone({ freq: 1760.0, type: 'sine', peak: 0.04, attack: 0.003, dur: 0.3 });
      playTone({ freq: 880.0, detune: 6, type: 'sine', peak: 0.05, attack: 0.003, dur: 0.45 });
      playTone({ delay: 0.12, freq: 1108.73, type: 'triangle', peak: 0.12, attack: 0.003, dur: 0.7 });
      playTone({ delay: 0.12, freq: 2217.46, type: 'sine', peak: 0.05, attack: 0.003, dur: 0.45 });
      playTone({ delay: 0.12, freq: 1108.73, detune: -6, type: 'sine', peak: 0.05, attack: 0.003, dur: 0.6 });
    },

    // "Almost!" — two quick wah notes a minor second apart, bending down.
    close: function () {
      playTone({
        freq: 415.3, endFreq: 392.0, glide: 0.12, type: 'square', peak: 0.06,
        attack: 0.008, dur: 0.14, filter: { type: 'lowpass', freq: 1400, endFreq: 700, q: 4 }
      });
      playTone({
        delay: 0.16, freq: 392.0, endFreq: 370.0, glide: 0.14, type: 'square', peak: 0.06,
        attack: 0.008, dur: 0.18, filter: { type: 'lowpass', freq: 1400, endFreq: 600, q: 4 }
      });
    },

    // Metallic click-latch: noise snap + two inharmonic ping partials.
    lock: function () {
      playNoise({ dur: 0.05, peak: 0.14, filter: { type: 'bandpass', freq: 3200, q: 2 } });
      playTone({ delay: 0.03, freq: 1568, type: 'triangle', peak: 0.09, attack: 0.002, dur: 0.35 });
      playTone({ delay: 0.03, freq: 2489, type: 'sine', peak: 0.035, attack: 0.002, dur: 0.2 });
    },

    // Soft glassy ding.
    hint: function () {
      playTone({ freq: 1318.5, type: 'sine', peak: 0.08, attack: 0.002, dur: 0.7 });
      playTone({ freq: 2637.0, type: 'sine', peak: 0.03, attack: 0.002, dur: 0.4 });
    },

    // Soft woodblock.
    tick: function () {
      playNoise({ dur: 0.03, peak: 0.09, filter: { type: 'bandpass', freq: 1200, q: 5 } });
      playTone({ freq: 850, type: 'sine', peak: 0.1, attack: 0.001, dur: 0.06 });
    },

    // Countdown tick — same woodblock, pitched up for urgency.
    countdown: function () {
      playNoise({ dur: 0.03, peak: 0.09, filter: { type: 'bandpass', freq: 1700, q: 5 } });
      playTone({ freq: 1150, type: 'sine', peak: 0.11, attack: 0.001, dur: 0.06 });
    },

    // Warm three-note rising arpeggio fanfare (C5 E5 G5 + octave sparkle).
    yourTurn: function () {
      var notes = [523.25, 659.25, 783.99];
      for (var i = 0; i < notes.length; i++) {
        var d = i * 0.11;
        playTone({ delay: d, freq: notes[i], type: 'triangle', peak: 0.11, attack: 0.004, dur: 0.45 });
        playTone({ delay: d, freq: notes[i], detune: 7, type: 'sine', peak: 0.05, attack: 0.004, dur: 0.4 });
      }
      playTone({ delay: 0.22, freq: 1046.5, type: 'sine', peak: 0.05, attack: 0.004, dur: 0.6 });
    },

    // Bright swoosh (rising filtered noise) + ding.
    roundStart: function () {
      playNoise({
        attack: 0.12, dur: 0.35, peak: 0.08,
        filter: { type: 'bandpass', freq: 500, endFreq: 3200, q: 1.2 }
      });
      playTone({ delay: 0.26, freq: 1046.5, type: 'triangle', peak: 0.1, attack: 0.003, dur: 0.5 });
      playTone({ delay: 0.26, freq: 2093.0, type: 'sine', peak: 0.035, attack: 0.003, dur: 0.35 });
    },

    // Gentle two-note downward resolve (E5 -> C5).
    roundEnd: function () {
      playTone({ freq: 659.25, type: 'triangle', peak: 0.09, attack: 0.005, dur: 0.45 });
      playTone({ delay: 0.18, freq: 523.25, type: 'triangle', peak: 0.09, attack: 0.005, dur: 0.7 });
      playTone({ delay: 0.18, freq: 523.25, detune: 6, type: 'sine', peak: 0.04, attack: 0.005, dur: 0.6 });
    },

    // Short triumphant fanfare: C -> F -> G -> big C major (~1.5s).
    gameOver: function () {
      fanfareChord([60, 64, 67], 0.0, 0.3, 0.045);
      fanfareChord([65, 69, 72], 0.3, 0.3, 0.045);
      fanfareChord([67, 71, 74], 0.6, 0.32, 0.05);
      fanfareChord([60, 64, 67, 72], 0.92, 0.85, 0.05);
      // Soft cymbal-ish shimmer under the final chord.
      playNoise({
        delay: 0.92, attack: 0.02, dur: 0.7, peak: 0.03,
        filter: { type: 'highpass', freq: 6000 }
      });
    },

    // Muted low double-buzz.
    error: function () {
      playTone({
        freq: 110, type: 'square', peak: 0.08, attack: 0.005, dur: 0.1,
        filter: { type: 'lowpass', freq: 420 }
      });
      playTone({
        delay: 0.14, freq: 104, type: 'square', peak: 0.08, attack: 0.005, dur: 0.12,
        filter: { type: 'lowpass', freq: 380 }
      });
    },

    // Tiny bubble pop for word-pick.
    pop: function () {
      playTone({ freq: 280, endFreq: 900, glide: 0.045, type: 'sine', peak: 0.12, attack: 0.001, dur: 0.08 });
    },

    // Camera-shutter-ish snap + soft chime.
    save: function () {
      playNoise({ dur: 0.02, peak: 0.12, filter: { type: 'highpass', freq: 2200 } });
      playNoise({ delay: 0.07, dur: 0.025, peak: 0.1, filter: { type: 'highpass', freq: 1800 } });
      playTone({ delay: 0.14, freq: 1046.5, type: 'sine', peak: 0.06, attack: 0.003, dur: 0.4 });
    },

    // Cute heart "boop": sine blip with a quick pitch-up.
    like: function () {
      playTone({ freq: 520, endFreq: 940, glide: 0.06, type: 'sine', peak: 0.1, attack: 0.002, dur: 0.18 });
      playTone({ delay: 0.02, freq: 1040, endFreq: 1880, glide: 0.06, type: 'sine', peak: 0.025, attack: 0.002, dur: 0.12 });
    }
  };

  /* ------------------------------------------------------------------ *
   *  Generative music
   *
   *  ~88 BPM chill lo-fi loop: warm pad chords (Fmaj7 Am7 Dm7 G7 / Bbmaj7 C7
   *  movements), a sparse marimba-ish melody from per-chord note pools,
   *  round sine bass on roots, soft kick + brushed 8th hats.
   *  Scheduled with a lookahead scheduler so it never glitches; the melody
   *  pattern is regenerated every bar so it stays fresh.
   * ------------------------------------------------------------------ */

  var TEMPO = 88;
  var BEAT = 60 / TEMPO;      // seconds per quarter note
  var EIGHTH = BEAT / 2;      // step size (8th notes)
  var STEPS_PER_BAR = 8;      // 4/4, one chord per bar
  var LOOKAHEAD = 0.2;        // schedule this far ahead (seconds)
  var TIMER_MS = 100;         // scheduler wake-up interval

  // Each bar: bass root, pad chord voicing, melody note pool (MIDI numbers).
  var PROG = [
    { root: 41, pad: [53, 57, 60, 64], pool: [65, 67, 69, 72, 74, 76, 77] }, // Fmaj7
    { root: 45, pad: [57, 60, 64, 67], pool: [64, 67, 69, 72, 74, 76] },     // Am7
    { root: 38, pad: [50, 53, 57, 60], pool: [62, 65, 69, 72, 74, 77] },     // Dm7
    { root: 43, pad: [55, 59, 62, 65], pool: [62, 65, 67, 71, 74, 79] },     // G7
    { root: 41, pad: [53, 57, 60, 64], pool: [65, 67, 69, 72, 74, 76, 77] }, // Fmaj7
    { root: 45, pad: [57, 60, 64, 67], pool: [64, 67, 69, 72, 74, 76] },     // Am7
    { root: 46, pad: [58, 62, 65, 69], pool: [62, 65, 70, 74, 77] },         // Bbmaj7
    { root: 48, pad: [60, 64, 67, 70], pool: [64, 67, 72, 74, 76] }          // C7
  ];

  // Per-step probability weights (down-beats favored, off-beats sparser).
  var STEP_WEIGHT = [1.2, 0.45, 0.9, 0.55, 1.0, 0.45, 0.85, 0.65];

  var musicRequested = false; // startMusic() has been asked for
  var musicPlaying = false;   // scheduler currently running
  var schedulerTimer = null;

  var mus = {
    nextTime: 0,   // absolute ctx time of the next 8th-note step
    step: 0,       // 0..7 within the bar
    bar: 0,        // index into PROG
    pattern: null, // melody pattern for the current bar
    lastNote: 72   // last melody MIDI note (for smooth voice leading)
  };

  function pickMelodyNote(chord) {
    var pool = chord.pool;
    var note;
    if (Math.random() < 0.6) {
      // Prefer small movement from the previous note (with a little wander).
      var target = mus.lastNote + (Math.random() * 8 - 4);
      var best = pool[0];
      var bestD = Infinity;
      for (var i = 0; i < pool.length; i++) {
        var d = Math.abs(pool[i] - target);
        if (d < bestD) { bestD = d; best = pool[i]; }
      }
      note = best;
    } else {
      note = pool[Math.floor(Math.random() * pool.length)];
    }
    mus.lastNote = note;
    return note;
  }

  function makeMelodyPattern(barIdx) {
    var chord = PROG[barIdx];
    var density = 0.3 + Math.random() * 0.28; // varies bar to bar
    var slots = [];
    for (var i = 0; i < STEPS_PER_BAR; i++) {
      slots[i] = (Math.random() < density * STEP_WEIGHT[i]) ? pickMelodyNote(chord) : 0;
    }
    // Occasionally leave a mostly-empty bar — rests keep it musical.
    if (Math.random() < 0.14) {
      for (var j = 1; j < STEPS_PER_BAR; j++) {
        if (j !== 4) slots[j] = 0;
      }
    }
    return slots;
  }

  // Warm pad: two gently detuned saws per chord tone through a shared lowpass.
  function schedulePad(chord, t) {
    var barDur = STEPS_PER_BAR * EIGHTH;
    var level = 0.016 * (0.9 + Math.random() * 0.2);
    for (var i = 0; i < chord.pad.length; i++) {
      var freq = midiToFreq(chord.pad[i]);
      var gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(level, t + 0.55);
      gain.gain.setValueAtTime(level, t + barDur - 0.4);
      gain.gain.linearRampToValueAtTime(0.0001, t + barDur + 0.5);
      gain.connect(padFilter);

      for (var k = 0; k < 2; k++) {
        var osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = freq;
        osc.detune.value = (k === 0 ? -5 : 5) + (Math.random() * 2 - 1);
        osc.connect(gain);
        cleanupOnEnd(osc, [osc, k === 1 ? gain : null]);
        osc.start(t);
        osc.stop(t + barDur + 0.6);
      }
    }
  }

  // Quiet round sine bass on the chord root.
  function scheduleBass(rootMidi, t, strong) {
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = midiToFreq(rootMidi);
    var gain = ctx.createGain();
    var peak = (strong ? 0.13 : 0.09) * (0.9 + Math.random() * 0.2);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + BEAT * 1.6);
    osc.connect(gain);
    gain.connect(musicFade);
    cleanupOnEnd(osc, [osc, gain]);
    osc.start(t);
    osc.stop(t + BEAT * 1.7);
  }

  // Soft kick: quick sine pitch-drop.
  function scheduleKick(t, strong) {
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.09);
    var gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(strong ? 0.14 : 0.1, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(gain);
    gain.connect(musicFade);
    cleanupOnEnd(osc, [osc, gain]);
    osc.start(t);
    osc.stop(t + 0.18);
  }

  // Brushed hat: tiny highpassed noise tick.
  function scheduleHat(t, level) {
    var src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    var filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 6500;
    var gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(level, t + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(musicFade);
    cleanupOnEnd(src, [src, filter, gain]);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.06);
  }

  // Marimba-ish melody pluck: sine fundamental + fast-decaying 4x partial.
  function scheduleMelodyNote(midi, t) {
    var freq = midiToFreq(midi);
    var vel = 0.55 + Math.random() * 0.45;

    var out = gainNodeForMelody(t);

    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    var gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.07 * vel, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    osc.connect(gain);
    gain.connect(out.node);
    cleanupOnEnd(osc, [osc, gain, out.owned]);
    osc.start(t);
    osc.stop(t + 0.55);

    var partial = ctx.createOscillator();
    partial.type = 'sine';
    partial.frequency.value = freq * 4;
    var pGain = ctx.createGain();
    pGain.gain.setValueAtTime(0.0001, t);
    pGain.gain.linearRampToValueAtTime(0.018 * vel, t + 0.003);
    pGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    partial.connect(pGain);
    pGain.connect(out.node);
    cleanupOnEnd(partial, [partial, pGain]);
    partial.start(t);
    partial.stop(t + 0.15);
  }

  // Slight random stereo placement for melody notes when supported.
  function gainNodeForMelody(t) {
    if (ctx.createStereoPanner) {
      var pan = ctx.createStereoPanner();
      pan.pan.setValueAtTime(Math.random() * 0.5 - 0.25, t);
      pan.connect(musicFade);
      return { node: pan, owned: pan };
    }
    return { node: musicFade, owned: null };
  }

  function scheduleStep(step, barIdx, t) {
    var chord = PROG[barIdx];

    if (step === 0) {
      schedulePad(chord, t);
      scheduleBass(chord.root, t, true);
      scheduleKick(t, true);
    }
    if (step === 4) {
      scheduleKick(t, false);
      if (Math.random() < 0.7) scheduleBass(chord.root, t, false);
    }
    // Occasional octave-up bass pickup into the next bar.
    if (step === 7 && Math.random() < 0.18) {
      scheduleBass(chord.root + 12, t, false);
    }

    // Brushed hats on 8ths, very quiet, off-beats slightly accented.
    if (Math.random() > 0.08) {
      var level = (step % 2 === 1 ? 0.02 : 0.012) * (0.8 + Math.random() * 0.4);
      scheduleHat(t, level);
    }

    if (mus.pattern && mus.pattern[step]) {
      scheduleMelodyNote(mus.pattern[step], t);
    }
  }

  // Lookahead scheduler: wakes every ~100ms, schedules ~200ms ahead.
  function schedulerTick() {
    if (!ctx || !musicPlaying) return;
    var horizon = ctx.currentTime + LOOKAHEAD;
    while (mus.nextTime < horizon) {
      scheduleStep(mus.step, mus.bar, mus.nextTime);
      mus.nextTime += EIGHTH;
      mus.step++;
      if (mus.step >= STEPS_PER_BAR) {
        mus.step = 0;
        mus.bar = (mus.bar + 1) % PROG.length;
        mus.pattern = makeMelodyPattern(mus.bar);
      }
    }
  }

  function startMusicInternal() {
    if (!ctx || musicPlaying || !state.musicEnabled) return;
    musicPlaying = true;
    var t = ctx.currentTime;
    musicFade.gain.cancelScheduledValues(t);
    musicFade.gain.setValueAtTime(musicFade.gain.value, t);
    musicFade.gain.linearRampToValueAtTime(1, t + 0.3);
    mus.nextTime = t + 0.1;
    mus.step = 0;
    mus.bar = 0;
    mus.lastNote = 72;
    mus.pattern = makeMelodyPattern(0);
    schedulerTick();
    schedulerTimer = setInterval(schedulerTick, TIMER_MS);
  }

  function stopMusicInternal() {
    if (schedulerTimer !== null) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
    musicPlaying = false;
    // Fade already-scheduled tails out gently instead of cutting.
    if (ctx && musicFade) {
      var t = ctx.currentTime;
      musicFade.gain.cancelScheduledValues(t);
      musicFade.gain.setValueAtTime(musicFade.gain.value, t);
      musicFade.gain.linearRampToValueAtTime(0.0001, t + 0.5);
    }
  }

  /* ------------------------------------------------------------------ *
   *  Public API (every method is throw-proof)
   * ------------------------------------------------------------------ */

  var api = {

    // Create/resume the AudioContext. Call from a user gesture; idempotent.
    init: function () {
      try {
        if (!AC) return;
        if (!ctx) {
          ctx = new AC();
          buildGraph();
        }
        if (ctx.state === 'suspended') {
          ctx.resume();
        }
        // If music was requested before init (or while disabled), honor it now.
        if (musicRequested && state.musicEnabled && !musicPlaying) {
          startMusicInternal();
        }
      } catch (e) { /* stay silent */ }
    },

    // Play a named one-shot sound effect.
    sfx: function (name) {
      try {
        if (!ctx || !state.sfxEnabled) return;
        if (ctx.state !== 'running') return;
        var fn = SFX[name];
        if (fn) fn();
      } catch (e) { /* stay silent */ }
    },

    startMusic: function () {
      try {
        musicRequested = true;
        if (ctx && state.musicEnabled && !musicPlaying) {
          startMusicInternal();
        }
      } catch (e) { /* stay silent */ }
    },

    stopMusic: function () {
      try {
        musicRequested = false;
        stopMusicInternal();
      } catch (e) { /* stay silent */ }
    },

    setMusicVolume: function (v) {
      try {
        state.musicVolume = clamp01(v);
        persist();
        if (ctx && musicBus) {
          musicBus.gain.setTargetAtTime(state.musicVolume, ctx.currentTime, 0.08);
        }
      } catch (e) { /* stay silent */ }
    },

    setSfxVolume: function (v) {
      try {
        state.sfxVolume = clamp01(v);
        persist();
        if (ctx && sfxBus) {
          sfxBus.gain.setTargetAtTime(state.sfxVolume, ctx.currentTime, 0.08);
        }
      } catch (e) { /* stay silent */ }
    },

    setMusicEnabled: function (on) {
      try {
        state.musicEnabled = !!on;
        persist();
        if (!state.musicEnabled) {
          stopMusicInternal();
        } else if (ctx && musicRequested && !musicPlaying) {
          startMusicInternal();
        }
      } catch (e) { /* stay silent */ }
    },

    setSfxEnabled: function (on) {
      try {
        state.sfxEnabled = !!on;
        persist();
      } catch (e) { /* stay silent */ }
    },

    // Dip music ~-10 dB for `seconds`, then recover smoothly.
    duck: function (seconds) {
      try {
        if (!ctx || !duckGain) return;
        seconds = Number(seconds);
        if (!isFinite(seconds) || seconds <= 0) return;
        seconds = Math.min(seconds, 120);
        var t = ctx.currentTime;
        var g = duckGain.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(0.316, t + 0.25);          // ~-10 dB
        g.setValueAtTime(0.316, t + 0.25 + seconds);
        g.linearRampToValueAtTime(1, t + 0.25 + seconds + 1.2);
      } catch (e) { /* stay silent */ }
    },

    getState: function () {
      return {
        musicEnabled: state.musicEnabled,
        sfxEnabled: state.sfxEnabled,
        musicVolume: state.musicVolume,
        sfxVolume: state.sfxVolume
      };
    }
  };

  window.MiviAudio = api;
})();
