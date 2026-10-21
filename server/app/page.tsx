// jace-social.vercel.app: the website (it used to be on GitHub Pages). The app is at /app.
import type { Metadata } from "next";
import { Downloads } from "@/components/Downloads";
import { latestApp, PHONE, REPO } from "@/lib/releases";
import { db } from "@/lib/server";
import "./home.css";

export const revalidate = 300;     // the page is rebuilt at most every 5 minutes

export const metadata: Metadata = {
  title: "Jace Social",
  description: "Jace Social: friends, group chats, servers, voice and bots - on the web, on your desktop, in Jace Launcher and inside Minecraft.",
  openGraph: { title: "Jace Social", description: "Your friends, everywhere you play.", images: [{ url: "/logo.png" }] },
};

async function players(): Promise<number | null> {
  try {
    const { count } = await db().from("profiles").select("uuid", { count: "exact", head: true }).not("signed_up", "is", null).eq("is_bot", false);
    return count ?? 0;
  } catch {
    return null;
  }
}

const FEATURES: [string, string, string][] = [
  ["💬", "Messages & group chats", "Private messages and group chats with replies, reactions, @mentions, files, link previews and formatting."],
  ["🏰", "Servers", "Text and voice channels in categories, roles with permissions, onboarding, moderation, and your own invite link like /yourserver."],
  ["🤖", "Bots", "Build your own bot with Scratch-style blocks, no code needed, or program one with the API. The official Jace bot has polls, dice and Minecraft server status."],
  ["🖥️", "Voice & screen sharing", "Voice channels and group calls with screen sharing, plus one-to-one calls that work with Jace Launcher."],
  ["🎨", "Make it yours", "Themes, an accent color, text size, compact mode, notification settings, a profile banner, and an account switcher."],
  ["🟢", "Status", "Online, Idle, Do Not Disturb or Invisible, plus a custom status with an emoji."],
  ["🎮", "Rich presence", "Friends see what you're playing: the Minecraft version and loader, the server or world, your modpack, and for how long."],
  ["🪪", "Profiles", "A profile picture and banner, display name, pronouns, an about-me, profile color and up to five links."],
  ["🔗", "Jace + Minecraft", "Sign in with a Jace account or your Minecraft account (even in the browser), and link both. Your friends and chats stay with you."],
  ["🌍", "Host & join worlds", "Host your singleplayer world for friends with roles and permissions. They click Join, with no port forwarding."],
];

export default async function Home() {
  const [app, mobile, count] = await Promise.all([latestApp(), latestApp("mobile-v", PHONE), players()]);
  return (
    <div className="site">
      <header>
        <div className="wrap">
          <nav>
            <a className="brand" href="/" aria-label="Jace Social home">{/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="" /><span>Jace Social</span></a>
            <a className="tab active" href="/">Home</a>
            <a className="tab" href="/app">Open the app</a>
            <a className="tab hide-sm" href="https://okjace.github.io/jace-launcher/">Jace Launcher</a>
            <a className="tab hide-sm" href={`https://github.com/${REPO}`}>GitHub</a>
          </nav>
        </div>
      </header>

      <main>
        <div className="wrap hero">
          <h1>Your friends,<br /><span>everywhere you play.</span></h1>
          <p className="lead">Friends, messages, servers, voice and bots. Use it in your browser, as a desktop app, in Jace Launcher,
            and inside Minecraft with the Jace Social mod. One account, the same friends everywhere.</p>
          <div className="downloads" id="download">
            <a className="btn primary" href="/app">Open in your browser</a>
            {app?.downloads.length ? <Downloads list={app.downloads} /> : <a className="btn" href={`https://github.com/${REPO}/releases`}>⬇ Desktop app</a>}
            {mobile?.downloads.some((d) => d.id === "android") && <Downloads list={mobile.downloads.filter((d) => d.id === "android")} />}
          </div>
          <p className="release-note">
            {app ? <>Desktop app {app.version} · <a href={app.page}>release notes</a> · free and open source</> : "Free and open source."}
          </p>
          <p className="release-note">Open the download once and it installs itself; after that it updates with one click.
            The app isn&apos;t signed yet, so the first time: on a Mac, right-click it and choose <b>Open</b>
            (on macOS 15 or newer: System Settings → Privacy &amp; Security → <b>Open Anyway</b>);
            on Windows, click <b>More info → Run anyway</b>.</p>
          <div className="card status" style={{ maxWidth: 460, margin: "24px auto 0", textAlign: "left" }}>
            <span className={`dot ${count === null ? "down" : "up"}`} />
            <span>{count === null
              ? <><b>Jace Social isn&apos;t responding right now</b><br /><span style={{ color: "var(--muted)" }}>Try again in a moment.</span></>
              : <><b>Jace Social is online</b><br /><span style={{ color: "var(--muted)" }}>{count.toLocaleString()} player{count === 1 ? "" : "s"} signed up</span></>}</span>
          </div>
        </div>

        <section className="alt">
          <div className="wrap">
            <h2>Everything in one place</h2>
            <p className="sub">Like the chat apps you know, with Minecraft built in.</p>
            <div className="grid">
              {FEATURES.map(([icon, title, text]) => (
                <div key={title} className="card"><div className="icon">{icon}</div><h3>{title}</h3><p>{text}</p></div>
              ))}
            </div>
          </div>
        </section>

        <section>
          <div className="wrap">
            <h2>Get it</h2>
            <p className="sub">Pick any of these. They all use the same account.</p>
            <div className="steps">
              <div className="card"><h3>Web</h3><p><a href="/app">Open the app</a> and sign in with Jace or Minecraft.</p></div>
              <div className="card"><h3>Desktop app</h3><p>Windows, macOS and Linux <a href="#download">above</a> or from the <a href={`https://github.com/${REPO}/releases`}>releases page</a>.
                Notifications even when the window is closed, and invite links open right in the app.</p></div>
              <div className="card"><h3>Phone</h3><p>Also on <a href="https://jace-store-deb.vercel.app/project/jace-social-mobile">Jace Store</a>.{" "}<b>Android:</b> {mobile?.downloads.some((d) => d.id === "android")
                ? <>download the app <a href="#download">above</a>, open it and allow installing from your browser.</>
                : <>coming soon. Until then, open <a href="/app">the web app</a> and choose <b>Add to Home screen</b>.</>}
                {" "}<b>iPhone:</b> open <a href="/app">the web app</a> in Safari, tap <b>Share → Add to Home Screen</b>.
                {mobile?.downloads.some((d) => d.id === "ios") && <> Or get the iPhone app in AltStore or SideStore: add the source <a href="/altstore"><code>jace-social.vercel.app/altstore</code></a> (<a href="altstore://source?url=https://jace-social.vercel.app/altstore">open in AltStore</a>), and updates arrive there.</>}</p></div>
              <div className="card"><h3>Jace Launcher</h3><p><a href="https://okjace.github.io/jace-launcher/">Jace Launcher</a> has friends and chat built in.
                Link your Jace account in <b>Settings → Jace Social</b>.</p></div>
              <div className="card"><h3>In Minecraft</h3><p>Install the <a href="https://jace-store-deb.vercel.app/project/jace-social-minecraft">Jace Social mod</a>
                (1.20.1 to 26.3, Fabric, NeoForge and Forge) and press <b>J</b>.</p></div>
            </div>
          </div>
        </section>

        <section className="alt">
          <div className="wrap">
            <h2>Questions</h2>
            <details><summary>Is it free?</summary><p>Yes, and the code is on GitHub.</p></details>
            <details><summary>Does Jace Social see my Microsoft password or Minecraft token?</summary><p>Never your password.
              In the desktop app, Jace Launcher and the mod, Minecraft sign-in works like joining a Minecraft server: Mojang confirms the account,
              and your tokens stay on your computer. In the browser you enter a code at microsoft.com/link; the server then uses the result once
              to read your Minecraft profile and doesn&apos;t keep it.</p></details>
            <details><summary>Do I need Minecraft?</summary><p>No. Sign in with a Jace account to chat with friends and use servers. Link Minecraft any time to show what you&apos;re playing.</p></details>
            <details><summary>Can I make a bot without coding?</summary><p>Yes: Settings → My bots → Edit blocks. Snap blocks together like in Scratch, then add the bot to your server.</p></details>
            <details><summary>What does Invisible do?</summary><p>You look offline to everyone, but you can still use everything.</p></details>
          </div>
        </section>
      </main>

      <footer>
        <div className="wrap">
          <span>Jace Social · made by jace.deb</span>
          <span><a href={`https://github.com/${REPO}`}>GitHub</a> · <a href="https://okjace.github.io/jace-launcher/">Jace Launcher</a> · <a href="https://jace-store-deb.vercel.app">Jace Store</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></span>
        </div>
      </footer>
    </div>
  );
}
