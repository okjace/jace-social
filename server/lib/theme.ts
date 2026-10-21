"use client";
// Your look: theme, accent color, text size, compact mode and less motion (Settings ->
// Appearance). Saved with your account, applied by swapping the CSS variables in globals.css.
import type { Settings } from "./client";

type Palette = Record<string, string>;

const THEMES: Record<"dark" | "light" | "midnight" | "forest", Palette> = {
  dark: {},   // the defaults in globals.css
  midnight: {
    "--bg": "#000000", "--bg2": "#07080a", "--panel": "#0e1013", "--panel2": "#16191e", "--line": "#20242b", "--line2": "#262b33",
    "--hover": "#121418", "--float": "#101216", "--deep": "#000000", "--me-bg": "#050608", "--btn": "#1a1e24", "--btn-hover": "#232830",
    "--btn-line": "#2a2f38",
  },
  forest: {
    "--bg": "#0e1512", "--bg2": "#121b17", "--panel": "#17221d", "--panel2": "#1d2a24", "--line": "#26362e", "--line2": "#2c3e35",
    "--hover": "#1a2620", "--float": "#17221d", "--deep": "#0a100d", "--me-bg": "#0f1714", "--btn": "#22322a", "--btn-hover": "#2a3d33",
    "--btn-line": "#30453a", "--muted": "#8ea398",
  },
  light: {
    "--bg": "#e9ebef", "--bg2": "#f2f3f5", "--panel": "#ffffff", "--panel2": "#ebedf0", "--line": "#d5d9df", "--line2": "#c9ced6",
    "--text": "#1d2127", "--muted": "#5e6672", "--gray": "#8a919b", "--hover": "#f4f5f7", "--float": "#ffffff", "--deep": "#d8dbe0",
    "--me-bg": "#e6e8ec", "--btn": "#e3e6ea", "--btn-hover": "#d8dce1", "--btn-line": "#ccd1d8", "--green-dim": "#dff5e8",
    "--shadow": "rgba(20, 24, 31, .18)", "--backdrop": "rgba(20, 24, 31, .45)", "--mention-bg": "rgba(224, 180, 74, .18)",
  },
};

const ALL_KEYS = new Set(Object.values(THEMES).flatMap((t) => Object.keys(t)));

function lighten(hex: string, amount: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * amount));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Readable text on the accent color (dark on light accents, white on dark ones). */
function onColor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? "#0c1410" : "#ffffff";
}

export function applySettings(s: Settings) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  let theme = s.theme ?? "dark";
  if (theme === "system") theme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  for (const k of ALL_KEYS) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(THEMES[theme as keyof typeof THEMES] ?? {})) root.style.setProperty(k, v);
  root.style.colorScheme = theme === "light" ? "light" : "dark";
  if (s.accent && /^#[0-9a-fA-F]{6}$/.test(s.accent)) {
    root.style.setProperty("--green", s.accent);
    root.style.setProperty("--accent-hover", lighten(s.accent, 0.2));
    root.style.setProperty("--on-accent", onColor(s.accent));
  } else {
    for (const k of ["--green", "--accent-hover", "--on-accent"]) root.style.removeProperty(k);
  }
  // Background picture: the panels go see-through (background_opacity is how solid they stay)
  if (s.background) {
    root.style.setProperty("--bg-image", `url("${s.background.replace(/["\\]/g, "")}")`);
    root.style.setProperty("--panel-alpha", `${Math.round(Math.max(0.2, Math.min(1, s.background_opacity ?? 0.8)) * 100)}%`);
    root.dataset.bgimage = "1";
  } else {
    root.style.removeProperty("--bg-image"); root.style.removeProperty("--panel-alpha"); root.dataset.bgimage = "";
  }
  applyCustomCss(s.custom_css ?? "");
  root.dataset.theme = theme;
  root.dataset.compact = s.compact ? "1" : "";
  root.dataset.motion = s.reduce_motion ? "reduce" : "";
  root.dataset.avatars = s.show_avatars === false ? "off" : "";
  document.body.style.zoom = String(Math.max(0.8, Math.min(1.4, s.font_scale ?? 1)));
}

/** Your custom CSS, after everything else. Open the app with ?nocss to start without it (if it hid something). */
export const cssDisabled = () => typeof location !== "undefined" && new URLSearchParams(location.search).has("nocss");
function applyCustomCss(css: string) {
  let el = document.getElementById("custom-css") as HTMLStyleElement | null;
  if (!css.trim() || cssDisabled()) { el?.remove(); return; }
  if (!el) { el = document.createElement("style"); el.id = "custom-css"; document.head.appendChild(el); }
  else document.head.appendChild(el);   // keep it last so it wins
  if (el.textContent !== css) el.textContent = css;
}

export const THEME_NAMES: [NonNullable<Settings["theme"]>, string, string][] = [
  ["dark", "Dark", "#1c1f26"], ["midnight", "Midnight", "#0e1013"], ["forest", "Forest", "#17221d"],
  ["light", "Light", "#ffffff"], ["system", "Match my computer", "linear-gradient(135deg, #ffffff 50%, #1c1f26 50%)"],
];

export const ACCENTS = ["#3ddc84", "#4f8fd6", "#b07cf0", "#e0605a", "#e0b44a", "#ef7fb4", "#3cc8d8", "#f08a3c"];
