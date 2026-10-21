"use client";
// The Terms of Service and Privacy Policy, in a popup (like the Jace site's footer): Jace Social's
// own, and Jace's (which also apply when you sign in with Jace). Opens from any link to /terms or
// /privacy on the site, and before you sign in for the first time on a device.
import { useEffect, useState } from "react";
import { Markdown } from "./Markdown";
import { Modal } from "./ui";

export const LEGAL_DOCS = [
  { id: "jace-social-terms", label: "Jace Social Terms" },
  { id: "jace-social-privacy", label: "Jace Social Privacy" },
  { id: "jace-terms", label: "Jace Terms" },
  { id: "jace-privacy", label: "Jace Privacy" },
] as const;
export type LegalId = (typeof LEGAL_DOCS)[number]["id"];

const cache: Partial<Record<LegalId, string>> = {};
const mentions = { people: {}, roles: [] };

/** Bump when the Terms or Privacy Policy change, so people see the popup again before signing in. */
const AGREED_KEY = "jace_social_legal_2026_10_21";
export function hasAgreed() { try { return localStorage.getItem(AGREED_KEY) === "1"; } catch { return false; } }
function rememberAgreed() { try { localStorage.setItem(AGREED_KEY, "1"); } catch { /* private window: ask again next time */ } }

export function LegalDialog({ start = "jace-social-terms", onClose, onAgree }: {
  start?: LegalId; onClose: () => void; onAgree?: () => void;   // onAgree: "Agree and sign in" instead of "Close"
}) {
  const [tab, setTab] = useState<LegalId>(start);
  const [text, setText] = useState<string | null>(cache[tab] ?? null);
  useEffect(() => {
    if (cache[tab]) { setText(cache[tab]!); return; }
    setText(null);
    fetch(`/legal/${tab}.md`).then((r) => (r.ok ? r.text() : Promise.reject())).then((t) => { cache[tab] = t; setText(t); })
      .catch(() => setText("Couldn't load this right now. Check your connection and try again."));
  }, [tab]);
  return (
    <Modal onClose={onClose} wide>
      <div className="legal">
        <div className="legal-head">
          <h2>{onAgree ? "Before you sign in" : "Terms and privacy"}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="legal-tabs" role="tablist">
          {LEGAL_DOCS.map((d) => (
            <button key={d.id} role="tab" aria-selected={tab === d.id} className={`tab${tab === d.id ? " active" : ""}`} onClick={() => setTab(d.id)}>{d.label}</button>
          ))}
        </div>
        <div className="legal-body">{text === null ? <p className="muted">Loading…</p> : <Markdown text={text} mentions={mentions} />}</div>
        <div className="modal-foot">
          {onAgree ? <>
            <span className="muted small grow">By signing in you agree to the Jace Social Terms and Privacy Policy (and Jace&apos;s, if you sign in with Jace).</span>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={() => { rememberAgreed(); onAgree(); }}>Agree and sign in</button>
          </> : <button className="btn primary" onClick={onClose}>Close</button>}
        </div>
      </div>
    </Modal>
  );
}

/** On every page: links to /terms and /privacy open the popup instead of leaving the page. */
export function LegalLinks() {
  const [open, setOpen] = useState<LegalId | null>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      const id: LegalId | null = url.pathname === "/terms" ? "jace-social-terms" : url.pathname === "/privacy" ? "jace-social-privacy" : null;
      if (!id) return;
      e.preventDefault();
      setOpen(id);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  return open ? <LegalDialog start={open} onClose={() => setOpen(null)} /> : null;
}

/** The /terms and /privacy pages (for people who open the address directly). */
export function LegalPage({ text }: { text: string }) {
  return <div className="legal-page"><Markdown text={text} mentions={mentions} /></div>;
}
