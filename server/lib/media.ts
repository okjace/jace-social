"use client";
// Camera and screen share both arrive as video, so each description we send says which of
// our streams is which, in one extra line ("a=x-jace-streams:camera=<id>,screen=<id>").
// The receiver reads and removes that line before handing the description to the browser.
// Stream ids survive the trip (they're the "msid" in the description), so the receiver can
// match each incoming video to its kind.
// An offer can also carry "a=x-jace-move": the call is moving to another of the caller's devices
// (e.g. from Jace Launcher, which is voice only, to here to see video), so it replaces the call
// in progress instead of ringing.
// "a=x-jace-noyield" comes from Jace Launcher, which can't take back an offer it sent: when both
// sides change something at once, the other side always gives way to it.

export type StreamKinds = { camera?: string; screen?: string };

const TAG = "a=x-jace-streams:";
const MOVE = "a=x-jace-move";
const NO_YIELD = "a=x-jace-noyield";

export function tagStreams(sdp: string, kinds: StreamKinds): string {
  const parts = Object.entries(kinds).filter(([, id]) => id).map(([k, id]) => `${k}=${id}`);
  if (!parts.length) return sdp;
  return sdp.replace(/\r?\n?$/, "\r\n") + `${TAG}${parts.join(",")}\r\n`;
}

export function markMove(sdp: string): string {
  return sdp.replace(/\r?\n?$/, "\r\n") + `${MOVE}\r\n`;
}

export function readStreams(sdp: string): { sdp: string; kinds: StreamKinds; moving: boolean; noYield: boolean } {
  const kinds: StreamKinds = {};
  let moving = false, noYield = false;
  const lines = sdp.split(/\r?\n/).filter((line) => {
    if (line === MOVE) { moving = true; return false; }
    if (line === NO_YIELD) { noYield = true; return false; }
    if (!line.startsWith(TAG)) return !line.startsWith("a=x-jace-");   // other tags (from a newer version): not for the browser
    for (const part of line.slice(TAG.length).split(",")) {
      const [k, id] = part.split("=");
      if ((k === "camera" || k === "screen") && id) kinds[k] = id.trim();
    }
    return false;
  });
  return { sdp: lines.join("\r\n"), kinds, moving, noYield };
}

// --- your microphone and camera (Settings -> Voice & video picks which; saved on this device)
const MIC_KEY = "jace_social_mic", CAM_KEY = "jace_social_camera";
const read = (k: string) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
export const chosenMic = () => read(MIC_KEY);
export const chosenCamera = () => read(CAM_KEY);
export function chooseDevice(kind: "mic" | "camera", deviceId: string) {
  try { if (deviceId) localStorage.setItem(kind === "mic" ? MIC_KEY : CAM_KEY, deviceId); else localStorage.removeItem(kind === "mic" ? MIC_KEY : CAM_KEY); } catch { /* */ }
}

/** getUserMedia with the chosen device, or the default one if that's gone (unplugged). */
async function withDevice(kind: "audio" | "video", deviceId: string, base: MediaTrackConstraints): Promise<MediaStream> {
  const ask = (c: MediaTrackConstraints) => navigator.mediaDevices.getUserMedia(kind === "audio" ? { audio: c, video: false } : { video: c, audio: false });
  if (deviceId) {
    try { return await ask({ ...base, deviceId: { exact: deviceId } }); }
    catch (e) { if (!["OverconstrainedError", "NotFoundError"].includes((e as Error).name)) throw e; }
  }
  return ask(base);
}

/** Your microphone (the chosen one), cleaned up for talking. */
export function getMic(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(Object.assign(new Error("no mediaDevices"), { name: "NotSupportedError" }));
  return withDevice("audio", chosenMic(), { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
}

/**
 * Your microphone stopped mid-call (phones: the browser went to the background or the screen locked,
 * another app or a phone call took the microphone, iOS interrupted audio) - you'd stay silent for the
 * rest of the call. Gets it again and puts it in place of the dead one in `senders` (no reconnecting).
 * -> the new microphone, or null if it's still fine or can't be had right now.
 */
export async function reviveMic(old: MediaStream | null, senders: RTCRtpSender[], enabled: boolean): Promise<MediaStream | null> {
  const dead = old?.getAudioTracks()[0];
  if (!dead || (dead.readyState !== "ended" && !dead.muted)) return null;
  let fresh: MediaStream;
  try { fresh = await getMic(); } catch { return null; }
  const track = fresh.getAudioTracks()[0];
  if (!track) return null;
  track.enabled = enabled;
  for (const s of senders) if (s.track === dead) await s.replaceTrack(track).catch(() => {});
  dead.stop();
  return fresh;
}

/** Calls `onDead` when the microphone stops by itself, or when you come back to the page and it's silent. */
export function onMicDead(stream: MediaStream, onDead: () => void): () => void {
  const track = stream.getAudioTracks()[0];
  if (!track) return () => {};
  const visible = () => { if (!document.hidden && (track.readyState === "ended" || track.muted)) onDead(); };
  track.addEventListener("ended", onDead);
  document.addEventListener("visibilitychange", visible);
  return () => { track.removeEventListener("ended", onDead); document.removeEventListener("visibilitychange", visible); };
}

/**
 * Your speakers or headphones changed (plugged in or out; Bluetooth headphones switching to their call
 * mode when the microphone opens and back). Settled changes only: `fn` runs once things are quiet.
 */
export function onOutputsChanged(fn: () => void): () => void {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!md?.addEventListener) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const changed = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; fn(); }, 700); };
  md.addEventListener("devicechange", changed);
  return () => { md.removeEventListener("devicechange", changed); if (timer) clearTimeout(timer); };
}

/**
 * Start watching for speakers/headphones changing; `wait()` resolves once they've settled. Opening the
 * microphone makes Bluetooth headphones switch to their call mode: everything playing then goes silent
 * for a few seconds while they switch (seen with a soundcore Space One on PipeWire). Make it before
 * opening the microphone, then wait() before starting a sound that should be heard from the start.
 * No change reported: wait() still takes 1.2 s (the headphones may switch without one; theirs took about 1 s).
 */
export function outputsSettle(): { wait: () => Promise<void> } {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  let last = 0;
  const on = () => { last = Date.now(); };
  md?.addEventListener?.("devicechange", on);
  return {
    wait: () => new Promise<void>((resolve) => {
      const start = Date.now();
      const check = () => {
        const now = Date.now();
        const quiet = last ? now - last >= 2500 : now - start >= 1200;
        if (quiet || now - start >= 5000) { md?.removeEventListener?.("devicechange", on); resolve(); }
        else setTimeout(check, 100);
      };
      check();
    }),
  };
}

/** Play a call's sound again from scratch, so it comes out of the output in use now (see onOutputsChanged). */
export function reattachAudio(el: HTMLAudioElement) {
  const s = el.srcObject;
  if (!s) return;
  el.srcObject = null;
  el.srcObject = s;
  void el.play().catch(() => {});
}

/** Your camera, at a size that's fine for several people at once. */
export function getCamera(): Promise<MediaStream> {
  return withDevice("video", chosenCamera(), { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } });
}

/** Why the microphone or camera didn't start, in words people can act on. */
export function deviceProblem(e: unknown, what: "microphone" | "camera"): string {
  const name = (e as Error)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return `Jace Social isn't allowed to use your ${what}. Allow it in your browser's site settings (or your computer's privacy settings), then try again.`;
  if (name === "NotFoundError" || name === "OverconstrainedError") return `No ${what} was found. Plug one in, or pick another in Settings → Voice & video.`;
  if (name === "NotReadableError" || name === "AbortError") return `Your ${what} couldn't start - another app may be using it. Close that app, then try again.`;
  if (name === "NotSupportedError") return `This browser can't use a ${what} here (it needs https).`;
  return `Couldn't start your ${what}${(e as Error)?.message ? ` (${(e as Error).message})` : ""}.`;
}

export const canUseCamera = () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/**
 * Set our description and wait just long enough for usable network routes (ICE candidates) to be in
 * it: we send whole descriptions (no trickle - Jace Launcher needs them whole), and waiting for the
 * browser to finish gathering took up to 5 s a side on many computers (VPN, Docker or IPv6
 * interfaces never "complete") - ~10 s of silence before a call's audio started. Now: done when
 * gathering completes, or shortly after the first internet-reachable route (a relay one when a TURN
 * relay is set up, since strict networks need it), and never longer than maxMs.
 */
export async function describeWhenReady(pc: RTCPeerConnection, desc: RTCSessionDescriptionInit, wantRelay: boolean, maxMs = 3000): Promise<string> {
  await pc.setLocalDescription(desc);
  if (pc.iceGatheringState !== "complete") {
    await new Promise<void>((ok) => {
      let soon: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        clearTimeout(max); if (soon) clearTimeout(soon);
        pc.removeEventListener("icecandidate", onCandidate);
        pc.removeEventListener("icegatheringstatechange", onState);
        ok();
      };
      const max = setTimeout(finish, maxMs);
      const onState = () => { if (pc.iceGatheringState === "complete") finish(); };
      const onCandidate = (ev: RTCPeerConnectionIceEvent) => {
        if (!ev.candidate) { finish(); return; }                 // the end of the list
        const type = ev.candidate.type ?? / typ (\w+)/.exec(ev.candidate.candidate)?.[1];
        if (soon) return;
        if (type === "relay") soon = setTimeout(finish, 150);
        else if (type === "srflx" && !wantRelay) soon = setTimeout(finish, 400);
      };
      pc.addEventListener("icecandidate", onCandidate);
      pc.addEventListener("icegatheringstatechange", onState);
    });
  }
  const sdp = pc.localDescription?.sdp;
  if (!sdp) throw new Error("Couldn't start the call");
  return sdp;
}

/** Do these ICE servers include a TURN relay? */
export const hasRelay = (servers: RTCIceServer[]) =>
  servers.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/.test(u)));
