// Profile links: websites and social accounts get their own icon and name (by the link's site).
export type Social = { id: string; name: string; icon: string; start: string };

/** Sites shown with their own icon - and the quick-add buttons in Settings -> My profile. */
export const SOCIALS: (Social & { hosts: string[] })[] = [
  { id: "youtube", name: "YouTube", icon: "▶️", start: "https://youtube.com/@", hosts: ["youtube.com", "youtu.be", "m.youtube.com"] },
  { id: "twitch", name: "Twitch", icon: "🟣", start: "https://twitch.tv/", hosts: ["twitch.tv"] },
  { id: "tiktok", name: "TikTok", icon: "🎵", start: "https://tiktok.com/@", hosts: ["tiktok.com"] },
  { id: "instagram", name: "Instagram", icon: "📸", start: "https://instagram.com/", hosts: ["instagram.com"] },
  { id: "x", name: "X", icon: "✖️", start: "https://x.com/", hosts: ["x.com", "twitter.com"] },
  { id: "bluesky", name: "Bluesky", icon: "🦋", start: "https://bsky.app/profile/", hosts: ["bsky.app"] },
  { id: "github", name: "GitHub", icon: "🐙", start: "https://github.com/", hosts: ["github.com"] },
  { id: "discord", name: "Discord", icon: "💬", start: "https://discord.gg/", hosts: ["discord.gg", "discord.com"] },
  { id: "reddit", name: "Reddit", icon: "👽", start: "https://reddit.com/u/", hosts: ["reddit.com"] },
  { id: "spotify", name: "Spotify", icon: "🎧", start: "https://open.spotify.com/artist/", hosts: ["open.spotify.com", "spotify.com"] },
  { id: "soundcloud", name: "SoundCloud", icon: "☁️", start: "https://soundcloud.com/", hosts: ["soundcloud.com"] },
  { id: "steam", name: "Steam", icon: "🎮", start: "https://steamcommunity.com/id/", hosts: ["steamcommunity.com", "store.steampowered.com"] },
  { id: "kick", name: "Kick", icon: "🟩", start: "https://kick.com/", hosts: ["kick.com"] },
  { id: "modrinth", name: "Modrinth", icon: "🧩", start: "https://modrinth.com/user/", hosts: ["modrinth.com"] },
  { id: "curseforge", name: "CurseForge", icon: "🔥", start: "https://www.curseforge.com/members/", hosts: ["curseforge.com"] },
  { id: "jace", name: "Jace", icon: "✨", start: "https://jaceo.vercel.app/profile/", hosts: ["jaceo.vercel.app"] },
];
export const WEBSITE: Social = { id: "website", name: "Website", icon: "🌐", start: "https://" };

/** Which site a link is on (its icon and name), or a website. */
export function socialOf(url: string): Social {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return WEBSITE; }
  return SOCIALS.find((s) => s.hosts.some((h) => host === h || host.endsWith(`.${h}`))) ?? WEBSITE;
}

export const MAX_LINKS = 10;
