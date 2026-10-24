// Link previews ("embeds") for messages: the first few links' title, description, image
// and site name, read from the page's Open Graph / Twitter tags. Fetched by the server so
// people's IP addresses aren't sent to every site that's linked.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { after } from "next/server";
import { db } from "./server";
import { playerFor } from "./videoEmbeds";

// video: a link straight to a video file (played in the chat); video sites' players come from the
// link itself (lib/videoEmbeds.ts)
export type Embed = { url: string; title?: string; description?: string; image?: string; site?: string; color?: string; type: "link" | "image" | "video"; video?: string };

const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\]]/gi;
const MAX_LINKS = 3;
const MAX_BYTES = 512 * 1024;

export function linksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    // <https://...> means "don't preview this one", like Discord
    if (text[m.index! - 1] === "<") continue;
    if (!out.includes(m[0])) out.push(m[0]);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/** No previews of this server's own network: refuse private, loopback and link-local addresses. */
function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")
    || (v.startsWith("::ffff:") && privateAddress(v.slice(7)));
}

async function safeUrl(raw: string): Promise<URL | null> {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return null;
  if (u.port && !["80", "443", ""].includes(u.port)) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  try {
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => privateAddress(a.address))) return null;
  } catch {
    return null;
  }
  return u;
}

function decode(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).trim();
}

function meta(html: string, ...names: string[]): string | undefined {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, "i");
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (content) return decode(content);
  }
  return undefined;
}

const clip = (s: string | undefined, n: number) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s);

/** YouTube and Vimeo: the title and thumbnail from their oEmbed APIs (YouTube often blocks page fetches from servers). */
async function videoInfo(raw: string): Promise<Embed | null> {
  const u = new URL(raw);
  const yt = /(^|\.)(youtube\.com|youtu\.be)$/.test(u.hostname);
  const api = yt ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(raw)}`
    : /(^|\.)vimeo\.com$/.test(u.hostname) ? `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(raw)}` : null;
  if (!api) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3500);
  try {
    const r = await fetch(api, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; JaceSocialBot/1.0; +https://jace-social.vercel.app/)" } });
    if (r.ok) {
      const o = await r.json() as { title?: string; author_name?: string; thumbnail_url?: string; provider_name?: string };
      return {
        url: raw, type: "video", title: clip(o.title, 120), description: clip(o.author_name, 300),
        image: o.thumbnail_url?.startsWith("https://") ? o.thumbnail_url : undefined,
        site: o.provider_name ?? (yt ? "YouTube" : "Vimeo"), color: yt ? "#ff0000" : "#1ab7ea",
      };
    }
  } catch { /* fall back to the page */ } finally { clearTimeout(timer); }
  return null;
}

async function one(raw: string): Promise<Embed | null> {
  const player = !!playerFor(raw);
  if (player) {
    const info = await videoInfo(raw);
    if (info) return info;
  }
  const page = await fromPage(raw);
  // a video site's page that couldn't be read still plays (with the site's name)
  if (player) return page ? { ...page, type: "video" } : { url: raw, type: "video", site: new URL(raw).hostname.replace(/^www\./, "") };
  return page;
}

async function fromPage(raw: string): Promise<Embed | null> {
  let url = await safeUrl(raw);
  if (!url) return null;
  // follow up to 3 redirects by hand, checking each address
  for (let hop = 0; hop < 4; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    try {
      const r = await fetch(url, {
        redirect: "manual", signal: ctrl.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; JaceSocialBot/1.0; +https://jace-social.vercel.app/)", Accept: "text/html,image/*;q=0.8" },
      });
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
        url = await safeUrl(new URL(r.headers.get("location")!, url).toString());
        if (!url) return null;
        continue;
      }
      if (!r.ok) return null;
      const type = r.headers.get("content-type") ?? "";
      if (type.startsWith("image/")) return { url: raw, image: url.toString(), type: "image" };
      if (type.startsWith("image/") || type.startsWith("video/")) void r.body?.cancel().catch(() => {});
      if (/^video\/(mp4|webm|quicktime|x-m4v)/.test(type) && url.protocol === "https:")
        return { url: raw, video: url.toString(), type: "video", site: url.hostname.replace(/^www\./, ""),
          title: clip(decodeURIComponent(url.pathname.split("/").pop() ?? ""), 120) || undefined };
      if (!type.includes("html")) return null;
      // read at most MAX_BYTES of the page
      const reader = r.body?.getReader();
      let html = "";
      let size = 0;
      const dec = new TextDecoder();
      while (reader && size < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        html += dec.decode(value, { stream: true });
        if (/<\/head>/i.test(html)) break;
      }
      void reader?.cancel().catch(() => {});
      const title = meta(html, "og:title", "twitter:title") ?? decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "");
      const description = meta(html, "og:description", "twitter:description", "description");
      let image = meta(html, "og:image", "og:image:url", "twitter:image");
      if (image) { try { image = new URL(image, url).toString(); } catch { image = undefined; } }
      if (image && !image.startsWith("https://")) image = undefined;
      if (!title && !description && !image) return null;
      const video = /youtube\.com|youtu\.be|twitch\.tv|vimeo\.com/.test(url.hostname);
      return {
        url: raw, type: video ? "video" : "link",
        title: clip(title || undefined, 120), description: clip(description, 300), image,
        site: clip(meta(html, "og:site_name") ?? url.hostname.replace(/^www\./, ""), 60),
        color: meta(html, "theme-color")?.match(/^#[0-9a-f]{6}$/i)?.[0],
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Previews for the links in a message (at most 3, a few seconds at most). */
export async function embedsFor(text: string): Promise<Embed[]> {
  const links = linksIn(text);
  if (!links.length) return [];
  const all = await Promise.all(links.map((l) => one(l).catch(() => null)));
  return all.filter(Boolean) as Embed[];
}

/**
 * Add link previews to a message once it's sent (fetching them can take a few seconds,
 * so the message goes out first, like Discord), then tell the chat it changed.
 */
export function previewLater(table: "channel_messages" | "messages", id: number, text: string, tell: () => Promise<void>) {
  if (!linksIn(text).length) return;
  after(async () => {
    const embeds = await embedsFor(text).catch(() => []);
    if (!embeds.length) return;
    await db().from(table).update({ embeds }).eq("id", id);
    await tell();
  });
}
