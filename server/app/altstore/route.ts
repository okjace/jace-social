// GET /altstore: an AltStore / SideStore "source" for the iPhone app. Add it once (in AltStore or
// SideStore: Sources -> +, or the button in the app's You tab) and new versions show up there as
// updates, installed with one tap - no downloading .ipa files. Built from the GitHub releases
// (mobile-v2.0.0 and newer: the native app). Two apps: Jace Social (iOS 16+) and Jace Social for
// older iPhones (ios12/, iOS 12.2+ - AltStore's own minimum). Public; cached.
import { REPO } from "@/lib/releases";
import { siteUrl } from "@/lib/server";

const BUNDLE = "dev.jacedeb.jacesocial";
const BUNDLE_12 = "dev.jacedeb.jacesocial.ios12";

type GhRelease = { tag_name: string; draft: boolean; prerelease: boolean; published_at: string; body: string | null;
  assets: { name: string; browser_download_url: string; size: number }[] };

export async function GET() {
  const site = siteUrl();
  let rels: GhRelease[] = [];
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "jace-social-site" }, next: { revalidate: 600 },
    });
    if (r.ok) rels = await r.json() as GhRelease[];
  } catch { /* an empty source until GitHub answers */ }

  /** Every version of one of the apps (its .ipa ends with `suffix`), newest first. */
  const versionsOf = (suffix: string, minOS: string) => rels
    .filter((x) => x.tag_name.startsWith("mobile-v") && !x.draft && !x.prerelease)
    .map((x) => ({ x, v: x.tag_name.slice("mobile-v".length), ipa: x.assets.find((a) => a.name.endsWith(suffix)) }))
    .filter(({ v, ipa }) => ipa && Number(v.split(".")[0]) >= 2)          // 1.x was the old app (the website in a frame)
    .sort((a, b) => compare(b.v, a.v))
    .map(({ x, v, ipa }) => {
      const [ma, mi, pa] = v.split(".").map(Number);
      return {
        version: v, buildVersion: String(ma * 10000 + mi * 100 + pa), date: x.published_at,
        localizedDescription: (x.body ?? "").trim() || `Jace Social ${v}`,
        downloadURL: ipa!.browser_download_url, size: ipa!.size, minOSVersion: minOS,
      };
    });
  const versions = versionsOf("-ios-unsigned.ipa", "16.0");
  const versions12 = versionsOf("-ios12-unsigned.ipa", "12.2");
  const latest = versions[0];
  const latest12 = versions12[0];
  const description = "Friends, chat and servers - with Minecraft built in. Messages, group chats, servers with voice " +
    "channels, calls with your camera, bots, and your friends' Minecraft activity.";

  const source = {
    name: "Jace Social", identifier: `${BUNDLE}.source`, subtitle: "The Jace Social app for iPhone",
    sourceURL: `${site}/altstore`, iconURL: `${site}/logo.png`, website: site, tintColor: "#3ddc84",
    description: "Add this source to get Jace Social and its updates.",
    apps: [{
      name: "Jace Social", bundleIdentifier: BUNDLE, developerName: "Jace", subtitle: "Friends, chat and servers",
      localizedDescription: description, iconURL: `${site}/logo.png`, tintColor: "#3ddc84", category: "social",
      screenshots: [],
      versions,
      // the older single-version fields, for older AltStore and SideStore
      ...(latest ? { version: latest.version, versionDate: latest.date, versionDescription: latest.localizedDescription,
                     downloadURL: latest.downloadURL, size: latest.size } : {}),
      appPermissions: {
        entitlements: [],
        privacy: {
          NSMicrophoneUsageDescription: "Jace Social uses the microphone for voice calls and voice channels.",
          NSCameraUsageDescription: "Jace Social uses the camera when you turn it on in a call.",
          NSPhotoLibraryUsageDescription: "Jace Social lets you pick photos to send in chat.",
        },
      },
    }, ...(versions12.length ? [{
      name: "Jace Social (iOS 12)", bundleIdentifier: BUNDLE_12, developerName: "Jace", subtitle: "For older iPhones (iOS 12 to 15)",
      localizedDescription: "Jace Social for iPhones that can't run the main app (iPhone 5s, 6 and up, iOS 12.2+). " + description,
      iconURL: `${site}/logo.png`, tintColor: "#3ddc84", category: "social", screenshots: [],
      versions: versions12,
      version: latest12.version, versionDate: latest12.date, versionDescription: latest12.localizedDescription,
      downloadURL: latest12.downloadURL, size: latest12.size,
      appPermissions: {
        entitlements: [],
        privacy: {
          NSMicrophoneUsageDescription: "Jace Social uses the microphone for calls and voice channels.",
          NSCameraUsageDescription: "Jace Social uses the camera for photos in chat and video in calls.",
          NSPhotoLibraryUsageDescription: "Jace Social lets you pick photos to send in chat.",
        },
      },
    }] : [])],
    news: [],
  };
  return Response.json(source, { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=3600" } });
}

function compare(a: string, b: string) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}
