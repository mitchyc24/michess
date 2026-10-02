// Lichess API calls (all CORS-enabled).
const API = "https://lichess.org";
const auth = (token) => (token ? { Authorization: `Bearer ${token}` } : {});

export async function account(token) {
  const r = await fetch(`${API}/api/account`, { headers: auth(token) });
  if (r.status === 401) throw new Error("That token was rejected by Lichess.");
  if (!r.ok) throw new Error(`Lichess /api/account: ${r.status}`);
  return r.json();
}

export async function user(username, token) {
  const r = await fetch(`${API}/api/user/${encodeURIComponent(username)}`, { headers: auth(token) });
  if (r.status === 404) throw new Error(`No Lichess user named “${username}”.`);
  if (!r.ok) throw new Error(`Lichess /api/user: ${r.status}`);
  return r.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stream games oldest-first from `since`, calling onGame(rawGame) for each. Resumes after dropped connections.
export async function streamGames({ username, token, since, onGame, signal }) {
  const params = new URLSearchParams({ evals: "true", accuracy: "true", clocks: "true", opening: "true", sort: "dateAsc" });
  let cursor = since;
  for (let attempt = 0; ; attempt++) {
    if (cursor) params.set("since", cursor);
    let res;
    try {
      res = await fetch(`${API}/api/games/user/${encodeURIComponent(username)}?${params}`, {
        headers: { Accept: "application/x-ndjson", ...auth(token) }, signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt > 5) throw e;
      await sleep(3000);
      continue;
    }
    if (res.status === 429) { await sleep(60000); continue; }
    if (res.status === 401) throw new Error("Lichess rejected the token. Log in again or paste a new token.");
    if (res.status === 404) throw new Error(token ? `No games found for “${username}”.` : "Lichess requires a token to download games.");
    if (!res.ok) throw new Error(`Lichess game export failed: ${res.status}`);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const game = JSON.parse(line);
          cursor = game.createdAt + 1;
          await onGame(game);
        }
      }
      return;
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt > 5) throw e;
      await sleep(3000); // connection dropped mid-stream: resume after the last game we saw
    }
  }
}

export async function createStudy(token, name) {
  const r = await fetch(`${API}/api/study`, {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: name.slice(0, 100), visibility: "unlisted", computer: "everyone",
      explorer: "everyone", cloneable: "everyone", shareable: "everyone", chat: "everyone" }),
  });
  if (r.status === 401 || r.status === 403) throw new Error("NEEDS_STUDY_SCOPE");
  if (!r.ok) throw new Error(`Could not create study (${r.status})`);
  return (await r.json()).id;
}

export async function importPgn(token, studyId, pgn, orientation) {
  for (;;) {
    const r = await fetch(`${API}/api/study/${studyId}/import-pgn`, {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ pgn, orientation }),
    });
    if (r.status === 429) { await sleep(60000); continue; }
    if (!r.ok) throw new Error(`Study import failed (${r.status})`);
    return;
  }
}
