"use client";
// The floating voice call panel: ringing, calling, and in a call.
import { StreamVideo } from "./StreamVideo";
import { useEffect, useRef, useState } from "react";
import type { Person } from "@/lib/client";
import type { CallInfo, Calls } from "@/lib/calls";
import { canUseCamera } from "@/lib/media";
import { Avatar } from "./ui";

export function useCall(calls: Calls): CallInfo {
  const [info, setInfo] = useState(calls.info);
  useEffect(() => calls.subscribe(setInfo), [calls]);
  return info;
}

export function CallPanel({ calls, info, people }: { calls: Calls; info: CallInfo; people: Record<string, Person> }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (info.state !== "in-call") return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [info.state]);
  if (info.state === "idle") return null;

  const p = people[info.peer] ?? { name: info.peerName };
  const secs = info.startedAt ? Math.floor((Date.now() - info.startedAt) / 1000) : 0;
  const line = info.state === "ringing" ? "Incoming voice call"
    : info.state === "calling" ? "Calling…"
    : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}${info.noMic ? " · no microphone" : ""}`;

  return (
    <div className="call-panel" role="dialog" aria-label="Voice call">
      {(info.remoteCamera || info.camera) && (
        <div className="call-cams">
          {info.remoteCamera && <Video stream={info.remoteCamera} className="call-cam" label={p.name} />}
          {info.camera && <Video stream={info.camera} className={`call-cam self${info.remoteCamera ? " pip" : ""}`} label="You" muted mirror />}
        </div>
      )}
      {info.remoteScreen && <RemoteScreen stream={info.remoteScreen} name={p.name} />}
      <Avatar p={p} size={44} />
      <div className="call-who"><b>{p.name}</b><span>{line}{info.sharing ? " · sharing your screen" : ""}</span></div>
      {info.state === "ringing" ? <>
        <button className="btn primary small" onClick={() => void calls.answer()}>Answer</button>
        <button className="btn danger small" onClick={() => calls.hangUp()}>Decline</button>
      </> : <>
        {info.state === "in-call" && (info.noMic
          ? <button className="btn small danger" onClick={() => calls.toggleMute()} title="Your microphone didn't start - click to try again">🎙️ Try my mic again</button>
          : <button className="btn small" onClick={() => calls.toggleMute()} aria-pressed={info.muted}>{info.muted ? "Unmute" : "Mute"}</button>)}
        {info.state === "in-call" && canUseCamera() &&
          <button className={`btn small${info.camera ? " primary" : ""}`} onClick={() => void calls.toggleCamera()} title={info.camera ? "Turn off camera" : "Turn on camera"}>📷</button>}
        {info.state === "in-call" && typeof navigator !== "undefined" && "getDisplayMedia" in (navigator.mediaDevices ?? {}) &&
          <button className={`btn small${info.sharing ? " primary" : ""}`} onClick={() => void calls.toggleScreen()} title="Share your screen">🖥️</button>}
        <button className="btn danger small" onClick={() => calls.hangUp()}>{info.state === "calling" ? "Cancel" : "Hang up"}</button>
      </>}
    </div>
  );
}

function RemoteScreen({ stream, name }: { stream: MediaStream; name: string }) {
  return (
    <div className="call-screen">
      <StreamVideo stream={stream} className="call-video" />
      <span className="muted small">🖥️ {name}'s screen · double-click for full screen</span>
    </div>
  );
}

function Video({ stream, className, label, muted, mirror }: { stream: MediaStream; className: string; label: string; muted?: boolean; mirror?: boolean }) {
  void muted;                                    // videos are always muted (their sound plays separately)
  return (
    <div className={className}>
      <StreamVideo stream={stream} mirror={mirror} />
      <span className="cam-label">{label}</span>
    </div>
  );
}
