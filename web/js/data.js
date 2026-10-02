// In-memory working set for the current user, backed by IndexedDB.
import * as store from "./store.js";
import * as lichess from "./lichess.js";
import { toRecord } from "./ingest.js";
import { computeMetrics } from "./metrics.js";
import { startPos } from "./chess-util.js";

export const db = {
  user: null,        // lowercased id
  displayName: null,
  games: [],         // newest first
  byId: new Map(),
  analysis: new Map(),
};

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const changed = (what) => listeners.forEach((fn) => fn(what));

export async function load(user) {
  const uid = user.toLowerCase();
  const [games, analysis] = await Promise.all([store.allForUser("games", uid), store.allForUser("analysis", uid)]);
  games.sort((a, b) => b.created_at - a.created_at);
  db.user = uid;
  db.displayName = games[0]?.my_name ?? user;
  db.games = games;
  db.byId = new Map(games.map((g) => [g.id, g]));
  db.analysis = new Map(analysis.map((a) => [a.id, a]));
  changed("load");
}

// Download games newer than the newest one stored. onProgress({ fetched, expected }).
export async function sync({ username, token, onProgress, signal }) {
  const uid = username.toLowerCase();
  if (db.user !== uid) await load(username);
  const meta = (await store.getMeta(`sync:${uid}`)) || {};
  let expected = null;
  try { expected = (await lichess.user(username, token)).count?.all ?? null; } catch (e) {
    if (/No Lichess user/.test(e.message)) throw e;
  }
  let fetched = 0, newest = meta.newest || 0;
  const before = db.games.length;
  const expectedNew = () => (expected != null ? Math.max(fetched, expected - before) : null);
  let batch = { games: [], analysis: [], evals: [] };

  const flush = async () => {
    if (!batch.games.length) return;
    await store.putMany("games", batch.games);
    await store.putMany("analysis", batch.analysis);
    await store.putMany("evals", batch.evals);
    for (const g of batch.games) { db.byId.set(g.id, g); db.games.push(g); }
    for (const a of batch.analysis) db.analysis.set(a.id, a);
    db.games.sort((a, b) => b.created_at - a.created_at);
    await store.setMeta(`sync:${uid}`, { newest, synced_at: Date.now() });
    batch = { games: [], analysis: [], evals: [] };
    changed("games");
  };

  await lichess.streamGames({
    username, token, signal,
    since: newest ? newest + 1 : undefined,
    onGame: async (raw) => {
      newest = Math.max(newest, raw.createdAt);
      fetched++;
      if (!db.byId.has(raw.id)) {
        const r = toRecord(raw, username);
        if (r) {
          batch.games.push(r.record);
          if (r.analysis) { batch.analysis.push(r.analysis); batch.evals.push(r.evals); }
          if (!db.displayName || db.displayName === username) db.displayName = r.record.my_name;
        }
      }
      if (batch.games.length >= 250) await flush();
      if (fetched % 25 === 0) onProgress?.({ fetched, expected: expectedNew() });
    },
  });
  await flush();
  onProgress?.({ fetched, expected: fetched, done: true });
  return fetched;
}

export function pendingAnalysis() {
  return db.games.filter((g) => g.analysable && !db.analysis.has(g.id));
}

export async function saveEngineAnalysis(game, evals, nodes) {
  const whiteFirst = startPos(game.initial_fen).turn === "white";
  const a = { id: game.id, user: game.user, source: "stockfish", engine_limit: `nodes=${nodes}`,
              analysed_at: Date.now(), ...computeMetrics(evals, game.color === "white", whiteFirst) };
  await store.put("evals", { id: game.id, user: game.user, evals });
  await store.put("analysis", a);
  db.analysis.set(game.id, a);
}

export async function evalsFor(id) {
  return (await store.get("evals", id))?.evals ?? null;
}

export async function forget(user) {
  await store.deleteUser(user.toLowerCase());
  if (db.user === user.toLowerCase()) {
    Object.assign(db, { user: null, displayName: null, games: [], byId: new Map(), analysis: new Map() });
    changed("load");
  }
}

export const knownUsers = () => store.getMeta("users").then((u) => u || []);
export async function rememberUser(name) {
  const users = (await knownUsers()).filter((u) => u.toLowerCase() !== name.toLowerCase());
  await store.setMeta("users", [name, ...users]);
}
export async function forgetUser(name) {
  await store.setMeta("users", (await knownUsers()).filter((u) => u.toLowerCase() !== name.toLowerCase()));
}
