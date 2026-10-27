// The newest desktop / phone app release on GitHub (for the homepage's downloads and the apps'
// update checks), cached by Next for 10 minutes so visitors don't each ask GitHub.
import type { Download } from "@/components/Downloads";

export const REPO = "okjace/jace-social";
export const PLATFORMS = [
  { id: "windows", suffix: "-windows-x64.exe", label: "Windows", note: "10 / 11" },
  { id: "mac-arm", suffix: "-macos-arm64.app.zip", label: "macOS", note: "Apple Silicon" },
  { id: "mac-intel", suffix: "-macos-x86_64.app.zip", label: "macOS", note: "Intel" },
  { id: "linux", suffix: "-x86_64.AppImage", label: "Linux", note: "AppImage" },
];
export const PHONE = [
  { id: "android", suffix: "-android.apk", label: "Android", note: "APK" },
  { id: "ios", suffix: "-ios-unsigned.ipa", label: "iPhone", note: "for sideloading" },
  { id: "ios12", suffix: "-ios12-unsigned.ipa", label: "iPhone, iOS 12 to 15", note: "older iPhones" },
];

export type Release = { version: string; page: string; notes: string; downloads: Download[] };

/** The newest release for the desktop app (app-v*) or the phone app (mobile-v*). */
export async function latestApp(prefix = "app-v", platforms = PLATFORMS): Promise<Release | null> {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "jace-social-site" }, next: { revalidate: 600 },
    });
    if (!r.ok) return null;
    const rels = await r.json() as { tag_name: string; draft: boolean; prerelease: boolean; html_url: string; body: string | null;
      assets: { name: string; browser_download_url: string; size: number }[] }[];
    const rel = rels.find((x) => x.tag_name.startsWith(prefix) && !x.draft && !x.prerelease);
    if (!rel) return null;
    const downloads = platforms.flatMap((p) => {
      const a = rel.assets.find((x) => x.name.endsWith(p.suffix));
      return a ? [{ id: p.id, url: a.browser_download_url, label: p.label, note: p.note, mb: Math.round(a.size / 1048576) }] : [];
    });
    return { version: rel.tag_name.slice(prefix.length), page: rel.html_url, notes: rel.body ?? "", downloads };
  } catch {
    return null;
  }
}
