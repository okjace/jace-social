"use client";
// Account switcher: the accounts you've signed in with on this device (and bots you own),
// so you can hop between them without signing in again. Tokens stay in this browser.
import { getToken, setToken } from "./client";

export type SavedAccount = { uuid: string; name: string; avatar_url: string | null; token: string; is_bot?: boolean };

const KEY = "jace_social_accounts";
const MAX = 10;

export function savedAccounts(): SavedAccount[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]") as SavedAccount[]; } catch { return []; }
}

function save(list: SavedAccount[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* private mode */ }
}

/** Remember the account that's signed in now (called after loading /me). */
export function rememberAccount(a: Omit<SavedAccount, "token">, token = getToken()) {
  if (!token) return;
  save([{ ...a, token }, ...savedAccounts().filter((x) => x.uuid !== a.uuid)]);
}

export function forgetAccount(uuid: string) {
  save(savedAccounts().filter((x) => x.uuid !== uuid));
}

/**
 * Switch to a saved account. Its saved sign-in is checked first: a bot's stops working when it gets a
 * new token or after 30 days - then a new one is made with the account you're on (if it's yours or
 * you run it). -> null when switching, or what went wrong (the account stays as it is).
 */
export async function switchAccount(uuid: string): Promise<string | null> {
  const a = savedAccounts().find((x) => x.uuid === uuid);
  if (!a) return "That account isn't saved on this device";
  const works = await fetch("/api/v1/me", { headers: { Authorization: `Bearer ${a.token}` } }).then((r) => r.status !== 401).catch(() => true);
  let token = a.token;
  if (!works) {
    const fresh = a.is_bot ? await fetch(`/api/v1/bots/${a.uuid}/session`, {
      method: "POST", headers: { Authorization: `Bearer ${getToken() ?? ""}`, "Content-Type": "application/json" }, body: "{}",
    }).then((r) => (r.ok ? r.json() as Promise<{ token: string }> : null)).catch(() => null) : null;
    if (!fresh?.token) {
      forgetAccount(uuid);
      return a.is_bot
        ? `${a.name}'s sign-in stopped working. Switch to the account that owns it, then switch to ${a.name} again.`
        : `${a.name}'s sign-in expired - add it again with "Add an account".`;
    }
    token = fresh.token;
    save(savedAccounts().map((x) => (x.uuid === uuid ? { ...x, token } : x)));
  }
  setToken(token);
  location.reload();
  return null;
}

/** Sign in to another account: keep this one in the list, show the sign-in screen. */
export function addAnotherAccount() {
  setToken(null);
  location.href = "/app";
}
