"use client";
// Find people: look anyone up by @handle, name, Jace or Minecraft name, and open their profile.
// Shows your friends, people who let anyone find them, and the exact @handle you type
// (app/api/v1/users/route.ts).
import { useEffect, useState } from "react";
import { api, type Person } from "@/lib/client";
import { Avatar } from "./ui";
import { BotTag } from "./JaceBot";

export function FindPeople({ onOpen, back }: { onOpen: (uuid: string) => void; back: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<(Person & { is_friend?: boolean })[] | null>(null);
  useEffect(() => {
    const term = q.trim().replace(/^[@#]/, "");
    if (term.length < 2) { setResults(null); return; }
    const t = setTimeout(() => {
      api<{ users: (Person & { is_friend?: boolean })[] }>(`/users?q=${encodeURIComponent(term)}`).then((r) => setResults(r.users)).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return <>
    <div className="main-head">
      <button className="icon-btn mobile-only" onClick={back}>‹</button>
      <span className="title">🔎 Find people</span>
      <span className="topic">Look someone up and see their profile</span>
    </div>
    <div className="list">
      <input autoFocus value={q} maxLength={40} placeholder="@handle, name, Jace or Minecraft name" onChange={(e) => setQ(e.target.value)} />
      {results === null ? <p className="muted small">Type at least 2 letters. People show up here if they let anyone find them (or you&apos;re friends) - type someone&apos;s exact @handle to find anyone.</p>
        : results.length === 0 ? <p className="muted">Nobody found. Try their exact @handle.</p>
        : results.map((p) => (
          <button key={p.uuid} className="person-row lookup-row" onClick={() => onOpen(p.uuid)}>
            <Avatar p={p} size={40} />
            <span className="grow" style={{ textAlign: "left", minWidth: 0 }}>
              <b>{p.name}</b> <BotTag p={p} />
              <span className="muted small" style={{ display: "block" }}>
                {[p.handle && `@${p.handle}`, p.minecraft_name && `⛏ ${p.minecraft_name}`, p.is_friend && "Friend"].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="muted small">View profile ›</span>
          </button>
        ))}
    </div>
  </>;
}
