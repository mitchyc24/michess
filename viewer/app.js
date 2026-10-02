import { Chessground } from "https://cdn.jsdelivr.net/npm/chessground@9.2.1/+esm";

const $ = (sel) => document.querySelector(sel);
const api = (path) => fetch(path).then((r) => r.json());

const state = {
  user: "",
  game: null,
  ply: 0,
  orientation: "white",
  keyPly: null,
  note: null,
  variation: null, // { base: ply, nodes: [{ fen, san, uci }] }
  engineOn: false,
  engineLines: null,
  activeItem: null,
};

const board = Chessground($("#board"), {
  coordinates: true,
  movable: { free: false, color: "both", showDests: true, events: { after: onUserMove } },
  draggable: { showGhost: true },
  highlight: { lastMove: true, check: true },
  animation: { duration: 150 },
});

// ---------- formatting ----------

const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
const clampCp = (cp, mate) => (mate != null ? (mate > 0 ? 1000 : -1000) : Math.max(-1000, Math.min(1000, cp ?? 0)));

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
const tc = (g) => (g.clock_initial != null ? `${Math.round(g.clock_initial / 60 * 10) / 10}+${g.clock_increment}` : g.speed);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- judgements (Lichess thresholds on win% drop) ----------

function judgements(game) {
  if (!game.evals) return [];
  const wins = game.evals.map(([cp, mate], i) => winPct(i === 0 && cp == null && mate == null ? 15 : clampCp(cp, mate)));
  const whiteFirst = game.plies[0].fen.split(" ")[1] === "w";
  const out = [null];
  for (let i = 0; i + 1 < wins.length; i++) {
    const whiteMoved = (i % 2 === 0) === whiteFirst;
    const drop = whiteMoved ? wins[i] - wins[i + 1] : wins[i + 1] - wins[i];
    out.push(drop >= 15 ? "blunder" : drop >= 10 ? "mistake" : drop >= 5 ? "inaccuracy" : null);
  }
  return out;
}
const MARK = { blunder: "??", mistake: "?", inaccuracy: "?!" };

// ---------- sidebar: highlights ----------

async function loadHighlights() {
  const h = await api("/api/highlights");
  state.user = h.user || "";
  $("#summary").textContent = h.games
    ? `${h.user} · ${h.games.toLocaleString()} games · ${h.analysed.toLocaleString()} engine-analysed`
    : "No highlights yet: run ./chess update";
  const root = $("#tab-highlights");
  root.innerHTML = "";
  h.categories.forEach((cat, idx) => {
    const d = document.createElement("details");
    d.className = "category";
    if (idx < 2) d.open = true;
    d.innerHTML = `<summary><h3>${esc(cat.title)}</h3><span class="count">${cat.games.length}</span></summary>
      <p class="blurb">${esc(cat.blurb)}</p>`;
    if (!cat.games.length) {
      d.insertAdjacentHTML("beforeend", `<p class="needs-engine">${cat.engine ? "Needs engine analysis (./chess analyse)." : "No games yet."}</p>`);
    }
    const ul = document.createElement("ul");
    ul.className = "game-list";
    cat.games.forEach((g, i) => {
      const li = document.createElement("li");
      li.className = "game-item";
      li.innerHTML = `<div class="metric">${i + 1}. ${esc(g.metric)}</div>
        <div class="meta"><span class="badge ${g.result}">${g.result}</span>
        <span>vs ${esc(g.opp_title ? g.opp_title + " " : "")}${esc(g.opp_name)} (${g.opp_rating ?? "?"})</span>
        <span>${g.time_control ?? g.speed}</span><span>${g.date}</span></div>`;
      li.onclick = () => openGame(g.id, { keyPly: g.key_ply, note: `${cat.title}: ${g.metric}`, item: li });
      ul.appendChild(li);
    });
    d.appendChild(ul);
    root.appendChild(d);
  });
  const first = h.categories.find((c) => c.games.length);
  if (first && !location.hash) root.querySelector(".game-item")?.click();
}

// ---------- sidebar: browse ----------

let browseOffset = 0;
async function loadBrowse(reset = true) {
  if (reset) browseOffset = 0;
  const params = new URLSearchParams({ limit: 100, offset: browseOffset, sort: $("#f-sort").value });
  for (const k of ["q", "result", "speed", "color"]) {
    const v = $(`#f-${k}`).value.trim();
    if (v) params.set(k, v);
  }
  const data = await api(`/api/games?${params}`);
  const ul = $("#browse-list");
  if (reset) ul.innerHTML = "";
  $("#browse-count").textContent = `${data.total.toLocaleString()} games`;
  data.games.forEach((g) => {
    const li = document.createElement("li");
    li.className = "game-item";
    const acc = g.my_accuracy != null ? ` · ${g.my_accuracy.toFixed(0)}%` : "";
    li.innerHTML = `<div><span class="badge ${g.result}">${g.result}</span>
        vs ${esc(g.opp_title ? g.opp_title + " " : "")}${esc(g.opp_name)} (${g.opp_rating ?? "?"})</div>
      <div class="meta"><span>${date(g.created_at)}</span><span>${tc(g)}</span><span>${Math.ceil(g.plies / 2)} moves${acc}</span>
      <span>${esc(g.eco ?? "")} ${esc((g.opening ?? "").split(":")[0])}</span></div>`;
    li.onclick = () => openGame(g.id, { item: li });
    ul.appendChild(li);
  });
  browseOffset += data.games.length;
  $("#browse-more").classList.toggle("hidden", browseOffset >= data.total);
}

let browseTimer;
for (const id of ["#f-q", "#f-result", "#f-speed", "#f-color", "#f-sort"]) {
  $(id).addEventListener("input", () => { clearTimeout(browseTimer); browseTimer = setTimeout(() => loadBrowse(true), 250); });
}
$("#browse-more").onclick = () => loadBrowse(false);

document.querySelectorAll(".tab").forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    $("#tab-highlights").classList.toggle("hidden", t.dataset.tab !== "highlights");
    $("#tab-browse").classList.toggle("hidden", t.dataset.tab !== "browse");
    if (t.dataset.tab === "browse" && !$("#browse-list").children.length) loadBrowse();
  };
});

// ---------- game ----------

async function openGame(id, { keyPly = null, note = null, item = null } = {}) {
  const game = await api(`/api/game/${id}`);
  if (game.error) return;
  state.activeItem?.classList.remove("active");
  state.activeItem = item;
  item?.classList.add("active");
  state.game = game;
  state.game.judgements = judgements(game);
  state.keyPly = keyPly;
  state.note = note;
  state.variation = null;
  state.orientation = game.color;
  board.set({ orientation: game.color });
  history.replaceState(null, "", `#${id}`);
  renderInfo();
  renderMoves();
  renderGraph();
  goTo(keyPly ?? 0);
}

function renderInfo() {
  const g = state.game;
  const a = g.analysis;
  const me = state.user || "You";
  const opp = `${g.opp_title ? g.opp_title + " " : ""}${g.opp_name}`;
  const lichess = `https://lichess.org/${g.id}${g.color === "black" ? "/black" : ""}`;
  const stat = (label, v) => `<div>${label}<b>${v ?? "–"}</b></div>`;
  $("#game-info").innerHTML = `
    <h2><span class="badge ${g.result}">${g.result}</span> vs ${esc(opp)} (${g.opp_rating ?? "?"})</h2>
    <div class="muted">${date(g.created_at)} · ${tc(g)} ${g.rated ? "rated" : "casual"} ${g.variant !== "standard" ? g.variant : ""}
      · ${g.status} · ${Math.ceil(g.plies.length / 2)} moves</div>
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
      <a href="${lichess}" target="_blank" rel="noopener" id="lichess-link">Open on Lichess</a>
      <a href="/api/pgn/${g.id}" download="${g.id}.pgn">Annotated PGN</a>
      ${a ? `<span class="muted">evals: ${a.source}</span>` : `<span class="muted">not engine-analysed yet</span>`}
    </div>`;
}

function renderMoves() {
  const g = state.game;
  const root = $("#moves");
  root.innerHTML = "";
  const whiteFirst = g.plies[0].fen.split(" ")[1] === "w";
  const startMove = parseInt(g.plies[0].fen.split(" ")[5], 10) || 1;
  g.plies.forEach((p, ply) => {
    if (ply === 0) return;
    const idx = ply - 1 + (whiteFirst ? 0 : 1);
    if (idx % 2 === 0 || ply === 1) {
      root.insertAdjacentHTML("beforeend", `<div class="num">${startMove + Math.floor(idx / 2)}.</div>`);
      if (ply === 1 && !whiteFirst) root.insertAdjacentHTML("beforeend", `<div class="mv">…</div>`);
    }
    const j = g.judgements[ply];
    const best = j && g.plies[ply - 1].best_san && g.plies[ply - 1].best_san !== p.san ? ` (best: ${g.plies[ply - 1].best_san})` : "";
    const el = document.createElement("div");
    el.className = `mv ${j ?? ""} ${ply === state.keyPly ? "key" : ""}`;
    el.dataset.ply = ply;
    el.title = (j ? j + best : "") + (g.evals?.[ply] ? ` eval ${fmtEval(...g.evals[ply])}` : "");
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
  const pts = g.evals.map(([cp, mate], i) => [i, 100 - winPct(i === 0 && cp == null && mate == null ? 15 : clampCp(cp, mate))]);
  const line = pts.map(([x, y]) => `${x},${y.toFixed(2)}`).join(" ");
  const marks = g.judgements.map((j, i) => (j === "blunder" || j === "mistake")
    ? `<circle cx="${i}" cy="${pts[i][1]}" r="0.9" fill="var(--${j})" vector-effect="non-scaling-stroke"/>` : "").join("");
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

// ---------- navigation & board ----------

const posCache = new Map();
async function positionInfo(fen) {
  if (!posCache.has(fen)) {
    const chess960 = state.game?.chess960 ? "&chess960=1" : "";
    posCache.set(fen, api(`/api/position?fen=${encodeURIComponent(fen)}${chess960}`));
  }
  return posCache.get(fen);
}

function current() {
  const g = state.game;
  if (state.variation?.nodes.length) {
    const node = state.variation.nodes.at(-1);
    return { fen: node.fen, uci: node.uci };
  }
  const p = g.plies[state.ply];
  return { fen: p.fen, uci: p.uci };
}

function goTo(ply) {
  const g = state.game;
  if (!g) return;
  state.variation = null;
  state.ply = Math.max(0, Math.min(g.plies.length - 1, ply));
  render();
}

async function render() {
  const g = state.game;
  const { fen, uci } = current();
  const turn = fen.split(" ")[1] === "w" ? "white" : "black";
  board.set({
    fen,
    turnColor: turn,
    lastMove: uci ? [uci.slice(0, 2), uci.slice(2, 4)] : undefined,
    movable: { color: turn, dests: new Map() },
  });
  board.setAutoShapes(gameShapes());

  // Move list highlight
  document.querySelectorAll(".moves .mv.current").forEach((el) => el.classList.remove("current"));
  if (!state.variation) {
    const el = document.querySelector(`.moves .mv[data-ply="${state.ply}"]`);
    el?.classList.add("current");
    el?.scrollIntoView({ block: "nearest" });
  }
  const cursor = document.getElementById("graph-cursor");
  cursor?.setAttribute("x1", state.ply);
  cursor?.setAttribute("x2", state.ply);

  // Variation bar
  $("#variation-bar").classList.toggle("hidden", !state.variation);
  if (state.variation) $("#variation-moves").textContent = state.variation.nodes.map((n) => n.san).join(" ");

  // Lichess link follows the current ply
  const link = document.getElementById("lichess-link");
  if (link) link.href = `https://lichess.org/${g.id}${g.color === "black" ? "/black" : ""}#${state.ply}`;

  renderPlayers();
  renderEvalBar(state.variation ? null : g.evals?.[state.ply]);

  const info = await positionInfo(fen);
  if (current().fen !== fen) return;
  const check = info.check ? turn : false;
  board.set({ check, movable: { color: turn, dests: new Map(Object.entries(info.dests)) } });

  if (state.engineOn) requestEngine(fen);
}

function gameShapes() {
  const g = state.game;
  if (state.variation || !g) return [];
  const best = g.plies[state.ply]?.best;
  return best ? [{ orig: best.slice(0, 2), dest: best.slice(2, 4), brush: "paleGreen" }] : [];
}

function renderPlayers() {
  const g = state.game;
  const whiteFirst = g.plies[0].fen.split(" ")[1] === "w";
  const lastClock = (color) => {
    for (let p = state.ply; p >= 1; p--) {
      const whiteMoved = ((p - 1) % 2 === 0) === whiteFirst;
      if ((whiteMoved ? "white" : "black") === color && g.plies[p].clock != null) return g.plies[p].clock;
    }
    return g.clock_initial != null ? g.clock_initial * 100 : null;
  };
  const me = { name: state.user || "You", rating: g.my_rating, color: g.color };
  const opp = { name: `${g.opp_title ? g.opp_title + " " : ""}${g.opp_name}`, rating: g.opp_rating, color: g.color === "white" ? "black" : "white" };
  const [bottom, top] = state.orientation === g.color ? [me, opp] : [opp, me];
  const html = (p) => `<span>${p.color === "white" ? "&#x26AA;" : "&#x26AB;"} ${esc(p.name)} <span class="rating">${p.rating ?? ""}</span></span>
    <span class="clock">${fmtClock(lastClock(p.color))}</span>`;
  $("#player-top").innerHTML = html(top);
  $("#player-bottom").innerHTML = html(bottom);
}

function renderEvalBar(ev) {
  const bar = $("#evalbar");
  bar.classList.toggle("flipped", state.orientation === "black");
  if (!ev && state.engineLines?.length) ev = [state.engineLines[0].cp, state.engineLines[0].mate];
  if (!ev) {
    $("#evalbar-fill").style.height = "50%";
    $("#evalbar-label").textContent = "";
    return;
  }
  const [cp, mate] = ev;
  const w = winPct(state.ply === 0 && cp == null && mate == null ? 15 : clampCp(cp, mate));
  $("#evalbar-fill").style.height = `${w}%`;
  $("#evalbar-label").textContent = fmtEval(cp, mate);
}

async function onUserMove(orig, dest) {
  const g = state.game;
  if (!g) return;
  const uci = orig + dest;
  const next = g.plies[state.ply + 1];
  if (!state.variation && next && next.uci.startsWith(uci)) return goTo(state.ply + 1);
  const { fen } = current();
  const chess960 = g.chess960 ? "&chess960=1" : "";
  const res = await api(`/api/move?fen=${encodeURIComponent(fen)}&uci=${uci}${chess960}`);
  if (res.error) return render();
  if (!state.variation) state.variation = { base: state.ply, nodes: [] };
  state.variation.nodes.push({ fen: res.fen, san: res.san, uci: res.uci });
  posCache.set(res.fen, Promise.resolve(res));
  render();
}

$("#variation-exit").onclick = () => goTo(state.variation?.base ?? state.ply);

// ---------- engine ----------

let engineTimer, engineSeq = 0;
function requestEngine(fen) {
  clearTimeout(engineTimer);
  $("#engine-lines").innerHTML = `<div class="muted">thinking…</div>`;
  engineTimer = setTimeout(async () => {
    const seq = ++engineSeq;
    const chess960 = state.game?.chess960 ? "&chess960=1" : "";
    const res = await api(`/api/engine?fen=${encodeURIComponent(fen)}&multipv=3&time=1.5${chess960}`);
    if (seq !== engineSeq || current().fen !== fen) return;
    state.engineLines = res.lines;
    $("#engine-lines").innerHTML = res.lines.length
      ? res.lines.map((l) => `<div class="line"><span class="score">${fmtEval(l.cp, l.mate)}</span><span>${esc(l.san)}</span></div>`).join("")
        + `<div class="muted">depth ${res.lines[0].depth}</div>`
      : `<div class="muted">Game over.</div>`;
    const top = res.lines[0]?.uci?.[0];
    board.setAutoShapes(top ? [{ orig: top.slice(0, 2), dest: top.slice(2, 4), brush: "blue" }] : []);
    if (state.variation || !state.game.evals) renderEvalBar(null);
  }, 200);
}

$("#engine-on").onchange = (e) => {
  state.engineOn = e.target.checked;
  state.engineLines = null;
  $("#engine-lines").innerHTML = "";
  if (state.engineOn && state.game) requestEngine(current().fen);
  else if (state.game) board.setAutoShapes(gameShapes());
};

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

document.querySelectorAll("[data-nav]").forEach((b) => (b.onclick = () => nav(b.dataset.nav)));
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select")) return;
  const map = { ArrowLeft: "prev", ArrowRight: "next", Home: "start", End: "end", f: "flip", k: "key" };
  if (map[e.key]) { e.preventDefault(); nav(map[e.key]); }
});

// ---------- boot ----------

await loadHighlights();
if (location.hash.length > 1) openGame(location.hash.slice(1));
