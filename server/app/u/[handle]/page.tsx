// jace-social.vercel.app/u/<handle>: someone's profile link. If they turned on "Public profile page"
// (Settings -> Links & privacy) anyone can see their name, picture, about me and links here; if not,
// only that it's private. Either way "Open in Jace Social" shows the full profile there.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db, publicProfile, type Profile } from "@/lib/server";
import { socialOf } from "@/lib/socialLinks";
import "../../home.css";

export const dynamic = "force-dynamic";

async function find(handle: string) {
  const h = decodeURIComponent(handle).replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_.]{3,20}$/.test(h)) return null;
  const { data } = await db().from("profiles").select("*").eq("handle", h).maybeSingle();
  const p = data as Profile | null;
  if (!p || p.deleted_at || p.banned_at) return null;
  return { p, open: (p.settings as { public_profile?: boolean } | undefined)?.public_profile === true || (p.is_bot === true && p.bot_public === true) };
}

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const f = await find((await params).handle);
  if (!f) return { title: "Not found · Jace Social" };
  const pub = publicProfile(f.p);
  if (!f.open) return { title: `@${pub.handle} · Jace Social`, robots: { index: false } };
  return {
    title: `${pub.name} (@${pub.handle}) · Jace Social`, description: pub.bio ?? `${pub.name} on Jace Social`,
    openGraph: { title: `${pub.name} on Jace Social`, description: pub.bio ?? undefined, images: pub.avatar_url ? [{ url: pub.avatar_url }] : undefined },
  };
}

export default async function ProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  const f = await find((await params).handle);
  if (!f) notFound();
  const p = publicProfile(f.p);
  const openApp = `/app#profile=${p.uuid}`;
  return (
    <div className="site">
      <main className="wrap profile-page">
        <div className="profile-page-card">
          <div className="profile-page-banner" style={{ background: f.open && p.banner_url ? `center / cover url(${p.banner_url})` : p.accent_color ?? "#2a4a37" }} />
          <div className="profile-page-body">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {f.open && p.avatar_url ? <img className="profile-page-avatar" src={p.avatar_url} alt="" />
              : <div className="profile-page-avatar letter">{p.name.slice(0, 1).toUpperCase()}</div>}
            {f.open ? <>
              <h1>{p.name}</h1>
              <p className="muted">{[`@${p.handle}`, p.pronouns].filter(Boolean).join(" · ")}</p>
              {p.bio && <p style={{ whiteSpace: "pre-wrap" }}>{p.bio}</p>}
              {p.links.length > 0 && <div className="profile-page-links">
                {p.links.map((l) => (
                  <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="profile-page-link">
                    <span>{socialOf(l.url).icon}</span> {l.label}</a>
                ))}
              </div>}
            </> : <>
              <h1>@{p.handle}</h1>
              <p className="muted">This profile is private. Open it in Jace Social to see it.</p>
            </>}
            <a className="btn primary" href={openApp} style={{ display: "inline-block", marginTop: 12 }}>Open in Jace Social</a>
          </div>
        </div>
        <p className="muted small" style={{ textAlign: "center" }}><a href="/">Jace Social</a> - friends, chat and servers, with Minecraft built in.</p>
      </main>
    </div>
  );
}
