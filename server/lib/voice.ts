"use client";
// Voice rooms (server voice channels and group calls): everyone in the room connects to
// everyone else with WebRTC (a mesh, fine up to ~8 people). The one who joins starts the
// connections. Screen sharing adds a video track and renegotiates each connection; if
// two people renegotiate at once, the one with the smaller id gives way ("polite peer").
// Like direct calls, each description is sent once ICE gathering is done (no trickle).
import { api } from "./client";
import { describeWhenReady, deviceProblem, getCamera, getMic, hasRelay, readStreams, tagStreams, type StreamKinds } from "./media";

export type Participant = { uuid: string; muted: boolean; deafened: boolean; streaming: boolean; person?: { name: string; avatar_url: string | null } };
export type RoomState = {
  channelId: string | null; serverId: string | null; channelName: string;
  participants: Participant[]; muted: boolean; deafened: boolean; sharing: boolean; noMic: boolean;
  speaking: Record<string, boolean>; screens: Record<string, MediaStream>; connecting: boolean;
  camera: boolean; cameras: Record<string, MediaStream>;      // who has their camera on (you included)
  canVideo: boolean;                                         // the "Video" permission: camera and screen sharing
};

type Peer = {
  pc: RTCPeerConnection; audio: HTMLAudioElement; screen: MediaStream | null; screenSenders: RTCRtpSender[];
  cameraSenders: RTCRtpSender[]; kinds: StreamKinds;       // which of their streams is the camera / screen
  making: boolean; pending: boolean;                        // one change at a time; pending = send another after the answer
};

const EMPTY: RoomState = { channelId: null, serverId: null, channelName: "", participants: [], muted: false, deafened: false,
  sharing: false, noMic: false, speaking: {}, screens: {}, connecting: false, camera: false, cameras: {}, canVideo: true };

/** Our description, as soon as it has usable network routes (lib/media.ts describeWhenReady). */
function described(pc: RTCPeerConnection, desc: RTCSessionDescriptionInit) {
  return describeWhenReady(pc, desc, hasRelay(pc.getConfiguration().iceServers ?? []));
}

export class Voice {
  state: RoomState = EMPTY;
  private me = "";
  private peers = new Map<string, Peer>();
  private mic: MediaStream | null = null;
  private screen: MediaStream | null = null;
  private cam: MediaStream | null = null;
  private ice: RTCIceServer[] = [];
  private beat: ReturnType<typeof setInterval> | null = null;
  private meter: ReturnType<typeof setInterval> | null = null;
  private audioCtx: AudioContext | null = null;
  private analysers = new Map<string, AnalyserNode>();
  private seen = new Set<number>();
  private lastSeen = 0;
  private joinedAfter = 0;                        // signals up to this id were there before we joined
  private catchTimer: ReturnType<typeof setInterval> | null = null;
  private catching = false;
  private listeners = new Set<(s: RoomState) => void>();

  constructor(private onError: (m: string) => void) {}

  subscribe(fn: (s: RoomState) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private set(patch: Partial<RoomState>) { this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn(this.state); }

  async join(me: string, channelId: string, serverId: string | null, channelName: string) {
    if (this.state.channelId === channelId) return;
    if (this.state.channelId) await this.leave();
    this.me = me;
    this.set({ ...EMPTY, channelId, serverId, channelName, connecting: true });
    try {
      const [{ ice_servers }, room] = await Promise.all([
        api<{ ice_servers: RTCIceServer[] }>("/calls/ice"),
        api<{ participants: Participant[]; can_speak: boolean; can_stream?: boolean }>(`/channels/${channelId}/voice`, { body: { action: "join" } }),
      ]);
      this.ice = ice_servers;
      try {
        this.mic = await getMic();
        if (!room.can_speak) this.mic.getAudioTracks().forEach((t) => { t.enabled = false; });
        this.watchLevel(me, this.mic);
      } catch (e) {
        this.set({ noMic: true });
        this.onError(`${deviceProblem(e, "microphone")} You can still listen.`);   // say why, not just a crossed-out mic
      }
      // signals left from an earlier visit to this room: note them, never act on them
      const old = await api<{ latest: number }>(`/voice/signal?channel_id=${encodeURIComponent(channelId)}&latest=1`).catch(() => ({ latest: 0 }));
      this.joinedAfter = old.latest;
      this.lastSeen = Math.max(this.lastSeen, old.latest);
      this.set({ participants: room.participants, muted: !room.can_speak, connecting: false, canVideo: room.can_stream !== false });
      // the one who joins connects to everyone already here
      for (const p of room.participants) if (p.uuid !== me) await this.call(p.uuid);
      this.beat = setInterval(() => void this.sendState({}), 20_000);
      // signals whose live event was missed (someone shown in the room but never connected)
      this.catchTimer = setInterval(() => void this.catchUp(), 3000);
      this.meter = setInterval(() => this.measure(), 150);
    } catch (e) {
      this.onError((e as Error).message);
      await this.leave();
    }
  }

  async leave() {
    const id = this.state.channelId;
    if (this.beat) clearInterval(this.beat);
    if (this.meter) clearInterval(this.meter);
    if (this.catchTimer) clearInterval(this.catchTimer);
    this.beat = this.meter = this.catchTimer = null;
    this.lastSeen = this.joinedAfter = 0;
    for (const uuid of [...this.peers.keys()]) this.dropPeer(uuid);
    this.mic?.getTracks().forEach((t) => t.stop());
    this.screen?.getTracks().forEach((t) => t.stop());
    this.cam?.getTracks().forEach((t) => t.stop());
    this.mic = this.screen = this.cam = null;
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.analysers.clear();
    this.set(EMPTY);
    if (id) await api(`/channels/${id}/voice`, { body: { action: "leave" } }).catch(() => {});
  }

  async toggleMute() {
    void this.audioCtx?.resume().catch(() => {});
    if (this.state.noMic) { await this.retryMic(); return; }
    const muted = !this.state.muted;
    this.mic?.getAudioTracks().forEach((t) => { t.enabled = !muted && !this.state.deafened; });
    this.set({ muted });
    await this.sendState({ muted });
  }

  /** No microphone when joining (not allowed, busy, unplugged): try again, and start sending it. */
  async retryMic() {
    if (!this.state.channelId || this.mic) return;
    try { this.mic = await getMic(); } catch (e) { this.onError(deviceProblem(e, "microphone")); return; }
    const muted = this.state.muted;                     // (still muted if you can't speak in this room)
    this.mic.getAudioTracks().forEach((t) => { t.enabled = !muted && !this.state.deafened; });
    this.watchLevel(this.me, this.mic);
    this.set({ noMic: false, muted });
    for (const [uuid, peer] of this.peers) {
      // reuses the receive-only audio slot each connection was made with
      this.mic.getAudioTracks().forEach((t) => peer.pc.addTrack(t, this.mic!));
      await this.renegotiate(uuid);
    }
    await this.sendState({ muted });
  }

  async toggleDeafen() {
    void this.audioCtx?.resume().catch(() => {});
    const deafened = !this.state.deafened;
    for (const p of this.peers.values()) p.audio.muted = deafened;
    this.mic?.getAudioTracks().forEach((t) => { t.enabled = !deafened && !this.state.muted; });
    this.set({ deafened });
    await this.sendState({ deafened });
  }

  async toggleScreen() {
    if (this.state.sharing) return this.stopScreen();
    try {
      this.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    } catch {
      return;   // they cancelled the picker
    }
    this.screen.getVideoTracks()[0]?.addEventListener("ended", () => void this.stopScreen());
    this.set({ sharing: true, screens: { ...this.state.screens, [this.me]: this.screen } });
    for (const [uuid, peer] of this.peers) {
      peer.screenSenders = this.screen.getTracks().map((t) => peer.pc.addTrack(t, this.screen!));
      await this.renegotiate(uuid);
    }
    await this.sendState({ streaming: true });
  }

  /** Turn your camera on or off for everyone in the room. */
  async toggleCamera() {
    if (!this.state.channelId) return;
    if (this.cam) {
      this.cam.getTracks().forEach((t) => t.stop());
      this.cam = null;
      const cameras = { ...this.state.cameras };
      delete cameras[this.me];
      this.set({ camera: false, cameras });
      for (const [uuid, peer] of this.peers) {
        for (const s of peer.cameraSenders) { try { peer.pc.removeTrack(s); } catch { /* closed */ } }
        peer.cameraSenders = [];
        await this.renegotiate(uuid);
      }
      return;
    }
    try { this.cam = await getCamera(); } catch (e) { this.onError(deviceProblem(e, "camera")); return; }
    this.set({ camera: true, cameras: { ...this.state.cameras, [this.me]: this.cam } });
    for (const [uuid, peer] of this.peers) {
      peer.cameraSenders = this.cam.getTracks().map((t) => peer.pc.addTrack(t, this.cam!));
      await this.renegotiate(uuid);
    }
  }

  async stopScreen() {
    if (!this.screen) return;
    this.screen.getTracks().forEach((t) => t.stop());
    this.screen = null;
    const screens = { ...this.state.screens };
    delete screens[this.me];
    this.set({ sharing: false, screens });
    for (const [uuid, peer] of this.peers) {
      for (const s of peer.screenSenders) { try { peer.pc.removeTrack(s); } catch { /* closed */ } }
      peer.screenSenders = [];
      await this.renegotiate(uuid);
    }
    await this.sendState({ streaming: false });
  }

  /** Live "voice" event: who's in the room changed. */
  async refresh() {
    if (!this.state.channelId) return;
    try {
      const { participants } = await api<{ participants: Participant[] }>(`/channels/${this.state.channelId}/voice`);
      if (!participants.some((p) => p.uuid === this.me)) { await this.leave(); return; }     // kicked or timed out
      for (const uuid of [...this.peers.keys()]) if (!participants.some((p) => p.uuid === uuid)) this.dropPeer(uuid);
      this.set({ participants });
    } catch { /* next event */ }
  }

  /** Live "voice_signal" event: an offer or answer from someone in the room. */
  async onSignal(e: { id: number; from: string; kind: string; channel_id: string }) {
    if (e.channel_id !== this.state.channelId) return;
    if (this.seen.has(e.id) || e.id <= this.joinedAfter) return;   // handled already (live event + catch-up), or from before we joined
    this.seen.add(e.id);
    this.lastSeen = Math.max(this.lastSeen, e.id);
    try {
      const { signal } = await api<{ signal: { sdp: string; kind: string } }>(`/voice/signal?id=${e.id}`);
      if (signal.kind === "offer") {
        const isNew = !this.peers.has(e.from);
        const peer = this.peers.get(e.from) ?? this.newPeer(e.from);
        const pc = peer.pc;
        const { sdp: offer, kinds, noYield } = readStreams(signal.sdp);
        if (pc.signalingState !== "stable" || peer.making) {
          // both sides changed something at once: the bigger id keeps its offer (the other side
          // answers it), the smaller id gives way and sends its own change again afterwards
          // (Jace Launcher can't give way, so we always do)
          if (this.me > e.from && !noYield) return;
          if (pc.signalingState === "have-local-offer") await pc.setLocalDescription({ type: "rollback" });
          peer.pending = true;
        }
        peer.kinds = kinds;
        await pc.setRemoteDescription({ type: "offer", sdp: offer });
        if (!kinds.camera) this.clearVideo("cameras", e.from);
        if (!kinds.screen) this.clearVideo("screens", e.from);
        const sdp = tagStreams(await described(pc, await pc.createAnswer()), { camera: this.cam?.id, screen: this.screen?.id });
        await api("/voice/signal", { body: { channel_id: this.state.channelId, to: e.from, kind: "answer", sdp } });
        // they joined while our camera or screen was on (their offer had no room for our video),
        // or our own change gave way to theirs: offer ours now
        if ((isNew && (this.cam || this.screen)) || peer.pending) {
          peer.pending = false;
          setTimeout(() => void this.renegotiate(e.from), 300);
        }
      } else {
        const peer = this.peers.get(e.from);
        if (peer && peer.pc.signalingState === "have-local-offer") {
          const { sdp: answer, kinds } = readStreams(signal.sdp);
          peer.kinds = { ...peer.kinds, ...kinds };
          await peer.pc.setRemoteDescription({ type: "answer", sdp: answer });
          if (peer.pending) { peer.pending = false; void this.renegotiate(e.from); }   // a change that waited for this answer
        }
      }
    } catch (err) {
      console.warn("voice signal", err);
    }
  }

  private async catchUp() {
    const id = this.state.channelId;
    if (!id || this.catching) return;
    this.catching = true;
    try {
      const { signals } = await api<{ signals: { id: number; from: string; kind: string; channel_id: string }[] }>(
        `/voice/signal?channel_id=${encodeURIComponent(id)}&after=${this.lastSeen}`);
      for (const s of signals) if (this.state.channelId === id) await this.onSignal(s);
    } catch { /* next time */ } finally { this.catching = false; }
  }

  // -- internals
  private newPeer(uuid: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    const audio = new Audio();
    audio.autoplay = true;
    audio.muted = this.state.deafened;
    const peer: Peer = { pc, audio, screen: null, screenSenders: [], cameraSenders: [], kinds: {}, making: false, pending: false };
    if (this.mic) this.mic.getAudioTracks().forEach((t) => pc.addTrack(t, this.mic!));
    else pc.addTransceiver("audio", { direction: "recvonly" });
    if (this.screen) peer.screenSenders = this.screen.getTracks().map((t) => pc.addTrack(t, this.screen!));
    if (this.cam) peer.cameraSenders = this.cam.getTracks().map((t) => pc.addTrack(t, this.cam!));
    pc.ontrack = (ev) => {
      if (ev.track.kind === "audio" && !peer.audio.srcObject) {
        const s = ev.streams[0] ?? new MediaStream([ev.track]);
        peer.audio.srcObject = s;
        void peer.audio.play().catch(() => {});
        this.watchLevel(uuid, s);
      } else if (ev.track.kind === "video") {
        const s = ev.streams[0] ?? new MediaStream([ev.track]);
        const which = s.id === peer.kinds.camera ? "cameras" : "screens";
        if (which === "screens") peer.screen = s;
        this.set({ [which]: { ...this.state[which], [uuid]: s } });
        ev.track.addEventListener("ended", () => this.clearVideo(which, uuid));
        s.addEventListener("removetrack", () => { if (!s.getVideoTracks().length) this.clearVideo(which, uuid); });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") { this.dropPeer(uuid); void this.call(uuid); }   // try once more
    };
    this.peers.set(uuid, peer);
    return peer;
  }

  private clearVideo(which: "screens" | "cameras", uuid: string) {
    if (!this.state[which][uuid]) return;
    const next = { ...this.state[which] };
    delete next[uuid];
    this.set({ [which]: next });
  }

  private clearScreen(uuid: string) {
    this.clearVideo("screens", uuid);
  }

  private async call(uuid: string) {
    if (this.peers.has(uuid)) return;
    const peer = this.newPeer(uuid);
    await this.renegotiate(uuid, peer);
  }

  /** Send our current camera/screen/mic setup to one person. One change at a time: while an
   *  offer is out (or being made), another change just marks it as pending. */
  private async renegotiate(uuid: string, peer = this.peers.get(uuid)) {
    if (!peer || !this.state.channelId) return;
    if (peer.making || peer.pc.signalingState !== "stable") { peer.pending = true; return; }
    peer.making = true;
    try {
      const sdp = tagStreams(await described(peer.pc, await peer.pc.createOffer()), { camera: this.cam?.id, screen: this.screen?.id });
      await api("/voice/signal", { body: { channel_id: this.state.channelId, to: uuid, kind: "offer", sdp } });
    } catch (e) {
      console.warn("voice offer", e);
    } finally {
      peer.making = false;
    }
  }

  private dropPeer(uuid: string) {
    const p = this.peers.get(uuid);
    if (!p) return;
    p.pc.close();
    p.audio.srcObject = null;
    this.peers.delete(uuid);
    this.analysers.delete(uuid);
    this.clearScreen(uuid);
    this.clearVideo("cameras", uuid);
  }

  private async sendState(patch: { muted?: boolean; deafened?: boolean; streaming?: boolean }) {
    if (!this.state.channelId) return;
    await api(`/channels/${this.state.channelId}/voice`, { body: { action: "state", ...patch } }).catch((e) => this.onError(e.message));
  }

  private watchLevel(uuid: string, stream: MediaStream) {
    try {
      this.audioCtx ??= new AudioContext();
      const src = this.audioCtx.createMediaStreamSource(stream);
      const an = this.audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      this.analysers.set(uuid, an);
    } catch { /* no level meter */ }
  }

  private measure() {
    if (this.audioCtx?.state === "suspended") void this.audioCtx.resume().catch(() => {});   // made before a click: the meters read 0
    const speaking: Record<string, boolean> = {};
    const buf = new Uint8Array(256);
    for (const [uuid, an] of this.analysers) {
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      speaking[uuid] = peak > 10 && !(uuid === this.me && (this.state.muted || this.state.deafened));
    }
    if (JSON.stringify(speaking) !== JSON.stringify(this.state.speaking)) this.set({ speaking });
  }
}
