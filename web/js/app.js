// App shell: setup / login, routing between views, background download + analysis jobs.
import * as auth from "./auth.js";
import * as data from "./data.js";
import { db } from "./data.js";
import * as lichess from "./lichess.js";
import * as review from "./review.js";
import * as tree from "./tree.js";
import { analyseGames, defaultWorkers } from "./engine.js";
import { persist } from "./store.js";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ls = {
  get: (k, d = null) => { try { return localStorage.getItem(`chess-lens:${k}`) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`chess-lens:${k}`, v); } catch { /* ignore */ } },
  del: (k) => { try { localStorage.removeItem(`chess-lens:${k}`); } catch { /* ignore */ } },
};

// ---------- toast ----------

let toastTimer;
function showToast(msg, ms = 4000) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}

// ---------- routing ----------

let currentView = null;
function route() {
  if (!db.user) return showView("setup");
  const [view, arg] = location.hash.replace(/^#/, "").split("/");
  showView(view === "tree" ? "tree" : "review", arg);
}

function showView(name, arg) {
  for (const v of ["setup", "review", "tree"]) $(`#view-${v}`).classList.toggle("hidden", v !== name);
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === name));
  $("#nav").classList.toggle("hidden", name === "setup");
  if (currentView === "tree" && name !== "tree") tree.hide();
  currentView = name;
  if (name === "review") review.show(arg);
  if (name === "tree") tree.show();
  if (name === "setup") renderKnownUsers();
}
window.addEventListener("hashchange", route);

// ---------- header ----------

function renderHeader() {
  $("#user-label").textContent = db.user ? `${db.displayName} · ${db.games.length.toLocaleString()} games` : "Set up";
}

const job = { kind: null, controller: null, abort: null, wakeLock: null };
function setJob(text, fraction) {
  $("#job").classList.toggle("hidden", !text);
  $("#job-text").textContent = text || "";
  $("#job-fill").style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}
$("#job").onclick = () => openDialog();

const fmtDuration = (s) => {
  if (!isFinite(s)) return "…";
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
};

// ---------- jobs ----------

async function runSync() {
  if (job.kind) return;
  const token = auth.token();
  if (!token) { showToast("Lichess needs a token to download games. Log in or paste a token."); return showView("setup"); }
  job.kind = "sync";
  job.abort = new AbortController();
  renderDialog();
  setJob("Downloading games…", 0);
  try {
    const n = await data.sync({
      username: db.displayName || db.user, token, signal: job.abort.signal,
      onProgress: ({ fetched, expected }) => {
        setJob(`Downloading games… ${fetched.toLocaleString()}${expected ? ` / ${expected.toLocaleString()}` : ""}`, expected ? fetched / expected : 0);
        renderHeader();
      },
    });
    showToast(n ? `Downloaded ${n.toLocaleString()} new games.` : "No new games.");
  } catch (e) {
    if (e.name !== "AbortError") showToast(e.message, 8000);
  } finally {
    job.kind = null;
    setJob(null);
    review.renderHighlights();
    tree.invalidate();
    renderHeader();
    renderDialog();
  }
  if (data.pendingAnalysis().length && ls.get("autoAnalyse", "1") === "1") runAnalysis();
}

let lastRefresh = 0;
async function runAnalysis() {
  if (job.kind) return;
  const games = data.pendingAnalysis();
  if (!games.length) return showToast("Every game is already analysed.");
  const nodes = +$("#nodes").value;
  const workers = +$("#workers").value;
  job.kind = "analyse";
  try { job.wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* not supported */ }
  setJob(`Analysing ${games.length.toLocaleString()} games…`, 0);
  renderDialog();
  const total = games.length;
  let done = 0;
  job.controller = analyseGames(games, {
    nodes, workers,
    onGame: async (game, evals) => {
      await data.saveEngineAnalysis(game, evals, nodes);
      done++;
      review.refreshAnalysis(game.id);
      if (performance.now() - lastRefresh > 20000) { lastRefresh = performance.now(); review.renderHighlights(); }
    },
    onProgress: ({ donePositions, total: positions, eta }) => {
      setJob(`Analysing · ${done.toLocaleString()} / ${total.toLocaleString()} games · ~${fmtDuration(eta)} left`, donePositions / positions);
      if ($("#data-dialog").open) renderDialog();
    },
  });
  await job.controller.promise;
  job.kind = null;
  job.controller = null;
  job.wakeLock?.release?.();
  setJob(null);
  review.renderHighlights();
  renderDialog();
  showToast(data.pendingAnalysis().length ? "Analysis paused. Resume any time from your data." : "Analysis complete.");
}

function stopJob() {
  if (job.kind === "analyse") { job.controller?.stop(); setJob("Stopping after the current games…", 1); }
  if (job.kind === "sync") job.abort?.abort();
}

window.addEventListener("beforeunload", (e) => { if (job.kind) { e.preventDefault(); e.returnValue = ""; } });

// ---------- data dialog ----------

function openDialog() {
  renderDialog();
  if (!$("#data-dialog").open) $("#data-dialog").showModal();
}
$("#open-data").onclick = () => (db.user ? openDialog() : showView("setup"));

function renderDialog() {
  const token = auth.token();
  const remembered = (() => { try { return !!localStorage.getItem("chess-lens:token"); } catch { return false; } })();
  $("#acct-line").innerHTML = db.user
    ? `Player <b>${esc(db.displayName)}</b> · token ${token ? (remembered ? "saved on this device" : "kept for this session") : "<b>not set</b>"}`
    : "No player selected.";
  const lastSync = db.games[0] ? new Date(db.games[0].created_at).toLocaleDateString() : "–";
  $("#games-line").textContent = `${db.games.length.toLocaleString()} games stored · newest from ${lastSync}`;
  const analysable = db.games.filter((g) => g.analysable).length;
  const fromLichess = [...db.analysis.values()].filter((a) => a.source === "lichess").length;
  $("#analysis-line").textContent = `${db.analysis.size.toLocaleString()} of ${analysable.toLocaleString()} games analysed`
    + (fromLichess ? ` (${fromLichess.toLocaleString()} reused from Lichess server analysis)` : "") + ".";
  $("#sync-btn").textContent = job.kind === "sync" ? "Stop download" : "Download new games";
  $("#sync-btn").disabled = job.kind === "analyse";
  const pending = data.pendingAnalysis().length;
  $("#analyse-btn").textContent = job.kind === "analyse" ? "Pause analysis" : pending ? `Analyse ${pending.toLocaleString()} games` : "All games analysed";
  $("#analyse-btn").disabled = job.kind === "sync" || (!pending && job.kind !== "analyse");
  $("#nodes").disabled = $("#workers").disabled = job.kind === "analyse";
}

$("#sync-btn").onclick = () => (job.kind === "sync" ? stopJob() : runSync());
$("#analyse-btn").onclick = () => (job.kind === "analyse" ? stopJob() : runAnalysis());
$("#forget-token").onclick = () => { auth.forgetToken(); renderDialog(); showToast("Token removed from this browser."); };
$("#switch-user").onclick = () => { if (job.kind) return showToast("Stop the running job first."); $("#data-dialog").close(); showView("setup"); };
$("#delete-data").onclick = async () => {
  if (job.kind) return showToast("Stop the running job first.");
  if (!confirm(`Delete all games and analysis for ${db.displayName} from this browser?`)) return;
  const name = db.displayName;
  await data.forget(name);
  await data.forgetUser(name);
  ls.del("user");
  $("#data-dialog").close();
  renderHeader();
  route();
};

// Engine settings (remembered per device)
const maxWorkers = Math.max(1, Math.min(16, navigator.hardwareConcurrency || 4));
$("#workers").max = maxWorkers;
$("#workers").value = Math.min(maxWorkers, +ls.get("workers", defaultWorkers()));
$("#workers-out").textContent = $("#workers").value;
$("#workers").oninput = (e) => { $("#workers-out").textContent = e.target.value; ls.set("workers", e.target.value); };
$("#nodes").value = ls.get("nodes", "25000");
$("#nodes").onchange = (e) => ls.set("nodes", e.target.value);

// ---------- setup ----------

async function startWith(username, { autoSync = true } = {}) {
  ls.set("user", username);
  await data.rememberUser(username);
  await data.load(username);
  renderHeader();
  review.renderHighlights();
  tree.invalidate();
  if (!location.hash || location.hash === "#") location.hash = "#review";
  route();
  if (autoSync) runSync();
}

async function renderKnownUsers() {
  const users = await data.knownUsers();
  const box = $("#known-users");
  box.classList.toggle("hidden", !users.length);
  box.innerHTML = users.length ? `<span class="muted">Already on this device:</span> ` : "";
  for (const u of users) {
    const b = document.createElement("button");
    b.className = "ghost small";
    b.textContent = u;
    b.onclick = () => startWith(u, { autoSync: false });
    box.appendChild(b);
  }
}

function setupError(msg) {
  $("#setup-error").textContent = msg;
  $("#setup-error").classList.toggle("hidden", !msg);
}

$("#setup-form").onsubmit = async (e) => {
  e.preventDefault();
  setupError("");
  const username = $("#setup-user").value.trim();
  const tokenValue = $("#setup-token").value.trim();
  if (!tokenValue && !auth.token()) return setupError("Paste a token, or use “Log in with Lichess”.");
  try {
    if (tokenValue) {
      await lichess.account(tokenValue); // validates the token
      auth.saveToken(tokenValue, $("#setup-remember").checked);
    }
    const info = await lichess.user(username, auth.token());
    $("#setup-token").value = "";
    await persist();
    await startWith(info.username);
  } catch (err) {
    setupError(err.message);
  }
};

$("#login-lichess").onclick = () => {
  try { sessionStorage.setItem("chess-lens:pending-user", $("#setup-user").value.trim()); } catch { /* ignore */ }
  auth.login({ remember: $("#setup-remember").checked });
};

// ---------- boot ----------

async function boot() {
  review.init({ showToast });
  data.onChange(() => renderHeader());
  let loggedIn = null;
  try {
    const token = await auth.completeLogin();
    if (token) {
      const acct = await lichess.account(token);
      let wanted = "";
      try { wanted = sessionStorage.getItem("chess-lens:pending-user") || ""; sessionStorage.removeItem("chess-lens:pending-user"); } catch { /* ignore */ }
      loggedIn = wanted || acct.username;
      showToast(`Logged in to Lichess as ${acct.username}.`);
    }
  } catch (e) {
    showView("setup");
    setupError(e.message);
  }
  if (loggedIn) {
    await persist();
    const info = await lichess.user(loggedIn, auth.token()).catch(() => ({ username: loggedIn }));
    return startWith(info.username);
  }
  const saved = ls.get("user");
  if (saved) {
    await data.load(saved);
    renderHeader();
    review.renderHighlights();
    route();
  } else {
    route();
  }
}

boot();
