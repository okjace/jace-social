"use client";
// Voice calls in the browser and the desktop app. Same signalling as Jace Launcher
// (POST /calls offer/answer/hangup, live "call" events), so anyone can call anyone.
// Like the launcher, each side sends its full description once ICE gathering is done
// (no trickle), and audio goes straight between players or through the TURN relay.
import { api } from "./client";
import { deviceProblem, getCamera, getMic, markMove, readStreams, tagStreams, type StreamKinds } from "./media";

export type CallState = "idle" | "calling" | "ringing" | "in-call";
export type CallInfo = {
  state: CallState; peer: string; peerName: string; muted: boolean; startedAt: number | null; noMic: boolean;
  sharing: boolean; remoteScreen: MediaStream | null;     // screen sharing (renegotiated mid-call)
  camera: MediaStream | null; remoteCamera: MediaStream | null;   // video: yours (for the preview) and theirs
};
type Signal = { id: number; kind: string; call_id: string; from: string; name?: string };

const IDLE: CallInfo = { state: "idle", peer: "", peerName: "", muted: false, startedAt: null, noMic: false, sharing: false, remoteScreen: null,
  camera: null, remoteCamera: null };

function newCallId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class Calls {
  info: CallInfo = IDLE;
  private callId = "";
  private offerSdp = "";
  private pc: RTCPeerConnection | null = null;
  private mic: MediaStream | null = null;
  private screen: MediaStream | null = null;
  private screenSenders: RTCRtpSender[] = [];
  private camera: MediaStream | null = null;
  private cameraSenders: RTCRtpSender[] = [];
  private remoteKinds: StreamKinds = {};
  private making = false;          // an offer is being made or waiting for its answer...
  private pending = false;         // ...so this change goes out after it
  private callerSide = false;      // we placed the call (we keep our change if both change at once)
  private moving = false;          // taking over our call from another device (see takeOver)
  private audio = new Map<string, HTMLAudioElement>();   // their voice, and their screen's sound
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private ring: { stop: () => void } | null = null;
  private listeners = new Set<(i: CallInfo) => void>();

  /** onEnded(reason) is shown to the user as a toast. */
  constructor(private onEnded: (reason: string) => void, private onIncoming: (name: string) => void) {}

  subscribe(fn: (i: CallInfo) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  static supported() { return typeof window !== "undefined" && "RTCPeerConnection" in window && !!navigator.mediaDevices?.getUserMedia; }

  async call(uuid: string, name: string) {
    if (!Calls.supported()) return this.onEnded("Voice calls don't work in this browser");
    if (this.info.state !== "idle") return this.onEnded("You're already in a call");
    this.callId = newCallId();
    this.callerSide = true;
    const id = this.callId;
    this.set({ ...IDLE, state: "calling", peer: uuid, peerName: name });
    this.ring = tone("outgoing");
    try {
      const pc = await this.newPeer(id);
      const sdp = await describe(pc, await pc.createOffer());
      if (this.callId !== id) return;
      await api("/calls", { body: { to: uuid, call_id: id, kind: "offer", sdp } });
      this.startTimeout();
    } catch (e) {
      if (this.callId === id) this.end((e as Error).message);
    }
  }

  /** Take over a call we're in on another device (Jace Launcher can't show video, so it sends
   *  people here). Same call id; their side swaps connections without ringing, and the other
   *  device drops out when it sees their answer. */
  async takeOver(uuid: string, name: string, callId: string) {
    if (!Calls.supported() || this.info.state !== "idle" || !/^[A-Za-z0-9_-]{8,64}$/.test(callId)) return;
    this.callId = callId;
    this.callerSide = true;
    this.moving = true;
    this.set({ ...IDLE, state: "calling", peer: uuid, peerName: name || "A friend" });
    try {
      const pc = await this.newPeer(callId);
      // room for their camera and screen (with its sound): an answer can't add what the offer lacks
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      const sdp = markMove(await describe(pc, await pc.createOffer()));
      if (this.callId !== callId) return;
      await api("/calls", { body: { to: uuid, call_id: callId, kind: "offer", sdp } });
      this.timeout = setTimeout(() => { if (this.moving && this.info.state === "calling") this.end("Couldn't move the call here - it's still going on in Jace Launcher"); }, 20_000);
    } catch (e) {
      if (this.callId === callId) this.end((e as Error).message);   // not hangUp: the call goes on where it was
    }
  }

  async answer() {
    if (this.info.state !== "ringing") return;
    const { peer } = this.info;
    const id = this.callId;
    this.stopRing();
    this.clearTimeout();
    this.set({ ...this.info, state: "in-call", startedAt: Date.now() });
    try {
      const pc = await this.newPeer(id);
      await pc.setRemoteDescription({ type: "offer", sdp: this.offerSdp });
      const sdp = await describe(pc, await pc.createAnswer());
      if (this.callId !== id) return;
      await api("/calls", { body: { to: peer, call_id: id, kind: "answer", sdp } });
    } catch (e) {
      if (this.callId === id) this.hangUp((e as Error).message);
    }
  }

  hangUp(reason = "") {
    if (this.info.state === "idle") return;
    void api("/calls", { body: { to: this.info.peer, call_id: this.callId, kind: "hangup" } }).catch(() => {});
    this.end(reason);
  }

  /** Share your screen in the call (or stop): adds/removes a video track and renegotiates. */
  async toggleScreen() {
    const pc = this.pc;
    if (!pc || this.info.state !== "in-call") return;
    if (this.screen) {
      this.screen.getTracks().forEach((t) => t.stop());
      for (const sender of this.screenSenders) { try { pc.removeTrack(sender); } catch { /* closed */ } }
      this.screen = null;
      this.screenSenders = [];
      this.set({ ...this.info, sharing: false });
    } else {
      try { this.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true }); } catch { return; }
      this.screen.getVideoTracks()[0]?.addEventListener("ended", () => { if (this.screen) void this.toggleScreen(); });
      this.screenSenders = this.screen.getTracks().map((t) => pc.addTrack(t, this.screen!));
      this.set({ ...this.info, sharing: true });
    }
    await this.renegotiate();
  }

  /** Turn your camera on or off in the call (adds/removes a video track and renegotiates). */
  async toggleCamera() {
    const pc = this.pc;
    if (!pc || this.info.state !== "in-call") return;
    if (this.camera) {
      this.camera.getTracks().forEach((t) => t.stop());
      for (const sender of this.cameraSenders) { try { pc.removeTrack(sender); } catch { /* closed */ } }
      this.camera = null;
      this.cameraSenders = [];
      this.set({ ...this.info, camera: null });
    } else {
      try { this.camera = await getCamera(); } catch (e) { this.onEnded(deviceProblem(e, "camera")); return; }
      this.cameraSenders = this.camera.getTracks().map((t) => pc.addTrack(t, this.camera!));
      this.set({ ...this.info, camera: this.camera });
    }
    await this.renegotiate();
  }

  /** No microphone when the call started: try again, and send it (reusing the receive-only audio slot). */
  async retryMic() {
    const pc = this.pc;
    if (!pc || this.mic || this.info.state !== "in-call") return;
    try { this.mic = await getMic(); } catch (e) { this.onEnded(deviceProblem(e, "microphone")); return; }
    this.mic.getAudioTracks().forEach((t) => { t.enabled = !this.info.muted; pc.addTrack(t, this.mic!); });
    this.set({ ...this.info, noMic: false });
    await this.renegotiate();
  }

  /** A new description mid-call, saying which of our streams is the camera and which the screen. */
  private async renegotiate() {
    const pc = this.pc;
    if (!pc) return;
    if (this.making || pc.signalingState !== "stable") { this.pending = true; return; }
    this.making = true;
    try {
      const sdp = tagStreams(await describe(pc, await pc.createOffer()), { camera: this.camera?.id, screen: this.screen?.id });
      await api("/calls", { body: { to: this.info.peer, call_id: this.callId, kind: "renegotiate", sdp } });
    } catch (e) {
      this.onEnded((e as Error).message);
    } finally {
      this.making = false;
    }
  }

  toggleMute() {
    if (this.info.noMic) { void this.retryMic(); return; }
    const muted = !this.info.muted;
    this.mic?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    this.set({ ...this.info, muted });
  }

  /** A live "call" event from the player's channel. */
  async onSignal(e: Signal) {
    if (e.kind === "offer") {
      try {
        const { signal } = await api<{ signal: { sdp: string; sender: string; name: string } }>(`/calls?id=${e.id}`);
        if (this.info.state === "in-call" && e.call_id === this.callId && signal.sender === this.info.peer) {
          await this.replace(signal.sdp);         // they moved our call to another of their devices
          return;
        }
        if (readStreams(signal.sdp).moving) return;   // someone else's call moving between devices: not for us
        if (this.info.state !== "idle") {          // busy: tell them
          void api("/calls", { body: { to: signal.sender, call_id: e.call_id, kind: "hangup" } }).catch(() => {});
          return;
        }
        this.callId = e.call_id;
        this.offerSdp = signal.sdp;
        this.set({ ...IDLE, state: "ringing", peer: signal.sender, peerName: signal.name || e.name || "A friend" });
        this.ring = tone("incoming");
        this.startTimeout();
        this.onIncoming(this.info.peerName);
      } catch { /* the offer expired */ }
    } else if (e.call_id !== this.callId) {
      return;
    } else if (e.kind === "answer" && this.info.state === "calling") {
      this.stopRing();
      this.clearTimeout();
      this.moving = false;
      this.set({ ...this.info, state: "in-call", startedAt: Date.now() });
      try {
        const { signal } = await api<{ signal: { sdp: string } }>(`/calls?id=${e.id}`);
        const { sdp, kinds } = readStreams(signal.sdp);
        this.remoteKinds = kinds;
        await this.pc?.setRemoteDescription({ type: "answer", sdp });
      } catch (err) {
        this.hangUp((err as Error).message);
      }
    } else if (e.kind === "renegotiate" && this.pc) {
      // the other side turned their camera or screen sharing on or off
      try {
        const { signal } = await api<{ signal: { sdp: string } }>(`/calls?id=${e.id}`);
        const pc = this.pc;
        const { sdp: offer, kinds, noYield } = readStreams(signal.sdp);
        if (pc.signalingState !== "stable" || this.making) {
          // both changed something at once: the caller keeps its offer, the one who answered gives way
          // (Jace Launcher can't give way, so we always do)
          if (this.info.state === "in-call" && this.callerSide && !noYield) return;
          if (pc.signalingState === "have-local-offer") await pc.setLocalDescription({ type: "rollback" });
          this.pending = true;
        }
        this.remoteKinds = kinds;
        await pc.setRemoteDescription({ type: "offer", sdp: offer });
        if (!kinds.camera && this.info.remoteCamera) this.set({ ...this.info, remoteCamera: null });
        if (!kinds.screen && this.info.remoteScreen) this.set({ ...this.info, remoteScreen: null });
        const sdp = await describe(pc, await pc.createAnswer());
        await api("/calls", { body: { to: this.info.peer, call_id: this.callId, kind: "reanswer", sdp } });
        if (this.pending) { this.pending = false; setTimeout(() => void this.renegotiate(), 300); }
      } catch (err) { console.warn("renegotiate", err); }
    } else if (e.kind === "reanswer" && this.pc?.signalingState === "have-local-offer") {
      try {
        const { signal } = await api<{ signal: { sdp: string } }>(`/calls?id=${e.id}`);
        await this.pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        if (this.pending) { this.pending = false; void this.renegotiate(); }   // a change that waited for this answer
      } catch (err) { console.warn("reanswer", err); }
    } else if (e.kind === "answer" && this.info.state === "in-call" && !this.moving) {
      this.end("Moved the call to another device");   // another of our devices took this call over
    } else if (e.kind === "hangup") {
      const n = this.info.peerName;
      this.end(this.info.state === "in-call" ? `${n} hung up` : this.info.state === "calling" ? `${n} didn't pick up` : "");
    }
  }

  // -- internals
  /** Answer a moved call on a new connection, keeping our camera and screen share going. */
  private async replace(offerSdp: string) {
    const id = this.callId;
    const old = this.pc, oldMic = this.mic;
    const { sdp: offer, kinds } = readStreams(offerSdp);
    this.remoteKinds = kinds;
    this.making = this.pending = false;
    this.callerSide = false;
    this.set({ ...this.info, remoteCamera: null, remoteScreen: null });
    try {
      const pc = await this.newPeer(id);
      old?.close();
      for (const el of this.audio.values()) el.srcObject = null;
      this.audio.clear();
      if (oldMic !== this.mic) oldMic?.getTracks().forEach((t) => t.stop());
      await pc.setRemoteDescription({ type: "offer", sdp: offer });
      if (this.camera) this.cameraSenders = this.camera.getTracks().map((t) => pc.addTrack(t, this.camera!));
      if (this.screen) this.screenSenders = this.screen.getTracks().map((t) => pc.addTrack(t, this.screen!));
      const sdp = tagStreams(await describe(pc, await pc.createAnswer()), { camera: this.camera?.id, screen: this.screen?.id });
      if (this.callId !== id) return;
      await api("/calls", { body: { to: this.info.peer, call_id: id, kind: "answer", sdp } });
    } catch (err) {
      if (this.callId === id) this.hangUp((err as Error).message);
    }
  }

  /** The connection for call `id`, with the microphone added; throws if the call ended meanwhile. */
  private async newPeer(id: string) {
    const { ice_servers } = await api<{ ice_servers: RTCIceServer[] }>("/calls/ice");
    let mic: MediaStream | null = null;
    try {
      mic = await getMic();
    } catch (e) {                                    // you can still listen - but say why
      this.onEnded(`${deviceProblem(e, "microphone")} You can still hear them.`);
    }
    if (this.callId !== id) { mic?.getTracks().forEach((t) => t.stop()); throw new Error("Call ended"); }
    const pc = new RTCPeerConnection({ iceServers: ice_servers });
    this.pc = pc;
    this.mic = mic;
    if (mic) mic.getAudioTracks().forEach((t) => { t.enabled = !this.info.muted; pc.addTrack(t, mic); });
    else pc.addTransceiver("audio", { direction: "recvonly" });
    this.set({ ...this.info, noMic: !mic });
    pc.ontrack = (ev) => {
      if (ev.track.kind === "video") {
        const s = ev.streams[0] ?? new MediaStream([ev.track]);
        const key = s.id === this.remoteKinds.camera ? "remoteCamera" : "remoteScreen";
        this.set({ ...this.info, [key]: s });
        const gone = () => { if (this.info[key] === s) this.set({ ...this.info, [key]: null }); };
        ev.track.addEventListener("ended", gone);
        // not on "mute": that also happens when frames stop for a moment (a slow connection), and taking
        // the video away then made it come back dark. Turning a camera off is told by the next offer.
        ev.track.addEventListener("unmute", () => { if (this.info[key] !== s) this.set({ ...this.info, [key]: s }); });
        return;
      }
      const s = ev.streams[0] ?? new MediaStream([ev.track]);
      let el = this.audio.get(s.id);
      if (!el) { el = new Audio(); el.autoplay = true; this.audio.set(s.id, el); }
      el.srcObject = s;
      void el.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (this.pc === pc && pc.connectionState === "failed") this.hangUp("Couldn't connect the call");
    };
    return pc;
  }

  private startTimeout() {
    this.clearTimeout();
    this.timeout = setTimeout(() => {
      if (this.info.state === "calling") this.hangUp("No answer");
      else if (this.info.state === "ringing") this.end("");   // they gave up or it was answered elsewhere
    }, 45_000);
  }
  private clearTimeout() { if (this.timeout) clearTimeout(this.timeout); this.timeout = null; }
  private stopRing() { this.ring?.stop(); this.ring = null; }

  private end(reason: string) {
    this.clearTimeout();
    this.stopRing();
    this.pc?.close();
    this.pc = null;
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.screen?.getTracks().forEach((t) => t.stop());
    this.screen = null;
    this.screenSenders = [];
    this.camera?.getTracks().forEach((t) => t.stop());
    this.camera = null;
    this.cameraSenders = [];
    this.remoteKinds = {};
    this.making = this.pending = this.callerSide = this.moving = false;
    for (const el of this.audio.values()) el.srcObject = null;
    this.audio.clear();
    this.callId = "";
    this.offerSdp = "";
    this.set(IDLE);
    if (reason) this.onEnded(reason);
  }

  private set(i: CallInfo) {
    this.info = i;
    for (const fn of this.listeners) fn(i);
  }
}

/** setLocalDescription, then wait (up to 5 s) for every ICE candidate to be in the description. */
async function describe(pc: RTCPeerConnection, desc: RTCSessionDescriptionInit): Promise<string> {
  await pc.setLocalDescription(desc);
  if (pc.iceGatheringState !== "complete") {
    await new Promise<void>((ok) => {
      const t = setTimeout(ok, 5000);
      pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); ok(); } });
    });
  }
  const sdp = pc.localDescription?.sdp;
  if (!sdp) throw new Error("Couldn't start the call");
  return sdp;
}

/** A soft ringing sound: two short beeps every 2 s (incoming), or one longer tone (outgoing). */
function tone(kind: "incoming" | "outgoing"): { stop: () => void } {
  let ctx: AudioContext | null = null;
  try { ctx = new AudioContext(); } catch { return { stop() {} }; }
  const beep = (at: number, len: number, freq: number) => {
    const o = ctx!.createOscillator();
    const g = ctx!.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.08, at + 0.02);
    g.gain.setValueAtTime(0.08, at + len - 0.05);
    g.gain.linearRampToValueAtTime(0, at + len);
    o.connect(g).connect(ctx!.destination);
    o.start(at);
    o.stop(at + len);
  };
  const play = () => {
    if (!ctx) return;
    const t = ctx.currentTime + 0.05;
    if (kind === "incoming") { beep(t, 0.25, 880); beep(t + 0.35, 0.25, 880); } else beep(t, 0.9, 440);
  };
  play();
  const timer = setInterval(play, kind === "incoming" ? 2000 : 3000);
  return { stop() { clearInterval(timer); void ctx?.close(); ctx = null; } };
}
