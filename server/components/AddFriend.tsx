"use client";
// The add-friend box: "#name" is a Minecraft player, "@name" a handle or Jace account. A name without
// either asks which one it is (the server takes the prefix: app/api/v1/friends/route.ts).
import { useState } from "react";

export function AddFriendForm({ value, onChange, onSend, busy }: {
  value: string; onChange: (v: string) => void; onSend: (name: string) => void; busy?: boolean;
}) {
  const [ask, setAsk] = useState<string | null>(null);
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    if (/^[#@]./.test(v)) { setAsk(null); onSend(v); } else setAsk(v);
  };
  return <>
    <form style={{ display: "flex", gap: 8 }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <input placeholder="#MinecraftName or @handle" value={value} maxLength={34}
        onChange={(e) => { setAsk(null); onChange(e.target.value); }} />
      <button className="btn primary" disabled={!value.trim() || busy}>Send request</button>
    </form>
    {ask && (
      <div className="card ask-kind">
        <span>Is <b>{ask}</b> a Minecraft or a Jace account?</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn small" onClick={() => { setAsk(null); onSend(`#${ask}`); }}>⛏ Minecraft</button>
          <button className="btn small" onClick={() => { setAsk(null); onSend(`@${ask}`); }}>Jace (@handle)</button>
          <button className="btn small" onClick={() => setAsk(null)}>Cancel</button>
        </div>
        <span className="muted small">Next time, start with # for Minecraft or @ for Jace.</span>
      </div>
    )}
  </>;
}
