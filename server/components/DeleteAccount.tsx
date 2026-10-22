"use client";
// Deleting your account, from the button in the Jace bot's answer (lib/accountDeletion.ts):
// sign in again to show it's you -> "Are you sure?" -> the recovery ID (shown once, works 10 days).
import { useEffect, useState } from "react";
import { forgetAccount } from "@/lib/accounts";
import { api, desktopReady, inDesktop, setToken, type Me } from "@/lib/client";
import { MinecraftDevice } from "./MinecraftDevice";
import { Modal } from "./ui";

type Fresh = { token: string; uuid: string };
type Recovery = { recovery_id: string; expires_at: string };
const RECOVERY_KEY = "jace_social_recovery";
/** This tab is deleting its account: it shows the recovery ID itself (SocialApp ignores "signed_out"). */
let deleting = false;
export const isDeletingAccount = () => deleting;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** Calls the API as the session from signing in again (not the one the app is using). */
async function as<T>(token: string, path: string, method = "GET"): Promise<T> {
  const r = await fetch(`/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: method === "POST" ? "{}" : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `Error ${r.status}`);
  return d as T;
}

/** In the Jace bot's answer to "delete my account" (its message has DELETE_MARK), or, with now,
 *  "... ([DELETE-NOW])" (DELETE_NOW_MARK): deleted right away and for good. */
export function DeleteAccountButton({ now = false }: { now?: boolean }) {
  const [me, setMe] = useState<Me | null>(null);
  return <>
    <button className={`btn danger small${now ? " solid-danger" : ""}`} style={{ marginTop: 6 }}
      onClick={() => api<Me>("/me").then(setMe).catch((e) => alert((e as Error).message))}>
      🗑 {now ? "Delete my account now…" : "Delete my account…"}</button>
    {me && <DeleteAccount me={me} now={now} onClose={() => setMe(null)} />}
  </>;
}

function DeleteAccount({ me, now, onClose }: { me: Me; now: boolean; onClose: () => void }) {
  const [step, setStep] = useState<"verify" | "minecraft" | "sure">("verify");
  const [fresh, setFresh] = useState<Fresh | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  /** A new session: only good if it's this same account. */
  async function verified(token: string) {
    const who = await as<{ uuid: string }>(token, "/me").catch(() => null);
    if (who?.uuid !== me.uuid) {
      await as(token, "/auth/signout", "POST").catch(() => {});
      setNote(""); setError("That signed in to a different account. Sign in with this account's login.");
      return;
    }
    setFresh({ token, uuid: who.uuid }); setNote(""); setError(""); setStep("sure");
  }

  async function withJace() {
    setError(""); setNote("Sign in with Jace in the tab that opened…");
    try {
      const r = await api<{ url: string; state: string; poll_key: string }>("/auth/jace", { body: {} });
      window.open(r.url, "_blank", "noopener");
      for (let i = 0; i < 150; i++) {                       // up to 5 minutes
        await sleep(2000);
        const d = await fetch(`/api/v1/auth/jace/poll?state=${r.state}&key=${r.poll_key}`).then((x) => x.json());
        if (d.error) throw new Error(d.error);
        if (!d.pending) { await verified(d.token); return; }
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
    if (r.token) await verified(r.token); else { setNote(""); setError(r.error ?? "Sign-in failed"); }
  }

  async function deleteIt() {
    if (!fresh) return;
    setBusy(true); setError(""); deleting = true;
    try {
      const r = await fetch(`/api/v1/me${now ? "?now=1" : ""}`, { method: "DELETE", headers: { Authorization: `Bearer ${fresh.token}` }, cache: "no-store" });
      const text = await r.text();
      let done: Partial<Recovery> & { error?: string; deleted_for_good?: boolean } = {};
      try { done = JSON.parse(text); } catch { /* not JSON */ }
      if (!r.ok) throw new Error(done.error ?? `Error ${r.status}`);
      if (now && done.deleted_for_good) {                  // nothing to keep: say so on the sign-in screen
        try { sessionStorage.setItem(RECOVERY_KEY, JSON.stringify({ deleted_for_good: true })); } catch { /* */ }
        forgetAccount(me.uuid);
        setToken(null);
        location.href = "/app";
        return;
      }
      if (!done.recovery_id || !done.expires_at) {   // never sign out without the recovery ID on screen
        console.error("delete account: unexpected answer", r.status, r.url, text.slice(0, 300));
        throw new Error(`The recovery ID didn't come back (${r.status}). Don't close this - ask for help with Talk to a person.`);
      }
      // signed out now: the sign-in screen shows the recovery ID (this app closes as its session ends)
      try { sessionStorage.setItem(RECOVERY_KEY, JSON.stringify(done)); }
      catch { alert(`Your recovery ID (works until ${new Date(done.expires_at!).toLocaleString()}):\n\n${done.recovery_id}`); }
      forgetAccount(me.uuid);
      setToken(null);
      location.href = "/app";
    } catch (e) { deleting = false; setError((e as Error).message); setBusy(false); }
  }

  return (
    <Modal onClose={onClose}>
      {step === "minecraft" ? (
        <div className="modal-body">
          <MinecraftDevice<{ token: string }> mode="signin" onCancel={() => setStep("verify")} onDone={(r) => void verified(r.token)} />
          {error && <p className="error">{error}</p>}
        </div>
      ) : step === "verify" ? <>
        <div className="modal-body">
          <h2>Delete your account</h2>
          <p>First, sign in again to show it&apos;s you.</p>
          {me.jace_linked && <button className="btn primary" onClick={withJace}>Sign in with Jace</button>}
          {me.minecraft_linked && <button className="btn" onClick={withMinecraft}>⛏ Sign in with Minecraft</button>}
          {note && <p className="muted small" style={{ margin: 0 }}>{note}</p>}
          {error && <p className="error">{error}</p>}
        </div>
        <div className="modal-foot"><button className="btn" onClick={onClose}>Cancel</button></div>
      </> : <>
        <div className="modal-body">
          <h2>Are you sure?</h2>
          <p>Your account, <b>{me.display_name || me.name}</b>, will be deleted: you&apos;ll be signed out everywhere, and your friends,
            messages, servers and profile disappear for everyone.</p>
          {now
            ? <p className="error" style={{ margin: 0 }}><b>Right away and for good:</b> there&apos;s no recovery ID. Everything, including
                servers you own, is deleted now and can&apos;t come back.</p>
            : <p className="muted small" style={{ margin: 0 }}>You&apos;ll get a recovery ID that brings it all back for 10 days.
                Servers you own stay up for those 10 days, then they&apos;re deleted too.</p>}
          {error && <p className="error">{error}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>No, keep it</button>
          <button className="btn danger" disabled={busy} onClick={deleteIt}>{busy ? "Deleting…" : now ? "Yes, delete it for good" : "Yes, delete my account"}</button>
        </div>
      </>}
    </Modal>
  );
}

/** On the sign-in screen right after deleting: the recovery ID, once. */
export function RecoveryNotice() {
  const [r, setR] = useState<(Recovery & { deleted_for_good?: boolean }) | null>(null);
  useEffect(() => {
    try { setR(JSON.parse(sessionStorage.getItem(RECOVERY_KEY) ?? "null")); } catch { /* */ }
  }, []);
  const [copied, setCopied] = useState(false);
  const close = () => { try { sessionStorage.removeItem(RECOVERY_KEY); } catch { /* */ } setR(null); };
  if (r?.deleted_for_good) return (
    <Modal onClose={close}>
      <div className="modal-body" style={{ textAlign: "left" }}>
        <h2>Your account is deleted</h2>
        <p style={{ margin: 0 }}>It&apos;s gone for good, with everything in it. Thanks for using Jace Social!</p>
      </div>
      <div className="modal-foot"><button className="btn primary" onClick={close}>OK</button></div>
    </Modal>
  );
  if (!r?.recovery_id) return null;
  return (
    <Modal onClose={() => {}}>
      <div className="modal-body" style={{ textAlign: "left" }}>
        <h2>Your account is deleted</h2>
        <p style={{ margin: 0 }}>This is your <b>recovery ID</b>. It&apos;s the only way to get your account back, and you won&apos;t see it again:</p>
        <div className="mc-code" style={{ fontSize: 17, letterSpacing: 1, whiteSpace: "nowrap", userSelect: "all" }} aria-label="Your recovery ID">{r.recovery_id}</div>
        <button className="btn" onClick={() => { void navigator.clipboard?.writeText(r.recovery_id); setCopied(true); }}>
          {copied ? "Copied" : "Copy recovery ID"}</button>
        <p className="muted small" style={{ margin: 0 }}>
          To get everything back, sign in again (that makes a new account) and paste it in a chat with the Jace bot before{" "}
          <b>{new Date(r.expires_at).toLocaleString()}</b>. After that, your account and everything in it is gone for good.
        </p>
      </div>
      <div className="modal-foot"><button className="btn primary" onClick={close}>I saved it</button></div>
    </Modal>
  );
}

/** Settings -> Accounts -> Delete account: a box for args. Nothing: delete with the 10 days to recover;
 *  "([DELETE-NOW])": delete right away and for good; a recovery ID: bring that deleted account back
 *  into this one. Deleting still signs in again and asks "Are you sure?". */
export function DeleteAccountCard({ me }: { me: Me }) {
  const [args, setArgs] = useState("");
  const [flow, setFlow] = useState<null | "later" | "now">(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function go() {
    const a = args.trim();
    setNote(""); setError("");
    if (/^JSR(?:-?[2-9A-HJ-NP-Z]{4}){4}$/i.test(a)) {                 // a recovery ID
      setBusy(true);
      try {
        const r = await api<{ ok: boolean; message: string }>("/me/recover", { body: { recovery_id: a } });
        if (r.ok) { setNote(r.message); setTimeout(() => location.reload(), 1500); } else setError(r.message);
      } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
      return;
    }
    if (/^\(\s*\[\s*DELETE-NOW\s*\]\s*\)$/i.test(a)) { setFlow("now"); return; }
    if (!a) { setFlow("later"); return; }
    setError("Type nothing, ([DELETE-NOW]), or a recovery ID (JSR-…).");
  }
  return (
    <div className="card danger-card" style={{ display: "grid", gap: 8, marginTop: 8 }}>
      <b>Delete account</b>
      <label className="small" style={{ textTransform: "none", letterSpacing: 0 }}>Type args
        <input value={args} maxLength={40} spellCheck={false} placeholder="(optional)" onChange={(e) => setArgs(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void go(); }} />
      </label>
      <ul className="muted small" style={{ margin: 0, paddingLeft: 18 }}>
        <li><b>Nothing</b> - delete it, and get a recovery ID that brings it back for 10 days</li>
        <li><b>([DELETE-NOW])</b> - delete it right away and for good, with no recovery ID</li>
        <li><b>A recovery ID</b> (JSR-…) - turn this account back into one you deleted</li>
      </ul>
      <button className="btn danger small" style={{ justifySelf: "start" }} disabled={busy} onClick={() => void go()}>
        {/^JSR/i.test(args.trim()) ? "Recover account" : "Delete account…"}</button>
      {note && <div className="small" style={{ color: "var(--green)" }}>{note}</div>}
      {error && <div className="error">{error}</div>}
      {flow && <DeleteAccount me={me} now={flow === "now"} onClose={() => setFlow(null)} />}
    </div>
  );
}
