// The Terms and privacy page (/legal; /terms and /privacy lead here): Jace Social's own Terms of
// Service and Privacy Policy (public/legal/*.md, read when the site is built), and Jace's, which are
// in Jace's READ ME forum and also apply.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LegalPage } from "@/components/Legal";
import { JACE_PRIVACY, JACE_README, JACE_TERMS } from "@/lib/legal";
import "@/app/home.css";

const doc = (id: string) => readFileSync(join(process.cwd(), "public", "legal", `${id}.md`), "utf8");

export function LegalHub() {
  return (
    <div className="site legal-hub">
      <main className="wrap">
        <p><a href="/">← Jace Social</a></p>
        <h1>Terms and privacy</h1>
        <p className="muted">
          Using Jace Social means you agree to Jace Social&apos;s Terms of Service and Privacy Policy below. Jace Social is part
          of Jace, so Jace&apos;s Terms of Service and Privacy Policy apply too.
        </p>
        <nav className="legal-nav">
          <a href="#terms">Jace Social Terms</a>
          <a href="#privacy">Jace Social Privacy</a>
          <a href="#jace">Jace&apos;s Terms and Privacy</a>
        </nav>

        <section id="terms" className="legal-section"><LegalPage text={doc("jace-social-terms")} /></section>
        <section id="privacy" className="legal-section"><LegalPage text={doc("jace-social-privacy")} /></section>

        <section id="jace" className="legal-section">
          <h2>Jace&apos;s Terms of Service and Privacy Policy</h2>
          <p className="muted">
            These cover your Jace account and every Jace app, Jace Social included. They live in Jace&apos;s READ ME forum,
            where they&apos;re always up to date.
          </p>
          <div className="legal-links">
            <a className="legal-card" href={JACE_TERMS} target="_blank" rel="noopener"><b>Jace Terms of Service</b><span>On jaceo.vercel.app ↗</span></a>
            <a className="legal-card" href={JACE_PRIVACY} target="_blank" rel="noopener"><b>Jace Privacy Policy</b><span>On jaceo.vercel.app ↗</span></a>
            <a className="legal-card" href={JACE_README} target="_blank" rel="noopener"><b>Jace&apos;s READ ME forum</b><span>Both, and anything new ↗</span></a>
          </div>
        </section>
        <p><a href="/">Jace Social</a></p>
      </main>
    </div>
  );
}
