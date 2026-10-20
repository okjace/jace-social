"use client";
// A one-time prompt for Jace-linked people whose Jace messages aren't connected yet (they signed
// in before Jace Social could sync them), or need reconnecting (lib/jaceSync.ts).
import { useEffect, useState } from "react";
import type { Me } from "@/lib/client";

const KEY = "jace.connectMessagesAsked";

export function ConnectJaceMessages({ me, onOpen }: { me: Me; onOpen: () => void }) {
  const [hidden, setHidden] = useState(true);
  const m = me.jace_messages;
  const want = !!m?.available && (m.state === "none" || m.state === "disconnected");
  const asked = `${KEY}.${me.uuid}.${m?.state}`;
  useEffect(() => {
    let seen = false;
    try { seen = localStorage.getItem(asked) === "1"; } catch { /* private mode: ask each visit */ }
    setHidden(!want || seen);
  }, [want, asked]);
  if (hidden) return null;
  const close = () => { try { localStorage.setItem(asked, "1"); } catch { /* fine */ } setHidden(true); };
  return (
    <div className="new-version" role="status" style={{ top: 64 }}>
      <span>💬 {m!.state === "none" ? "Bring your Jace messages here." : "Your Jace messages stopped syncing."}</span>
      <button className="btn primary small" onClick={() => { close(); onOpen(); }}>
        {m!.state === "none" ? "Connect your Jace messages" : "Reconnect Jace"}</button>
      <button className="icon-btn" aria-label="Not now" onClick={close}>✕</button>
    </div>
  );
}
