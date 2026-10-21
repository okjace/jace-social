// The /terms and /privacy pages: the same Markdown as the popup (public/legal/*.md), read when the site is built.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LegalPage } from "@/components/Legal";
import "@/app/home.css";

export function LegalDocPage({ id }: { id: "jace-social-terms" | "jace-social-privacy" }) {
  const text = readFileSync(join(process.cwd(), "public", "legal", `${id}.md`), "utf8");
  return (
    <div className="site">
      <main className="wrap" style={{ maxWidth: 760, padding: "40px 16px", lineHeight: 1.6 }}>
        <LegalPage text={text} />
        <p className="muted small">
          <a href="/terms">Jace Social Terms</a> · <a href="/privacy">Jace Social Privacy</a> ·{" "}
          <a href="https://jaceo.vercel.app">Jace&apos;s Terms and Privacy</a> (also in the popup)
        </p>
        <p><a href="/">← Jace Social</a></p>
      </main>
    </div>
  );
}
