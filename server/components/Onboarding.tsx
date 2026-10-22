"use client";
// First-time setup for new accounts, and a server's onboarding when you join it.
import { useState } from "react";
import { api, type Me, type ServerDetail, type Settings } from "@/lib/client";
import { ACCENTS, applySettings, THEME_NAMES } from "@/lib/theme";
import { Markdown } from "./Markdown";
import { AddFriendForm } from "./AddFriend";
import { Avatar, Modal } from "./ui";

type Err = (m: string) => void;

export function Welcome({ me, onDone, onSaved, onError, onJoinServer }: {
  me: Me; onDone: () => void; onSaved: (m: Me) => void; onError: Err; onJoinServer: () => void;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState(me.display_name ?? "");
  const [settings, setSettings] = useState<Settings>({ theme: "dark", accent: null, ...me.settings });
  const [friend, setFriend] = useState("");
  const [sent, setSent] = useState<string[]>([]);
  const steps = ["You", "Look", "Friends", "Servers"];

  const pickTheme = (patch: Settings) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    applySettings(next);
  };
  async function finish() {
    try { onSaved(await api<Me>("/me", { method: "PATCH", body: { onboarded: true, settings } })); } catch (e) { onError((e as Error).message); }
    onDone();
  }
  async function next() {
    try {
      if (step === 0 && name.trim() !== (me.display_name ?? "")) onSaved(await api<Me>("/me", { method: "PATCH", body: { display_name: name.trim() } }));
      if (step === 1) onSaved(await api<Me>("/me", { method: "PATCH", body: { settings } }));
    } catch (e) { onError((e as Error).message); return; }
    if (step === steps.length - 1) return finish();
    setStep(step + 1);
  }

  return (
    <Modal onClose={finish}>
      <div className="modal-body onboarding">
        <div className="steps">{steps.map((s, i) => <span key={s} className={i === step ? "on" : i < step ? "done" : ""}>{s}</span>)}</div>
        {step === 0 && <>
          <h2>Welcome to Jace Social, {me.name}!</h2>
          <p className="muted" style={{ margin: 0 }}>Friends, chat, servers and voice, with Minecraft built in. Let's set you up. It takes a minute.</p>
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <Avatar p={me} size={72} />
            <label className="btn small" style={{ textTransform: "none", color: "var(--text)", fontSize: 13 }}>
              Choose a picture<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try { await api("/me/avatar", { raw: f }); onSaved(await api<Me>("/me")); } catch (err) { onError((err as Error).message); }
              }} /></label>
          </div>
          <label>Display name (what friends see)<input value={name} maxLength={32} placeholder={me.name} onChange={(e) => setName(e.target.value)} /></label>
        </>}
        {step === 1 && <>
          <h2>Make it yours</h2>
          <label>Theme</label>
          <div className="theme-grid">
            {THEME_NAMES.map(([id, label, bg]) => (
              <button key={id} className={`theme-card${(settings.theme ?? "dark") === id ? " on" : ""}`} onClick={() => pickTheme({ theme: id })}>
                <span className="theme-swatch" style={{ background: bg }} />{label}
              </button>
            ))}
          </div>
          <label>Accent color</label>
          <div className="swatches">
            {ACCENTS.map((c) => <button key={c} className={`swatch${(settings.accent ?? "#3ddc84") === c ? " on" : ""}`} style={{ background: c }} onClick={() => pickTheme({ accent: c })} />)}
            <input type="color" value={settings.accent ?? "#3ddc84"} onChange={(e) => pickTheme({ accent: e.target.value })} style={{ width: 40, padding: 2 }} />
          </div>
          <p className="muted small" style={{ margin: 0 }}>You can change all of this later in Settings → Appearance.</p>
        </>}
        {step === 2 && <>
          <h2>Find your friends</h2>
          <p className="muted" style={{ margin: 0 }}>Type <b>#</b> and a friend&apos;s Minecraft username, or <b>@</b> and their handle or Jace name, to send them a request. It works even if they haven&apos;t joined yet.</p>
          <AddFriendForm value={friend} onChange={setFriend} onSend={async (n) => {
            try { const r = await api<{ friend: { name: string } }>("/friends", { body: { name: n } }); setSent([...sent, r.friend.name]); setFriend(""); }
            catch (err) { onError((err as Error).message); }
          }} />
          {sent.map((s) => <div key={s} className="small" style={{ color: "var(--green)" }}>✓ Request sent to {s}</div>)}
        </>}
        {step === 3 && <>
          <h2>Join a server</h2>
          <p className="muted" style={{ margin: 0 }}>Servers are places for groups: text channels, voice rooms, roles and bots. Make one for your friends, or join one with an invite link.</p>
          <button className="btn primary" onClick={() => { void finish(); onJoinServer(); }}>Create or join a server</button>
        </>}
      </div>
      <div className="modal-foot">
        {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}>Back</button>}
        <button className="btn" onClick={finish}>Skip</button>
        <button className="btn primary" onClick={next}>{step === steps.length - 1 ? "Finish" : "Next"}</button>
      </div>
    </Modal>
  );
}

/** A server's onboarding: rules, questions that give roles, then the welcome screen. */
export function ServerOnboarding({ detail, onDone, onOpenChannel, onError }: {
  detail: ServerDetail; onDone: () => void; onOpenChannel: (id: string) => void; onError: Err;
}) {
  const s = detail.server;
  const questions = s.onboarding ?? [];
  const [agreed, setAgreed] = useState(false);
  const [answers, setAnswers] = useState<number[][]>(questions.map(() => []));
  const [step, setStep] = useState<"rules" | "questions" | "welcome">(s.rules ? "rules" : questions.length ? "questions" : "welcome");
  async function submit() {
    try {
      await api(`/servers/${s.id}/onboarding`, { body: { answers, agreed: agreed || !s.rules } });
      setStep("welcome");
    } catch (e) { onError((e as Error).message); }
  }
  const welcomeChannels = (s.welcome?.channels ?? []).map((w) => ({ ...w, channel: detail.channels.find((c) => c.id === w.id) })).filter((w) => w.channel);
  return (
    <Modal onClose={() => (step === "welcome" || detail.onboarded ? onDone() : undefined)}>
      {s.banner_url && <div className="profile-banner" style={{ background: `center / cover url(${s.banner_url})` }} />}
      <div className="modal-body onboarding">
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Avatar p={{ name: s.name, avatar_url: s.icon_url }} size={48} />
          <div><h2>Welcome to {s.name}</h2>{s.description && <div className="muted small">{s.description}</div>}</div>
        </div>
        {step === "rules" && <>
          <label>Server rules</label>
          <div className="card rules"><Markdown text={s.rules ?? ""} mentions={{ people: {}, roles: detail.roles }} /></div>
          <label className="check"><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> I've read and agree to the rules</label>
        </>}
        {step === "questions" && questions.map((q, i) => (
          <div key={i} style={{ display: "grid", gap: 8 }}>
            <b>{q.question}</b>{q.multiple && <span className="muted small">Pick any that fit</span>}
            <div className="answer-grid">
              {q.options.map((o, k) => {
                const on = answers[i]?.includes(k);
                return <button key={k} className={`answer${on ? " on" : ""}`} onClick={() => setAnswers(answers.map((a, j) => j !== i ? a : q.multiple ? (on ? a.filter((x) => x !== k) : [...a, k]) : [k]))}>
                  {o.emoji && <span>{o.emoji}</span>} {o.label}</button>;
              })}
            </div>
          </div>
        ))}
        {step === "welcome" && <>
          {s.welcome?.message && <p style={{ margin: 0 }}>{s.welcome.message}</p>}
          {welcomeChannels.map((w) => (
            <button key={w.id} className="welcome-channel" onClick={() => { onOpenChannel(w.id); onDone(); }}>
              <span className="welcome-emoji">{w.emoji || "#"}</span>
              <span className="grow"><b>#{w.channel!.name}</b>{w.description && <span className="muted small">{w.description}</span>}</span>
              <span>›</span>
            </button>
          ))}
        </>}
      </div>
      <div className="modal-foot">
        {step === "rules" && <button className="btn primary" disabled={!agreed} onClick={() => (questions.length ? setStep("questions") : void submit())}>Continue</button>}
        {step === "questions" && <button className="btn primary" onClick={submit}>Finish</button>}
        {step === "welcome" && <button className="btn primary" onClick={onDone}>Let's go</button>}
      </div>
    </Modal>
  );
}
