// jace-social.vercel.app/privacy: what Jace Social keeps about you, in plain words.
import type { Metadata } from "next";
import "../home.css";

export const metadata: Metadata = { title: "Privacy · Jace Social", description: "What Jace Social keeps about you, and why." };

export default function Privacy() {
  return (
    <div className="site">
      <main className="wrap" style={{ maxWidth: 760, padding: "40px 16px", lineHeight: 1.6 }}>
        <h1>Privacy</h1>
        <p className="muted">What Jace Social keeps about you, and why. Last updated October 2026.</p>

        <h2>Your account</h2>
        <p>When you sign in with Minecraft we keep your Minecraft name and id; with Jace, your Jace username and account id.
          Your profile is what you add to it: display name, @handle, picture, banner, about me, pronouns, links and status.
          We never see your Microsoft or Jace password.</p>

        <h2>What you send</h2>
        <p>Your messages, files, reactions, servers, group chats and friends are stored so you and the people you talk to can see them.
          Deleting a message deletes it. Link previews are fetched by our server, so the sites you see previews of don't get your IP address.
          Voice calls go directly between devices, or through a relay that can't listen to them.</p>

        <h2 id="jace-messages">Jace messages</h2>
        <p>When you sign in with Jace (or link it), Jace Social can sync your direct messages and group chats with your Jace account
          at jaceo.vercel.app:</p>
        <ul>
          <li>Your past Jace conversations are copied here once, and new Jace messages arrive here as they come in.</li>
          <li>Messages you send here to other Jace people, and in group chats that came from Jace, are also saved to your Jace account.
            Only the text goes to Jace: not files, reactions, edits or deletions.</li>
          <li>To do that, Jace Social keeps an access token for your Jace messages, encrypted, on its server. It's never shown to apps or other people.</li>
        </ul>
        <p>To stop it: <b>Settings → Accounts → Jace messages</b>. Turn off <b>Sync messages with Jace</b> to pause it, or press
          <b> Disconnect Jace messages</b> to delete the token. Messages already copied stay where they are.
          Conversations with Minecraft-only players are never sent to Jace.</p>

        <h2>The Jace bot</h2>
        <p>The official Jace bot answers questions with AI: your chat with it (the latest messages) is sent to Cloudflare Workers AI to write
          its answer. Cloudflare doesn't use it to train AI models or improve its services. Press <b>Talk to a person</b> and the people running the Jace bot answer instead -
          they can read your chat with it. The Jace bot also sends announcements to everyone.</p>

        <h2>Who sees what</h2>
        <p>Your friends see your status and what you're playing; you can go invisible. Bots only see what's in the chats they're added to,
          and everything a bot does is logged for its owner and the server's admins. We don't sell your data or show ads.</p>

        <h2>Where it's kept</h2>
        <p>On Supabase (the database and files) and Vercel (the website), which store it for us. Your sign-in on a device stays on that device.</p>

        <h2>Questions</h2>
        <p>Open an issue on <a href="https://github.com/okjace/jace-social">GitHub</a>.</p>
        <p><a href="/">← Jace Social</a></p>
      </main>
    </div>
  );
}
