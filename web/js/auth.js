// Lichess token handling. Tokens never leave the browser except in requests to lichess.org.
// "Log in with Lichess" uses OAuth2 PKCE, which Lichess supports for public clients without registration.
const KEY = "chess-lens:token";
const CLIENT_ID = "chess-lens";

export function getToken() {
  try { return sessionStorage.getItem(KEY) || localStorage.getItem(KEY) || null; } catch { return null; }
}
export function saveToken(token, remember) {
  try {
    forgetToken();
    (remember ? localStorage : sessionStorage).setItem(KEY, token);
  } catch { /* storage blocked: token lives for this page only */ }
  memoryToken = token;
}
export function forgetToken() {
  try { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  memoryToken = null;
}
let memoryToken = null;
export const token = () => getToken() || memoryToken;

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomString = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const redirectUri = () => location.origin + location.pathname;

export async function login({ scopes = [], remember = true } = {}) {
  const verifier = randomString(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = randomString(16);
  sessionStorage.setItem("chess-lens:pkce", JSON.stringify({ verifier, state, remember }));
  const p = new URLSearchParams({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: redirectUri(),
    code_challenge_method: "S256", code_challenge: challenge, state,
  });
  if (scopes.length) p.set("scope", scopes.join(" "));
  location.href = `https://lichess.org/oauth?${p}`;
}

// Call on page load: completes a login redirect if there is one. Returns the token or null.
export async function completeLogin() {
  const p = new URLSearchParams(location.search);
  if (!p.has("code") && !p.has("error")) return null;
  history.replaceState(null, "", redirectUri() + location.hash);
  if (p.has("error")) throw new Error(p.get("error_description") || p.get("error"));
  const saved = JSON.parse(sessionStorage.getItem("chess-lens:pkce") || "null");
  sessionStorage.removeItem("chess-lens:pkce");
  if (!saved || saved.state !== p.get("state")) throw new Error("Login state mismatch; please try again.");
  const res = await fetch("https://lichess.org/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: p.get("code"), code_verifier: saved.verifier,
      redirect_uri: redirectUri(), client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) throw new Error(`Lichess login failed (${res.status})`);
  const { access_token } = await res.json();
  saveToken(access_token, saved.remember);
  return access_token;
}
