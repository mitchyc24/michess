// Game review view: highlights, game browser, board with eval graph, live engine.
import { Chessground } from "./lib.js";
import { db, evalsFor } from "./data.js";
import { findHighlights } from "./highlights.js";
import { startPos, fenOf, posFromFen, parseSanMove, uciToMove, moveToUci, makeSan, cgMove, dests } from "./chess-util.js";
import { winPct, clampCp, judgements as judge } from "./metrics.js";
import { LiveEngine } from "./engine.js";
import { annotatedPgn, download } from "./pgn.js";
import * as lichess from "./lichess.js";
import * as auth from "./auth.js";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const state = {
  game: null, ply: 0, orientation: "white", keyPly: null, note: null,
  variation: null, // { base, nodes: [{ fen, san, uci, last }] }
  engineOn: false, engineLines: null, activeItem: null, highlights: [],
};
let board;
const live = new LiveEngine();
let toast = () => {};

// ---------- formatting ----------

function fmtEval(cp, mate) {
  if (mate != null) return `#${mate}`;
  if (cp == null) return "";
  if (Math.abs(cp) >= 10000) return cp > 0 ? "1-0" : "0-1";
  return (cp > 0 ? "+" : "") + (cp / 100).toFixed(1);
}
function fmtClock(cs) {
  if (cs == null) return "";
  const s = Math.floor(cs / 100);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const base = h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  return s < 10 ? `${base}.${Math.floor((cs % 100) / 10)}` : base;
}
const date = (ms) => new Date(ms).toISOString().slice(0, 10);
const tc = (g) => (g.clock_initial != null ? `${Math.round((g.clock_initial / 60) * 10) / 10}+${g.clock_increment}` : g.speed);
const opp = (g) => `${g.opp_title ? g.opp_title + " " : ""}${g.opp_name}`;
const MARK = { blunder: "??", mistake: "?", inaccuracy: "?!" };
const evalWin = (ev, ply) => winPct(ply === 0 && ev[0] == null && ev[1] == null ? 15 : clampCp(ev[0], ev[1]));

// ---------- highlights ----------

export function renderHighlights() {
  const root = $("#tab-highlights");
  const openKeys = new Set([...root.querySelectorAll("details[open]")].map((d) => d.dataset.key));
  const firstRender = !root.children.length;
  state.highlights = findHighlights();
  root.innerHTML = "";
  if (!db.games.length) {
    root.innerHTML = `<p class="empty-state">No games yet. Open <b>your data</b> (top right) to download them.</p>`;
    return;
  }
  const pending = db.games.filter((g) => g.analysable && !db.analysis.has(g.id)).length;
  state.highlights.forEach((cat, idx) => {
    const d = document.createElement("details");
    d.className = "category";
    d.dataset.key = cat.key;
    d.open = firstRender ? idx < 2 : openKeys.has(cat.key);
    d.innerHTML = `<summary><h3>${esc(cat.title)}</h3><span class="count">${cat.games.length}</span></summary>
      <p class="blurb">${esc(cat.blurb)}</p>`;
    if (cat.engine && pending) d.insertAdjacentHTML("beforeend", `<p class="engine-note">Based on ${db.analysis.size.toLocaleString()} analysed games; ${pending.toLocaleString()} still to analyse.</p>`);
    if (!cat.games.length) d.insertAdjacentHTML("beforeend", `<p class="needs-engine">${cat.engine ? "Needs engine analysis (your data → Start analysis)." : "No games yet."}</p>`);
    const ul = document.createElement("ul");
    ul.className = "game-list";
    cat.games.forEach((g, i) => {
      const li = document.createElement("li");
      li.className = "game-item";
      li.dataset.id = g.id;
      li.innerHTML = `<div class="metric">${i + 1}. ${esc(g.metric)}</div>
        <div class="meta"><span class="badge ${g.result}">${g.result}</span>
        <span>vs ${esc(opp(g))} (${g.opp_rating ?? "?"})</span><span>${tc(g)}</span><span>${date(g.created_at)}</span></div>`;
      li.onclick = () => openGame(g.id, { keyPly: g.key_ply, note: `${cat.title}: ${g.metric}`, item: li });
      ul.appendChild(li);
    });
    d.appendChild(ul);
    if (cat.games.length) {
      const actions = document.createElement("div");
      actions.className = "row-buttons";
      actions.style.margin = "0 16px 10px";
      actions.innerHTML = `<button class="ghost small" data-act="pgn">Download PGN</button><button class="ghost small" data-act="study">Send to Lichess study</button>`;
      actions.querySelector('[data-act="pgn"]').onclick = () => exportCategory(cat);
      actions.querySelector('[data-act="study"]').onclick = (e) => studyCategory(cat, e.target);
      d.appendChild(actions);
    }
    root.appendChild(d);
  });
  if (state.activeItem) {
    const again = root.querySelector(`.game-item[data-id="${state.game?.id}"]`);
    if (again) { again.classList.add("active"); state.activeItem = again; }
  }
}

async function exportCategory(cat) {
  const pgns = [];
  for (const g of cat.games.slice(0, 25)) {
    pgns.push(annotatedPgn(db.byId.get(g.id), await evalsFor(g.id), { note: `${cat.title}: ${g.metric}`, keyPly: g.key_ply }));
  }
  download(`${db.user}-${cat.key}.pgn`, pgns.join("\n"));
}

async function studyCategory(cat, button) {
  const token = auth.token();
  if (!token) return toast("Log in or add a token first (your data).");
  button.disabled = true;
  try {
    const studyId = await lichess.createStudy(token, `${db.displayName}: ${cat.title}`);
    const games = cat.games.slice(0, 20);
    for (const [i, g] of games.entries()) {
      button.textContent = `Sending ${i + 1}/${games.length}…`;
      const pgn = annotatedPgn(db.byId.get(g.id), await evalsFor(g.id),
        { note: `${cat.title} #${i + 1}: ${g.metric}`, keyPly: g.key_ply, event: `#${i + 1} ${g.metric}`.slice(0, 100) });
      await lichess.importPgn(token, studyId, pgn, g.color);
    }
    window.open(`https://lichess.org/study/${studyId}`, "_blank", "noopener");
    toast("Study created on Lichess.");
  } catch (e) {
    if (e.message === "NEEDS_STUDY_SCOPE") {
      if (confirm("Creating studies needs Lichess permission to write studies. Log in again with that permission?")) {
        auth.login({ scopes: ["study:write"] });
      }
    } else toast(e.message);
  } finally {
    button.disabled = false;
    button.textContent = "Send to Lichess study";
  }
}

// ---------- browse ----------

const SORTS = {
  date: (a, b) => b.created_at - a.created_at,
  gap: (a, b) => (b.rating_gap ?? -1e9) - (a.rating_gap ?? -1e9),
  opp: (a, b) => (b.opp_rating ?? 0) - (a.opp_rating ?? 0),
  length: (a, b) => b.plies - a.plies,
  accuracy: (a, b) => (db.analysis.get(b.id)?.my_accuracy ?? -1) - (db.analysis.get(a.id)?.my_accuracy ?? -1),
  comeback: (a, b) => (db.analysis.get(a.id)?.my_min_winpct ?? 101) - (db.analysis.get(b.id)?.my_min_winpct ?? 101),
};
let browseRows = [], browseShown = 0;

export function renderBrowse(reset = true) {
  if (reset) {
    const q = $("#f-q").value.trim().toLowerCase();
    const f = { result: $("#f-result").value, speed: $("#f-speed").value, color: $("#f-color").value };
    const sort = $("#f-sort").value;
    browseRows = db.games.filter((g) =>
      (!f.result || g.result === f.result) && (!f.speed || g.speed === f.speed) && (!f.color || g.color === f.color)
      && (!q || g.id.toLowerCase() === q || g.opp_name.toLowerCase().includes(q)
          || (g.opening ?? "").toLowerCase().includes(q) || (g.eco ?? "").toLowerCase() === q)
      && (!["accuracy", "comeback"].includes(sort) || db.analysis.has(g.id)));
    browseRows.sort(SORTS[sort]);
    browseShown = 0;
    $("#browse-list").innerHTML = "";
  }
  $("#browse-count").textContent = `${browseRows.length.toLocaleString()} games`;
  const ul = $("#browse-list");
  for (const g of browseRows.slice(browseShown, browseShown + 100)) {
    const a = db.analysis.get(g.id);
    const li = document.createElement("li");
    li.className = "game-item";
    li.innerHTML = `<div><span class="badge ${g.result}">${g.result}</span> vs ${esc(opp(g))} (${g.opp_rating ?? "?"})</div>
      <div class="meta"><span>${date(g.created_at)}</span><span>${tc(g)}</span>
      <span>${Math.ceil(g.plies / 2)} moves${a?.my_accuracy != null ? ` · ${a.my_accuracy.toFixed(0)}%` : ""}</span>
      <span>${esc(g.eco ?? "")} ${esc((g.opening ?? "").split(":")[0])}</span></div>`;
    li.onclick = () => openGame(g.id, { item: li });
    ul.appendChild(li);
  }
  browseShown = Math.min(browseRows.length, browseShown + 100);
  $("#browse-more").classList.toggle("hidden", browseShown >= browseRows.length);
}

// ---------- game ----------

async function gameDetail(id) {
  const g = db.byId.get(id);
  if (!g) return null;
  const evals = g.analysable ? await evalsFor(id) : null;
  const pos = startPos(g.initial_fen);
  const whiteFirst = pos.turn === "white";
  const bestFrom = (p, ply) => {
    const u = evals?.[ply]?.[2];
    const m = u && uciToMove(p, u);
    return m ? { best: cgMove(m), best_san: makeSan(p, m) } : { best: null, best_san: null };
  };
  const plies = [{ fen: fenOf(pos), san: null, uci: null, last: null, clock: null, ...bestFrom(pos, 0) }];
  if (g.analysable) {
    g.moves.split(" ").forEach((s, i) => {
      const m = parseSanMove(pos, s);
      const last = cgMove(m);
      pos.play(m);
      plies.push({ fen: fenOf(pos), san: s, uci: moveToUci(m), last, clock: g.clocks?.[i] ?? null, ...bestFrom(pos, i + 1) });
    });
  }
  return { ...g, plies, evals, whiteFirst, chess960: g.variant === "chess960",
           analysis: db.analysis.get(id), judgements: evals ? judge(evals, whiteFirst) : [] };
}

// Phones show one pane at a time: the game list or the board.
let autoOpening = false;
export function setPane(pane) {
  const view = $("#view-review");
  view.dataset.pane = pane;
  view.querySelectorAll(".pane-switch button").forEach((b) => b.classList.toggle("active", b.dataset.pane === pane));
  if (pane === "board") requestAnimationFrame(() => { board.redrawAll(); view.scrollTop = 0; });
}

export async function openGame(id, { keyPly = null, note = null, item = null } = {}) {
  const focus = !autoOpening; // read before awaiting: the flag is reset right after the click
  const game = await gameDetail(id);
  if (!game) return;
  if (focus) setPane("board");
  state.activeItem?.classList.remove("active");
  state.activeItem = item;
  item?.classList.add("active");
  Object.assign(state, { game, keyPly, note, variation: null, orientation: game.color });
  board.set({ orientation: game.color });
  history.replaceState(null, "", `#review/${id}`);
  renderInfo();
  renderMoves();
  renderGraph();
  goTo(keyPly ?? 0);
}

function renderInfo() {
  const g = state.game, a = g.analysis;
  const stat = (label, v) => `<div>${label}<b>${v ?? "–"}</b></div>`;
  $("#game-info").innerHTML = `
    <h2><span class="badge ${g.result}">${g.result}</span> vs ${esc(opp(g))} (${g.opp_rating ?? "?"})</h2>
    <div class="muted">${date(g.created_at)} · ${tc(g)} ${g.rated ? "rated" : "casual"} ${g.variant !== "standard" ? g.variant : ""}
      · ${g.status} · ${Math.ceil((g.plies.length - 1) / 2)} moves</div>
    <div class="muted">${esc(g.eco ?? "")} ${esc(g.opening ?? "")}</div>
    ${state.note ? `<div class="note">&#x2605; ${esc(state.note)}</div>` : ""}
    <div class="stats">
      ${stat("Accuracy", a?.my_accuracy != null ? a.my_accuracy.toFixed(1) + "%" : null)}
      ${stat("Opp. accuracy", a?.opp_accuracy != null ? a.opp_accuracy.toFixed(1) + "%" : null)}
      ${stat("Rating gap", g.rating_gap != null ? (g.rating_gap > 0 ? "+" : "") + g.rating_gap : null)}
      ${stat("Blunders", a?.my_blunders)}
      ${stat("Mistakes", a?.my_mistakes)}
      ${stat("Inaccuracies", a?.my_inaccuracies)}
    </div>
    <div class="links">
      <a href="https://lichess.org/${g.id}${g.color === "black" ? "/black" : ""}" target="_blank" rel="noopener" id="lichess-link">Open on Lichess</a>
      <a href="#" id="pgn-link">Annotated PGN</a>
      <span class="muted">${a ? `evals: ${a.source === "lichess" ? "Lichess server" : "Stockfish (this device)"}` : "not engine-analysed yet"}</span>
    </div>`;
  $("#pgn-link").onclick = (e) => {
    e.preventDefault();
    download(`${g.id}.pgn`, annotatedPgn(g, g.evals, { note: state.note, keyPly: state.keyPly }));
  };
}

function renderMoves() {
  const g = state.game;
  const root = $("#moves");
  root.innerHTML = "";
  const startMove = parseInt(g.plies[0].fen.split(" ")[5], 10) || 1;
  g.plies.forEach((p, ply) => {
    if (ply === 0) return;
    const idx = ply - 1 + (g.whiteFirst ? 0 : 1);
    if (idx % 2 === 0 || ply === 1) {
      root.insertAdjacentHTML("beforeend", `<div class="num">${startMove + Math.floor(idx / 2)}.</div>`);
      if (ply === 1 && !g.whiteFirst) root.insertAdjacentHTML("beforeend", `<div class="mv">…</div>`);
    }
    const j = g.judgements[ply];
    const prevBest = g.plies[ply - 1].best_san;
    const el = document.createElement("div");
    el.className = `mv ${j ?? ""} ${ply === state.keyPly ? "key" : ""}`;
    el.dataset.ply = ply;
    el.title = (j ? j + (prevBest && prevBest !== p.san ? ` (best: ${prevBest})` : "") : "") + (g.evals?.[ply] ? ` eval ${fmtEval(...g.evals[ply])}` : "");
    el.innerHTML = `<span>${esc(p.san)}<span class="j">${j ? MARK[j] : ""}</span></span><span class="clk">${fmtClock(p.clock)}</span>`;
    el.onclick = () => goTo(ply);
    root.appendChild(el);
  });
  const res = g.result === "draw" ? "½-½" : (g.result === "win") === (g.color === "white") ? "1-0" : "0-1";
  root.insertAdjacentHTML("beforeend", `<div class="result">${res} · ${g.status}</div>`);
}

function renderGraph() {
  const g = state.game;
  const root = $("#graph");
  if (!g.evals) {
    root.innerHTML = `<div class="empty">No engine evaluation for this game yet.</div>`;
    return;
  }
  const n = g.evals.length - 1 || 1;
  const pts = g.evals.map((ev, i) => [i, 100 - evalWin(ev, i)]);
  const line = pts.map(([x, y]) => `${x},${y.toFixed(2)}`).join(" ");
  const marks = g.judgements.map((j, i) => (j === "blunder" || j === "mistake")
    ? `<circle cx="${i}" cy="${pts[i][1]}" r="0.9" fill="var(--${j})"/>` : "").join("");
  const key = state.keyPly != null ? `<line x1="${state.keyPly}" x2="${state.keyPly}" y1="0" y2="100" stroke="var(--star)" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-dasharray="3 3"/>` : "";
  root.innerHTML = `<svg viewBox="0 0 ${n} 100" preserveAspectRatio="none">
      <rect x="0" y="0" width="${n}" height="100" fill="#403d39"/>
      <polygon points="0,100 ${line} ${n},100" fill="#d9d5cf"/>
      <line x1="0" x2="${n}" y1="50" y2="50" stroke="#888" stroke-width="0.5" vector-effect="non-scaling-stroke"/>
      ${key}${marks}
      <line id="graph-cursor" x1="0" x2="0" y1="0" y2="100" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    </svg>`;
  const svg = root.querySelector("svg");
  svg.onclick = (e) => {
    const r = svg.getBoundingClientRect();
    goTo(Math.round(((e.clientX - r.left) / r.width) * n));
  };
}

// ---------- navigation ----------

function current() {
  if (state.variation?.nodes.length) return state.variation.nodes.at(-1);
  return state.game.plies[state.ply];
}

function goTo(ply) {
  if (!state.game) return;
  state.variation = null;
  state.ply = Math.max(0, Math.min(state.game.plies.length - 1, ply));
  render();
}

function render() {
  const g = state.game;
  const node = current();
  const pos = posFromFen(node.fen);
  board.set({
    fen: node.fen,
    turnColor: pos.turn,
    lastMove: node.last ?? undefined,
    check: pos.isCheck() ? pos.turn : false,
    movable: { color: pos.turn, dests: dests(pos, g.chess960) },
  });
  board.setAutoShapes(gameShapes());

  document.querySelectorAll(".moves .mv.current").forEach((el) => el.classList.remove("current"));
  if (!state.variation) {
    const el = document.querySelector(`.moves .mv[data-ply="${state.ply}"]`);
    el?.classList.add("current");
    // Scroll only the move list itself (desktop). On phones the page scrolls, and jumping there would be jarring.
    const box = $("#moves");
    if (el && box.scrollHeight > box.clientHeight + 1) {
      const top = el.offsetTop, bottom = top + el.offsetHeight;
      if (top < box.scrollTop) box.scrollTop = top - 8;
      else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 8;
    }
  }
  const cursor = document.getElementById("graph-cursor");
  cursor?.setAttribute("x1", state.ply);
  cursor?.setAttribute("x2", state.ply);

  $("#variation-bar").classList.toggle("hidden", !state.variation);
  if (state.variation) $("#variation-moves").textContent = state.variation.nodes.map((n) => n.san).join(" ");
  const link = document.getElementById("lichess-link");
  if (link) link.href = `https://lichess.org/${g.id}${g.color === "black" ? "/black" : ""}#${state.ply}`;

  renderPlayers();
  state.engineLines = null;
  renderEvalBar(state.variation ? null : g.evals?.[state.ply]);
  if (state.engineOn) requestEngine(node.fen);
}

function gameShapes() {
  if (state.variation || !state.game) return [];
  const best = state.game.plies[state.ply]?.best;
  return best ? [{ orig: best[0], dest: best[1], brush: "paleGreen" }] : [];
}

function renderPlayers() {
  const g = state.game;
  const lastClock = (color) => {
    for (let p = state.ply; p >= 1; p--) {
      const whiteMoved = ((p - 1) % 2 === 0) === g.whiteFirst;
      if ((whiteMoved ? "white" : "black") === color && g.plies[p].clock != null) return g.plies[p].clock;
    }
    return g.clock_initial != null ? g.clock_initial * 100 : null;
  };
  const me = { name: g.my_name, rating: g.my_rating, color: g.color };
  const them = { name: opp(g), rating: g.opp_rating, color: g.color === "white" ? "black" : "white" };
  const [bottom, top] = state.orientation === g.color ? [me, them] : [them, me];
  const html = (p) => `<span>${p.color === "white" ? "&#x26AA;" : "&#x26AB;"} ${esc(p.name)} <span class="rating">${p.rating ?? ""}</span></span>
    <span class="clock">${fmtClock(lastClock(p.color))}</span>`;
  $("#player-top").innerHTML = html(top);
  $("#player-bottom").innerHTML = html(bottom);
}

function renderEvalBar(ev) {
  $("#evalbar").classList.toggle("flipped", state.orientation === "black");
  if (!ev && state.engineLines?.length) ev = [state.engineLines[0].cp, state.engineLines[0].mate];
  if (!ev) {
    $("#evalbar-fill").style.height = "50%";
    $("#evalbar-label").textContent = "";
    return;
  }
  $("#evalbar-fill").style.height = `${evalWin(ev, state.variation ? 1 : state.ply)}%`;
  $("#evalbar-label").textContent = fmtEval(ev[0], ev[1]);
}

function onUserMove(orig, dest) {
  const g = state.game;
  if (!g) return;
  const node = current();
  const pos = posFromFen(node.fen);
  const move = uciToMove(pos, orig + dest);
  if (!move) return render();
  const uci = moveToUci(move);
  const next = g.plies[state.ply + 1];
  if (!state.variation && next && next.uci === uci) return goTo(state.ply + 1);
  const san = makeSan(pos, move);
  const last = cgMove(move);
  pos.play(move);
  state.variation ??= { base: state.ply, nodes: [] };
  state.variation.nodes.push({ fen: fenOf(pos), san, uci, last });
  render();
}

// ---------- live engine ----------

let engineTimer;
function requestEngine(fen) {
  clearTimeout(engineTimer);
  $("#engine-lines").innerHTML = `<div class="muted">thinking…</div>`;
  engineTimer = setTimeout(() => {
    live.analyse(fen, {
      ms: 2500,
      onUpdate: (lines, over) => {
        if (current().fen !== fen || !state.engineOn) return;
        if (over) { $("#engine-lines").innerHTML = `<div class="muted">Game over.</div>`; return; }
        if (!lines.length) return;
        state.engineLines = lines;
        $("#engine-lines").innerHTML = lines.map((l) => `<div class="line"><span class="score">${fmtEval(l.cp, l.mate)}</span><span>${esc(l.san)}</span></div>`).join("")
          + `<div class="muted">depth ${lines[0].depth} · Stockfish 19 lite (this device)</div>`;
        const top = lines[0].uci?.[0];
        const pos = posFromFen(fen);
        const m = top && uciToMove(pos, top);
        board.setAutoShapes(m ? [{ orig: cgMove(m)[0], dest: cgMove(m)[1], brush: "blue" }] : []);
        if (state.variation || !state.game.evals) renderEvalBar(null);
      },
    });
  }, 150);
}

// ---------- controls ----------

function nav(action) {
  const g = state.game;
  if (!g) return;
  if (action === "flip") {
    state.orientation = state.orientation === "white" ? "black" : "white";
    board.set({ orientation: state.orientation });
    renderPlayers();
    renderEvalBar(state.variation ? null : g.evals?.[state.ply]);
    return;
  }
  if (state.variation && action === "prev") {
    state.variation.nodes.pop();
    if (!state.variation.nodes.length) return goTo(state.variation.base);
    return render();
  }
  const base = state.variation?.base ?? state.ply;
  if (action === "start") goTo(0);
  if (action === "prev") goTo(base - 1);
  if (action === "next") goTo(base + 1);
  if (action === "end") goTo(g.plies.length - 1);
  if (action === "key" && state.keyPly != null) goTo(state.keyPly);
}

export function init({ showToast }) {
  toast = showToast;
  board = Chessground($("#board"), {
    coordinates: true,
    movable: { free: false, color: "both", showDests: true, events: { after: onUserMove } },
    draggable: { showGhost: true },
    highlight: { lastMove: true, check: true },
    animation: { duration: 150 },
  });
  document.querySelectorAll("#view-review .tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll("#view-review .tab").forEach((x) => x.classList.toggle("active", x === t));
      $("#tab-highlights").classList.toggle("hidden", t.dataset.tab !== "highlights");
      $("#tab-browse").classList.toggle("hidden", t.dataset.tab !== "browse");
      if (t.dataset.tab === "browse") renderBrowse(true);
    };
  });
  let timer;
  for (const id of ["#f-q", "#f-result", "#f-speed", "#f-color", "#f-sort"]) {
    $(id).addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => renderBrowse(true), 200); });
  }
  $("#browse-more").onclick = () => renderBrowse(false);
  document.querySelectorAll("#view-review .pane-switch button").forEach((b) => (b.onclick = () => setPane(b.dataset.pane)));
  window.addEventListener("resize", () => board.redrawAll());
  $("#variation-exit").onclick = () => goTo(state.variation?.base ?? state.ply);
  $("#engine-on").onchange = (e) => {
    state.engineOn = e.target.checked;
    state.engineLines = null;
    $("#engine-lines").innerHTML = "";
    if (state.engineOn && state.game) requestEngine(current().fen);
    else { live.stop(); if (state.game) board.setAutoShapes(gameShapes()); }
  };
  document.querySelectorAll("[data-nav]").forEach((b) => (b.onclick = () => nav(b.dataset.nav)));
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea") || $("#view-review").classList.contains("hidden")) return;
    const map = { ArrowLeft: "prev", ArrowRight: "next", Home: "start", End: "end", f: "flip", k: "key" };
    if (map[e.key]) { e.preventDefault(); nav(map[e.key]); }
  });
}

// Called when the view becomes visible or data changes.
export function show(gameId) {
  board.redrawAll();
  if (gameId && gameId !== state.game?.id) return openGame(gameId);
  if (!state.game) {
    const first = $("#tab-highlights .game-item");
    if (first) {
      // Preload the top highlight without leaving the list on phones.
      autoOpening = true;
      first.click();
      setTimeout(() => { autoOpening = false; }, 0);
    }
  }
}

export async function refreshAnalysis(gameId) {
  // A game we're looking at just got analysed: reload it in place, keeping the current move.
  if (state.game?.id !== gameId || state.variation) return;
  const ply = state.ply;
  await openGame(gameId, { keyPly: state.keyPly, note: state.note, item: state.activeItem });
  goTo(ply);
}
