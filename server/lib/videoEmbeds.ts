// Video links that play right in the chat: YouTube, Vimeo, Twitch, Streamable and Dailymotion links
// become their site's player (loaded only when you press play). Used by the link previews
// (lib/embeds.ts, which also plays links straight to a video file) and the chat (components/Message.tsx).

/** "1h2m3s", "90s", "90" -> seconds. */
function seconds(t: string | null): number {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

export type Player = { src: string; tall?: boolean };

/**
 * The player for a video link, or null. parent: this site's hostname (Twitch only plays on sites
 * that name themselves). The player starts playing when it's shown (after you press play).
 */
export function playerFor(raw: string, parent = "jace-social.vercel.app"): Player | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, "");
  const path = u.pathname.split("/").filter(Boolean);
  const id = (s: string | undefined | null, re = /^[\w-]{6,20}$/) => (s && re.test(s) ? s : null);

  if (host === "youtube.com" || host === "youtube-nocookie.com" || host === "youtu.be") {
    const v = host === "youtu.be" ? id(path[0])
      : path[0] === "watch" ? id(u.searchParams.get("v"))
      : ["shorts", "live", "embed", "v"].includes(path[0]) ? id(path[1]) : null;
    const list = id(u.searchParams.get("list"), /^[\w-]{10,64}$/);
    if (!v && !list) return null;
    const start = seconds(u.searchParams.get("t") ?? u.searchParams.get("start"));
    const q = new URLSearchParams({ autoplay: "1", rel: "0", ...(start ? { start: String(start) } : {}), ...(list ? { list } : {}) });
    return { src: `https://www.youtube-nocookie.com/embed/${v ?? "videoseries"}?${q}`, tall: path[0] === "shorts" };
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const v = path.find((p) => /^\d{5,12}$/.test(p));
    if (!v) return null;
    const hash = path[path.indexOf(v) + 1] ?? u.searchParams.get("h");   // unlisted videos: vimeo.com/<id>/<hash>
    const q = new URLSearchParams({ autoplay: "1", ...(hash && /^[0-9a-f]{6,20}$/.test(hash) ? { h: hash } : {}) });
    return { src: `https://player.vimeo.com/video/${v}?${q}` };
  }
  if (host === "twitch.tv" || host === "clips.twitch.tv") {
    const p = new URLSearchParams({ parent, autoplay: "true" });
    if (host === "clips.twitch.tv" || path[1] === "clip") {
      const clip = id(host === "clips.twitch.tv" ? path[0] : path[2], /^[\w-]{5,100}$/);
      return clip ? { src: `https://clips.twitch.tv/embed?clip=${clip}&${p}` } : null;
    }
    if (path[0] === "videos" && /^\d+$/.test(path[1] ?? "")) return { src: `https://player.twitch.tv/?video=v${path[1]}&${p}` };
    const channel = id(path[0], /^\w{3,25}$/);
    const pages = ["directory", "downloads", "jobs", "login", "signup", "settings", "search", "subscriptions", "inventory", "wallet", "turbo", "p", "videos"];
    return channel && path.length === 1 && !pages.includes(channel.toLowerCase()) ? { src: `https://player.twitch.tv/?channel=${channel}&${p}` } : null;
  }
  if (host === "streamable.com") {
    const v = id(path[0] === "e" ? path[1] : path[0], /^\w{4,12}$/);
    return v ? { src: `https://streamable.com/e/${v}?autoplay=1` } : null;
  }
  if (host === "dailymotion.com" || host === "dai.ly") {
    const v = host === "dai.ly" ? id(path[0], /^\w{5,12}$/) : path[0] === "video" ? id(path[1], /^\w{5,12}$/) : null;
    return v ? { src: `https://www.dailymotion.com/embed/video/${v}?autoplay=1` } : null;
  }
  return null;
}

