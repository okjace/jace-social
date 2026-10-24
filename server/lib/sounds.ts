"use client";
// Call sounds: the ringtone (someone's calling you) and the calling sound (you're calling them).
// Built-in ones are made here with Web Audio; custom ones are audio files people upload (their own,
// or shared in the community library - app/api/v1/sounds). The choice is in your settings
// (ringtone / calling_sound: "builtin:<id>" or a sound file's URL).
//
// Phones (iPhone Safari especially) only play sound after you've touched the page: unlockSounds()
// hooks the first tap or key press to unlock both Web Audio and an audio element, which the ringing
// then reuses - otherwise a call could ring in silence.

export type SoundKind = "ringtone" | "calling" | "message";
type Builtin = { id: string; name: string; period: number; play: (ctx: AudioContext, t: number) => void };

function note(ctx: AudioContext, at: number, len: number, freq: number, type: OscillatorType = "sine", vol = 0.08) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(vol, at + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  o.connect(g).connect(ctx.destination);
  o.start(at);
  o.stop(at + len + 0.05);
}

/** The built-in sounds (the same ones work as a ringtone or a calling sound). */
export const BUILTIN: Builtin[] = [
  // short ones, made for messages (they work for calls too)
  { id: "ding", name: "Ding", period: 2000, play: (c, t) => { note(c, t, 0.35, 784, "sine", 0.06); } },
  { id: "pop", name: "Pop", period: 1500, play: (c, t) => { note(c, t, 0.08, 1200, "sine", 0.09); note(c, t + 0.03, 0.12, 600, "sine", 0.05); } },
  { id: "blip", name: "Blip", period: 1500, play: (c, t) => { note(c, t, 0.07, 988, "triangle", 0.08); note(c, t + 0.09, 0.1, 1319, "triangle", 0.08); } },
  { id: "knock", name: "Knock", period: 1500, play: (c, t) => { note(c, t, 0.06, 180, "triangle", 0.25); note(c, t + 0.16, 0.06, 180, "triangle", 0.25); } },
  { id: "classic", name: "Classic", period: 2000, play: (c, t) => { note(c, t, 0.25, 880); note(c, t + 0.35, 0.25, 880); } },
  { id: "dial", name: "Dial tone", period: 3000, play: (c, t) => { note(c, t, 0.9, 440, "sine", 0.07); } },
  { id: "chime", name: "Chime", period: 2400, play: (c, t) => { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(c, t + i * 0.14, 0.6, f)); } },
  { id: "marimba", name: "Marimba", period: 1800, play: (c, t) => { [784, 988, 784, 1175].forEach((f, i) => note(c, t + i * 0.12, 0.3, f, "triangle", 0.12)); } },
  { id: "retro", name: "Retro", period: 2000, play: (c, t) => { [660, 880, 660, 990, 1320].forEach((f, i) => note(c, t + i * 0.09, 0.08, f, "square", 0.04)); } },
  { id: "soft", name: "Soft", period: 3200, play: (c, t) => { note(c, t, 1.4, 392, "sine", 0.06); note(c, t + 0.2, 1.2, 587.33, "sine", 0.04); } },
  { id: "pulse", name: "Pulse", period: 1500, play: (c, t) => { note(c, t, 0.12, 1000, "square", 0.03); note(c, t + 0.2, 0.12, 1000, "square", 0.03); note(c, t + 0.4, 0.12, 1000, "square", 0.03); } },
];
export const DEFAULT_SOUND: Record<SoundKind, string> = { ringtone: "builtin:classic", calling: "builtin:dial", message: "builtin:ding" };

let ctx: AudioContext | null = null;
const audioCtx = () => { try { ctx ??= new AudioContext(); } catch { /* none */ } return ctx; };

// Two audio players, unlocked on your first tap: one for ringing, one for message sounds. Everything
// plays through them (built-in sounds too, rendered to short WAV clips): iPhones only let a page play
// sound through an element it unlocked during a tap, and they mute Web Audio when the ring/silent
// switch is on silent - the reason sounds didn't play on iPhone.
let ringEl: HTMLAudioElement | null = null;
let msgEl: HTMLAudioElement | null = null;
const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

/** Once, early: taps/clicks/keys unlock sound for later (phones need this). */
export function unlockSounds() {
  if (typeof window === "undefined") return;
  const unlock = () => {
    void audioCtx()?.resume().catch(() => {});
    for (const which of ["ring", "msg"] as const) {
      const el = (which === "ring" ? ringEl : msgEl) ?? new Audio();
      if (which === "ring") ringEl = el; else msgEl = el;
      if (el.dataset.unlocked) continue;
      el.muted = true;
      el.src = SILENT;
      void el.play().then(() => { el.pause(); el.muted = false; el.dataset.unlocked = "1"; }).catch(() => { el.muted = false; });
    }
    if (ringEl?.dataset.unlocked && msgEl?.dataset.unlocked)
      for (const e of ["pointerdown", "touchend", "keydown"]) window.removeEventListener(e, unlock, true);
  };
  for (const e of ["pointerdown", "touchend", "keydown"]) window.addEventListener(e, unlock, true);
}

/** A built-in sound as a WAV clip (one loop's length, or once), made once and kept. */
const rendered = new Map<string, Promise<string | null>>();
function builtinClip(b: Builtin, loop: boolean): Promise<string | null> {
  const key = `${b.id}:${loop}`;
  if (!rendered.has(key)) rendered.set(key, (async () => {
    try {
      const rate = 22050, seconds = loop ? b.period / 1000 : 2;
      const off = new OfflineAudioContext(1, Math.ceil(rate * seconds), rate);
      b.play(off as unknown as AudioContext, 0.02);
      const buf = await off.startRendering();
      return URL.createObjectURL(new Blob([wav(buf.getChannelData(0), rate)], { type: "audio/wav" }));
    } catch { return null; }
  })());
  return rendered.get(key)!;
}

/** 16-bit mono WAV bytes. */
function wav(samples: Float32Array, rate: number) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) out.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); out.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVEfmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, "data"); out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i] * 3)) * 0x7fff, true);
  return out.buffer;
}

const builtinOf = (pick: string, kind: SoundKind) =>
  BUILTIN.find((x) => `builtin:${x.id}` === pick) ?? BUILTIN.find((x) => `builtin:${x.id}` === DEFAULT_SOUND[kind])!;

/** Web Audio straight away (computers, or if an audio player can't play): loops until stop. */
function webAudio(b: Builtin, loop: boolean): { stop: () => void } {
  const c = audioCtx();
  if (!c) return { stop() {} };
  void c.resume().catch(() => {});
  const play = () => b.play(c, c.currentTime + 0.05);
  play();
  const timer = loop ? setInterval(play, b.period) : null;
  return { stop() { if (timer) clearInterval(timer); } };
}

/** Start a call sound (loops until stop). choice: "builtin:<id>", a sound file's URL, or "builtin:none". */
export function startSound(choice: string | null | undefined, kind: SoundKind): { stop: () => void } {
  const pick = choice || DEFAULT_SOUND[kind];
  if (pick === "builtin:none") return { stop() {} };
  let stopped = false;
  let backup: { stop: () => void } | null = null;
  const el = ringEl ?? new Audio();
  const go = (src: string | null) => {
    if (stopped) return;
    if (!src) { backup = webAudio(builtinOf(pick, kind), true); return; }
    el.src = src; el.loop = true; el.volume = 0.9;
    void el.play().catch(() => {                   // blocked or a broken file: the built-in one, the other way
      if (!stopped) backup = webAudio(builtinOf(/^https?:/.test(pick) ? DEFAULT_SOUND[kind] : pick, kind), true);
    });
  };
  if (/^https?:\/\//.test(pick)) go(pick);
  else void builtinClip(builtinOf(pick, kind), true).then(go);
  return { stop() { stopped = true; el.pause(); el.loop = false; backup?.stop(); } };
}

/** A message sound, once (a file plays up to 4 s). */
export function playOnce(choice: string | null | undefined, kind: SoundKind = "message") {
  const pick = choice || DEFAULT_SOUND[kind];
  if (pick === "builtin:none") return;
  const el = msgEl ?? new Audio();
  const go = (src: string | null) => {
    if (!src) { webAudio(builtinOf(pick, kind), false); return; }
    el.src = src; el.loop = false; el.volume = 0.9; el.currentTime = 0;
    void el.play().catch(() => webAudio(builtinOf(/^https?:/.test(pick) ? DEFAULT_SOUND[kind] : pick, kind), false));
    setTimeout(() => { if (el.src === src) el.pause(); }, 4000);
  };
  if (/^https?:\/\//.test(pick)) go(pick);
  else void builtinClip(builtinOf(pick, kind), false).then(go);
}

/** Play a sound once or twice to hear it (Settings -> Sounds). Stops after a few seconds. */
export function previewSound(choice: string, kind: SoundKind) {
  if (kind === "message") { playOnce(choice, kind); return { stop() {} }; }
  const s = startSound(choice, kind);
  setTimeout(() => s.stop(), 4000);
  return s;
}
