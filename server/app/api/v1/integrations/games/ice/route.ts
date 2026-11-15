// GET: ICE servers for Jace Live's in-game voice calls (lib/gamesIntegration.ts).
//   -> {ice_servers: [{urls, username?, credential?}], relay}
//   Same servers as Jace Social's own calls (app/api/v1/calls/ice): STUN always, plus the
//   Cloudflare TURN relay when it's set up. Only for players who use Jace Social (linked),
//   since Jace Live only connects calls between Jace Social friends. Credentials are short-lived.
import { gamesHandler, linked } from "@/lib/gamesIntegration";

type IceServer = { urls: string | string[]; username?: string; credential?: string };

export const GET = gamesHandler(async (_req, who) => {
  linked(who);
  const servers: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (keyId && apiToken) {
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 2 * 3600 }),
      });
      if (r.ok) {
        const d = await r.json();
        const list: IceServer[] = Array.isArray(d.iceServers) ? d.iceServers : d.iceServers ? [d.iceServers] : [];
        // TURN entries only (STUN is already there); port 53 is blocked by many browsers/networks.
        for (const s of list) {
          const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => u.startsWith("turn") && !u.includes(":53"));
          if (urls.length) servers.push({ urls, username: s.username, credential: s.credential });
        }
      } else console.error("Cloudflare TURN credentials failed", r.status);
    } catch (e) {
      console.error("Cloudflare TURN credentials failed", e);
    }
  }
  return { ice_servers: servers, relay: servers.length > 1 };
});
