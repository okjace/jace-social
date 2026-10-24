"use client";
// Call sounds: the ringtone (someone's calling you) and the calling sound (you're calling them).
// Built-in ones are made here with Web Audio; custom ones are audio files people upload (their own,
// or shared in the community library - app/api/v1/sounds). The choice is in your settings
// (ringtone / calling_sound: "builtin:<id>" or a sound file's URL).
//
// Phones (iPhone Safari especially) only play sound after you've touched the page: unlockSounds()
// hooks the first tap or key press to unlock both Web Audio and an audio element, which the ringing
// then reuses - otherwise a call could ring in silence.

export type SoundKind = "ringtone" | "calling";
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
  { id: "classic", name: "Classic", period: 2000, play: (c, t) => { note(c, t, 0.25, 880); note(c, t + 0.35, 0.25, 880); } },
  { id: "dial", name: "Dial tone", period: 3000, play: (c, t) => { note(c, t, 0.9, 440, "sine", 0.07); } },
  { id: "chime", name: "Chime", period: 2400, play: (c, t) => { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(c, t + i * 0.14, 0.6, f)); } },
  { id: "marimba", name: "Marimba", period: 1800, play: (c, t) => { [784, 988, 784, 1175].forEach((f, i) => note(c, t + i * 0.12, 0.3, f, "triangle", 0.12)); } },
  { id: "retro", name: "Retro", period: 2000, play: (c, t) => { [660, 880, 660, 990, 1320].forEach((f, i) => note(c, t + i * 0.09, 0.08, f, "square", 0.04)); } },
  { id: "soft", name: "Soft", period: 3200, play: (c, t) => { note(c, t, 1.4, 392, "sine", 0.06); note(c, t + 0.2, 1.2, 587.33, "sine", 0.04); } },
  { id: "pulse", name: "Pulse", period: 1500, play: (c, t) => { note(c, t, 0.12, 1000, "square", 0.03); note(c, t + 0.2, 0.12, 1000, "square", 0.03); note(c, t + 0.4, 0.12, 1000, "square", 0.03); } },
];
export const DEFAULT_SOUND: Record<SoundKind, string> = { ringtone: "builtin:classic", calling: "builtin:dial" };

let ctx: AudioContext | null = null;
let el: HTMLAudioElement | null = null;
const audioCtx = () => { try { ctx ??= new AudioContext(); } catch { /* none */ } return ctx; };

/** Once, early: the first tap/click/key unlocks sound for later (phones need this). */
export function unlockSounds() {
  if (typeof window === "undefined") return;
  const unlock = () => {
    void audioCtx()?.resume().catch(() => {});
    el ??= new Audio();
    el.muted = true;
    el.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
    void el.play().then(() => { el!.pause(); el!.muted = false; }).catch(() => { if (el) el.muted = false; });
    for (const e of ["pointerdown", "touchend", "keydown"]) window.removeEventListener(e, unlock, true);
  };
  for (const e of ["pointerdown", "touchend", "keydown"]) window.addEventListener(e, unlock, true);
}

/** Start a call sound (loops until stop). choice: "builtin:<id>", a sound file's URL, or "builtin:none". */
export function startSound(choice: string | null | undefined, kind: SoundKind): { stop: () => void } {
  const pick = choice || DEFAULT_SOUND[kind];
  if (pick === "builtin:none") return { stop() {} };
  if (/^https?:\/\//.test(pick)) {
    const a = el ?? new Audio();
    a.src = pick;
    a.loop = true;
    a.volume = 0.8;
    a.currentTime = 0;
    let stopped = false;
    void a.play().catch(() => {                    // couldn't play the file (blocked or broken): the built-in one
      if (!stopped) fallback = startSound(DEFAULT_SOUND[kind], kind);
    });
    let fallback: { stop: () => void } | null = null;
    return { stop() { stopped = true; a.pause(); a.loop = false; fallback?.stop(); } };
  }
  const b = BUILTIN.find((x) => `builtin:${x.id}` === pick) ?? BUILTIN.find((x) => `builtin:${x.id}` === DEFAULT_SOUND[kind])!;
  const c = audioCtx();
  if (!c) return { stop() {} };
  void c.resume().catch(() => {});
  const play = () => b.play(c, c.currentTime + 0.05);
  play();
  const timer = setInterval(play, b.period);
  return { stop() { clearInterval(timer); } };
}

/** Play a sound once or twice to hear it (Settings -> Sounds). Stops after a few seconds. */
export function previewSound(choice: string, kind: SoundKind) {
  const s = startSound(choice, kind);
  setTimeout(() => s.stop(), 4000);
  return s;
}
