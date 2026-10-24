"use client";
// Settings -> Voice & video: which microphone and camera to use (saved on this device - lib/media.ts),
// a level meter to check the microphone hears you, and a camera preview.
import { useEffect, useRef, useState } from "react";
import { chooseDevice, chosenCamera, chosenMic, deviceProblem, getCamera, getMic } from "@/lib/media";
import { StreamVideo } from "./StreamVideo";

type Dev = { deviceId: string; label: string };

export function VoiceSettings() {
  const [mics, setMics] = useState<Dev[]>([]);
  const [cams, setCams] = useState<Dev[]>([]);
  const [mic, setMic] = useState(chosenMic());
  const [cam, setCam] = useState(chosenCamera());
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [error, setError] = useState("");
  const stop = useRef<() => void>(() => {});

  async function list() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const named = (d: MediaDeviceInfo, i: number, what: string) => ({ deviceId: d.deviceId, label: d.label || `${what} ${i + 1}` });
      setMics(all.filter((d) => d.kind === "audioinput").map((d, i) => named(d, i, "Microphone")));
      setCams(all.filter((d) => d.kind === "videoinput").map((d, i) => named(d, i, "Camera")));
    } catch { /* no device list */ }
  }
  useEffect(() => {
    void list();
    navigator.mediaDevices?.addEventListener?.("devicechange", list);
    return () => { navigator.mediaDevices?.removeEventListener?.("devicechange", list); stop.current(); };
  }, []);

  async function testMic() {
    stop.current(); setError("");
    if (testing) { setTesting(false); return; }
    try {
      const s = await getMic();
      await list();                                  // names show up once allowed
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(s).connect(an);
      const buf = new Uint8Array(256);
      const timer = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(Math.min(1, peak / 64));
      }, 80);
      stop.current = () => { clearInterval(timer); s.getTracks().forEach((t) => t.stop()); void ctx.close(); setLevel(0); setTesting(false); };
      setTesting(true);
    } catch (e) { setError(deviceProblem(e, "microphone")); }
  }

  async function previewCam() {
    setError("");
    if (preview) { preview.getTracks().forEach((t) => t.stop()); setPreview(null); return; }
    try { const s = await getCamera(); setPreview(s); await list(); } catch (e) { setError(deviceProblem(e, "camera")); }
  }
  useEffect(() => () => { preview?.getTracks().forEach((t) => t.stop()); }, [preview]);

  return <>
    <h2>Voice & video</h2>
    <p className="muted" style={{ margin: 0 }}>Used for calls and voice channels on this device.</p>
    <label>Microphone
      <select value={mic} onChange={(e) => { setMic(e.target.value); chooseDevice("mic", e.target.value); if (testing) { stop.current(); } }}>
        <option value="">Default</option>
        {mics.filter((d) => d.deviceId && d.deviceId !== "default").map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
      </select>
    </label>
    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
      <button className="btn small" onClick={() => void testMic()}>{testing ? "Stop test" : "🎙️ Test my mic"}</button>
      <div className="mic-meter" aria-label="Microphone level"><div style={{ width: `${Math.round(level * 100)}%` }} /></div>
    </div>
    {testing && <p className="muted small" style={{ margin: 0 }}>Talk: the bar should move. If it doesn&apos;t, pick another microphone.</p>}
    <label>Camera
      <select value={cam} onChange={(e) => { setCam(e.target.value); chooseDevice("camera", e.target.value); if (preview) { preview.getTracks().forEach((t) => t.stop()); setPreview(null); } }}>
        <option value="">Default</option>
        {cams.filter((d) => d.deviceId && d.deviceId !== "default").map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
      </select>
    </label>
    <button className="btn small" style={{ justifySelf: "start" }} onClick={() => void previewCam()}>{preview ? "Stop preview" : "📷 Preview my camera"}</button>
    {preview && <div className="cam-preview"><StreamVideo stream={preview} mirror /></div>}
    {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
    <p className="muted small" style={{ margin: 0 }}>Changes apply to the next call or voice channel you join.</p>
  </>;
}
