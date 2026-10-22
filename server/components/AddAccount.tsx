"use client";
// "Add an account" in a small window: sign in with Jace or Minecraft without leaving the app, then
// switch to it (the account you were using stays in the switcher - lib/accounts.ts).
import { useState } from "react";
import { rememberAccount, switchAccount } from "@/lib/accounts";
import { api, desktopReady, inDesktop, type Me } from "@/lib/client";
import { hasAgreed, LegalDialog } from "./Legal";
import { MinecraftDevice } from "./MinecraftDevice";
import { Modal } from "./ui";

export function AddAccountModal({ me, onClose }: { me: Me; onClose: () => void }) {
  const [step, setStep] = useState<"pick" | "minecraft" | "legal">(hasAgreed() ? "pick" : "legal");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  /** Signed in: remember the new account on this device and switch to it. */
  async function done(token: string) {
    try {
      const r = await fetch("/api/v1/me", { headers: { Authorization: `Bearer ${token}` } });
      const m = await r.json() as Me & { error?: string };
      if (!r.ok) throw new Error(m.error ?? "Couldn't sign in");
      if (m.uuid === me.uuid) { setNote(""); setError("That's the account you're using now. Sign in with a different one."); return; }
      rememberAccount({ uuid: m.uuid, name: m.name, avatar_url: m.avatar_url, is_bot: m.is_bot }, token);
      switchAccount(m.uuid);
    } catch (e) { setNote(""); setError((e as Error).message); }
  }

  async function withJace() {
    setError(""); setNote("Sign in with Jace in the tab that opened…");
    try {
      const r = await api<{ url: string; state: string; poll_key: string }>("/auth/jace", { body: {} });
      window.open(r.url, "_blank", "noopener");
      for (let i = 0; i < 150; i++) {                       // up to 5 minutes
        await new Promise((ok) => setTimeout(ok, 2000));
        const d = await fetch(`/api/v1/auth/jace/poll?state=${r.state}&key=${r.poll_key}`).then((x) => x.json());
        if (d.error) throw new Error(d.error);
        if (!d.pending) { await done(d.token); return; }
      }
      setNote(""); setError("Signing in timed out - try again");
    } catch (e) { setNote(""); setError((e as Error).message); }
  }

  async function withMinecraft() {
    setError("");
    if (!inDesktop()) { setStep("minecraft"); return; }
    setNote("Sign in with Microsoft in the window that opened…");
    const d = await desktopReady();
    const r = d ? await d.signInMinecraft() : { error: "The desktop app isn't ready yet - try again" };
    if (r.token) await done(r.token); else { setNote(""); setError(r.error ?? "Sign-in failed"); }
  }

  if (step === "legal") return <LegalDialog onClose={onClose} onAgree={() => setStep("pick")} />;
  return (
    <Modal onClose={onClose}>
      {step === "minecraft" ? (
        <div className="modal-body">
          <MinecraftDevice<{ token: string }> mode="signin" onCancel={() => setStep("pick")} onDone={(r) => void done(r.token)} />
          {error && <p className="error">{error}</p>}
        </div>
      ) : <>
        <div className="modal-body">
          <h2>Add an account</h2>
          <p className="muted" style={{ margin: 0 }}>Sign in to another account. You can switch back any time in Settings → Accounts.</p>
          <button className="btn primary" onClick={withJace}>Sign in with Jace</button>
          <button className="btn" onClick={withMinecraft}>⛏ Sign in with Minecraft</button>
          {note && <p className="muted small" style={{ margin: 0 }}>{note}</p>}
          {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
        </div>
        <div className="modal-foot"><button className="btn" onClick={onClose}>Cancel</button></div>
      </>}
    </Modal>
  );
}
