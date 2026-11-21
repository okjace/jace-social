"use client";
// Terms and privacy. Jace Social's own Terms and Privacy Policy are on /legal (public/legal/*.md),
// with links to Jace's, which live in Jace's READ ME forum (they also apply: Jace Social is part of
// Jace). Nothing to click "Agree" on: a small notice in a corner says it once, and the sign-in screens
// say it under their buttons.
import { useEffect, useState } from "react";
import { LEGAL_PAGE } from "@/lib/legal";
import { Markdown } from "./Markdown";

const mentions = { people: {}, roles: [] };

/** For the sign-in and new-account screens: "By making an account, you agree to ...", both linked. */
export function AccountTerms() {
  return (
    <p className="muted small" style={{ marginBottom: 0 }}>
      By making an account, you agree to the <a href={`${LEGAL_PAGE}#terms`} target="_blank" rel="noopener">Terms of Service</a> and{" "}
      <a href={`${LEGAL_PAGE}#privacy`} target="_blank" rel="noopener">Privacy Policy</a>.
    </p>
  );
}

const NOTICE_KEY = "jace_social_terms_notice";

/**
 * "By using this app, you agree to the Terms of Service and Privacy Policy." in a bottom corner, once:
 * it goes away by itself after about 5 seconds, and doesn't come back on this device (local storage).
 * Clicking it opens the Terms and privacy page.
 */
export function TermsNotice() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (location.pathname.startsWith(LEGAL_PAGE)) return;
    try {
      if (localStorage.getItem(NOTICE_KEY)) return;
      localStorage.setItem(NOTICE_KEY, String(Date.now()));
    } catch { return; }                                 // no storage (private window): don't show it every time
    setShow(true);
    const t = setTimeout(() => setShow(false), 5000);
    return () => clearTimeout(t);
  }, []);
  if (!show) return null;
  return (
    <a className="terms-notice" href={LEGAL_PAGE} target="_blank" rel="noopener" onClick={() => setShow(false)}>
      By using this app, you agree to the <u>Terms of Service</u> and <u>Privacy Policy</u>.
    </a>
  );
}

/** One document on the /legal page. */
export function LegalPage({ text }: { text: string }) {
  return <div className="legal-page"><Markdown text={text} mentions={mentions} /></div>;
}
