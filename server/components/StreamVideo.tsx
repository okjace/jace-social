"use client";
// A camera or screen share in a call or voice room. It always plays: muted is set on the element
// itself (React sets it too late for the browser's autoplay rule, so a re-attached video could sit
// dark and paused - right-click showed "Play"), and play() is called again whenever the video
// becomes ready, a track resumes, or something pauses it. Sound plays separately (lib/calls.ts, voice.ts).
import { useEffect, useRef } from "react";

export function StreamVideo({ stream, mirror, className }: { stream: MediaStream; mirror?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.muted = true;
    el.playsInline = true;
    if (el.srcObject !== stream) el.srcObject = stream;
    const play = () => { if (el.paused && el.srcObject) void el.play().catch(() => {}); };
    play();
    const tracks = () => stream.getVideoTracks();
    el.addEventListener("loadedmetadata", play);
    el.addEventListener("canplay", play);
    el.addEventListener("pause", play);          // nothing here should ever stay paused
    stream.addEventListener("addtrack", play);
    for (const t of tracks()) t.addEventListener("unmute", play);
    const visible = () => { if (!document.hidden) play(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      el.removeEventListener("loadedmetadata", play);
      el.removeEventListener("canplay", play);
      el.removeEventListener("pause", play);
      stream.removeEventListener("addtrack", play);
      for (const t of tracks()) t.removeEventListener("unmute", play);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted className={className}
    style={mirror ? { transform: "scaleX(-1)" } : undefined}
    onDoubleClick={(e) => void e.currentTarget.requestFullscreen?.().catch(() => {})}
    onContextMenu={(e) => e.preventDefault()} />;
}
