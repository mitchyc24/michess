// Opening tree view (2D d3 tree / 3D force graph).
import { d3, Chessground } from "./lib.js";
import { buildTree, gamesAt } from "./openings.js";

const $ = (sel) => document.querySelector(sel);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const state = {
  color: "white",
  speeds: new Set(),
  period: "",
  rated: "",
  depth: 14,
  minGames: 3,
  mode: "2d",
  data: null,
  root: null,
  selected: null,
};

const ROW = 20;   // vertical spacing between sibling positions
const COL = 215;  // horizontal spacing per ply

// ---------- scales ----------

const score = (d) => (d.data.w + d.data.d / 2) / d.data.n;
const scoreColor = d3.scaleLinear()
  .domain([0.36, 0.5, 0.64])
  .range([css("--score-loss"), css("--score-even"), css("--score-win")])
  .interpolate(d3.interpolateLab)
  .clamp(true);
let widthScale = d3.scaleSqrt().domain([0, 1]).range([0.8, 40]);
let labelSize = d3.scaleSqrt().domain([1, 2]).range([11, 18]).clamp(true);
const wid = (d) => widthScale(d.data.n);

// ---------- helpers over the hierarchy ----------

const kids = (d) => d.children || d._children || [];
function* everyNode(d) {
  yield d;
  for (const c of kids(d)) yield* everyNode(c);
}
const moveLabel = (d) => {
  const ply = d.depth;
  const num = Math.ceil(ply / 2);
  return { num: ply % 2 ? `${num}.` : `${num}…`, san: d.data.san };
};
const lineText = (d) => d.ancestors().reverse().slice(1)
  .map((a) => (a.depth % 2 ? `${Math.ceil(a.depth / 2)}.` : "") + a.data.san).join(" ");
const movesOf = (d) => d.ancestors().reverse().slice(1).map((a) => a.data.san).join(" ");

const family = (name) => (name || "").split(":")[0];
function openingLabel(d) {
  const name = d.data.name;
  if (!name || !d.parent) return null;
  const parentName = d.parent.inherited;
  if (name === parentName) return null;
  if (family(name) !== family(parentName)) return { text: name, cls: "family" };
  if (parentName && name.startsWith(parentName + ", ")) return { text: name.slice(parentName.length + 2), cls: "variation" };
  return { text: name.split(": ").slice(1).join(": ") || name, cls: "variation" };
}

function prepare(tree) {
  const root = d3.hierarchy(tree);
  const rootN = tree.n || 1;
  widthScale = d3.scaleSqrt().domain([0, rootN]).range([0.8, 40]);
  labelSize = d3.scaleSqrt().domain([state.minGames, rootN]).range([11, 19]).clamp(true);
  root.each((d) => {
    d.id = d.parent ? `${d.parent.id} ${d.data.san}` : "^";
    d.inherited = d.data.name || d.parent?.inherited || null;
    d.label = openingLabel(d);
  });
  return root;
}

// Main lines: expand positions played often enough; smaller ones start collapsed.
function expandThreshold() {
  return Math.max(state.minGames * 2, Math.round(state.root.data.n * 0.03));
}
function resetExpansion() {
  const min = expandThreshold();
  for (const d of everyNode(state.root)) {
    const all = kids(d);
    if (!all.length) continue;
    const open = d.depth === 0 || d.data.n >= min;
    d.children = open ? all : null;
    d._children = open ? null : all;
  }
}
function expand(d) {
  if (d._children) { d.children = d._children; d._children = null; }
}
function collapse(d) {
  if (d.children) { d._children = d.children; d.children = null; }
}

// ---------- data loading ----------

function query() {
  const [since, until] = state.period.split(":");
  return { color: state.color, speed: [...state.speeds].join(","), rated: state.rated,
           since: since ? +since : null, until: until ? +until : null };
}

async function load() {
  $("#status").textContent = "Loading…";
  const keep = state.selected?.id;
  const data = await buildTree(query(), state.depth, state.minGames);
  if (!data.games) {
    state.data = data;
    state.root = null;
    nodeLayer.selectAll("*").remove();
    linkLayer.selectAll("*").remove();
    highlightLayer.selectAll("*").remove();
    $("#status").textContent = "No games match these filters.";
    $("#details").innerHTML = `<p class="muted">No games as ${state.color} with these filters.</p>`;
    return;
  }
  state.data = data;
  state.root = prepare(data.tree);
  resetExpansion();
  state.selected = null;
  fillSearch();
  $("#legend-width").textContent = `Line width = games played (thickest here: ${d3.max(state.root.children || [], (c) => c.data.n) ?? 0})`;

  let target = state.root;
  if (keep) {
    for (const d of everyNode(state.root)) if (d.id === keep) target = d;
  }
  revealPath(target);
  render(true);
  select(target, false);
}

// ---------- 2D tree ----------

const svg = d3.select("#svg");
const viewport = svg.append("g");
const linkLayer = viewport.append("g");
const highlightLayer = viewport.append("g");
const nodeLayer = viewport.append("g");
const zoom = d3.zoom().scaleExtent([0.04, 3]).on("zoom", (e) => {
  viewport.attr("transform", e.transform);
  svg.classed("far", e.transform.k < 0.65).classed("veryfar", e.transform.k < 0.3);
});
svg.call(zoom).on("dblclick.zoom", null);

const layout = d3.tree().nodeSize([ROW, COL]).separation((a, b) => {
  const needed = (wid(a) + wid(b)) / 2 / ROW + 0.35;
  return Math.max(a.parent === b.parent ? 1 : 1.3, needed);
});
const linkPath = d3.linkHorizontal().x((p) => p.y).y((p) => p.x);

function render(fit = false) {
  if (state.mode === "3d") return render3d();
  const root = state.root;
  layout(root);
  const nodes = root.descendants();
  const links = root.links().sort((a, b) => b.target.data.n - a.target.data.n);
  const t = svg.transition().duration(fit ? 0 : 350);
  const majorCut = root.data.n * 0.02;

  linkLayer.selectAll("path.link")
    .data(links, (l) => l.target.id)
    .join(
      (enter) => enter.append("path").attr("class", "link")
        .attr("d", (l) => { const o = { x: l.source.x0 ?? l.source.x, y: l.source.y0 ?? l.source.y }; return linkPath({ source: o, target: o }); }),
      (update) => update,
      (exit) => exit.transition(t).attr("stroke-width", 0).remove(),
    )
    .on("mousemove", (e, l) => showTip(e, l.target))
    .on("mouseleave", hideTip)
    .on("click", (e, l) => onNodeClick(l.target))
    .order()
    .transition(t)
    .attr("d", linkPath)
    .attr("stroke", (l) => scoreColor(score(l.target)))
    .attr("stroke-width", (l) => wid(l.target));

  const node = nodeLayer.selectAll("g.node")
    .data(nodes, (d) => d.id)
    .join(
      (enter) => {
        const g = enter.append("g").attr("class", "node")
          .attr("transform", (d) => { const p = d.parent; return `translate(${p?.y0 ?? d.y},${p?.x0 ?? d.x})`; });
        g.append("circle");
        g.append("text").attr("class", "san");
        g.append("text").attr("class", "opening-label");
        g.on("click", (e, d) => onNodeClick(d))
          .on("mousemove", (e, d) => showTip(e, d))
          .on("mouseleave", hideTip);
        return g;
      },
      (update) => update,
      (exit) => exit.transition(t).style("opacity", 0).remove(),
    );

  node.classed("collapsed", (d) => !!d._children).classed("selected", (d) => d === state.selected);
  node.transition(t).attr("transform", (d) => `translate(${d.y},${d.x})`);
  node.select("circle")
    .attr("r", (d) => 3 + Math.min(6, wid(d) / 6))
    .attr("fill", (d) => (d.depth ? scoreColor(score(d)) : css("--text")));

  node.select("text.san")
    .classed("minor", (d) => d.data.n < majorCut)
    .attr("text-anchor", "end")
    .attr("x", -7)
    .attr("y", (d) => -Math.max(5, wid(d) / 2 + 2))
    .html((d) => {
      if (!d.depth) return "";
      const m = moveLabel(d);
      return `<tspan class="num">${m.num}</tspan>${esc(m.san)}`;
    });

  node.select("text.opening-label")
    .attr("class", (d) => `opening-label ${d.label?.cls ?? ""} ${d.data.n < majorCut / 2 ? "minor" : ""}`)
    .attr("x", 9)
    .attr("y", 4)
    .attr("font-size", (d) => (d.depth === 0 ? 15 : d.label?.cls === "family" ? labelSize(d.data.n) : Math.max(11, labelSize(d.data.n) - 2)))
    .html((d) => {
      const text = d.depth === 0 ? (state.color === "white" ? "Games as White" : "Games as Black") : d.label?.text ?? "";
      const short = text.length > 34 ? text.slice(0, 32) + "…" : text;
      const more = d._children ? `<tspan class="more" dx="${short ? 5 : 0}">+${d._children.length}</tspan>` : "";
      return esc(short) + more;
    });

  nodes.forEach((d) => { d.x0 = d.x; d.y0 = d.y; });
  drawHighlight();
  $("#status").textContent = `${state.data.games.toLocaleString()} games · ${state.data.nodes.toLocaleString()} positions · ${nodes.length.toLocaleString()} shown`;
  if (fit) fitView();
}

function drawHighlight() {
  const d = state.selected;
  const path = d ? d.ancestors().reverse() : [];
  const segs = path.slice(1).map((n) => ({ source: n.parent, target: n }));
  highlightLayer.selectAll("path").data(segs, (s) => s.target.id)
    .join("path").attr("class", "path-highlight").attr("d", linkPath);
}

function fitView() {
  const nodes = state.root.descendants();
  const [x0, x1] = d3.extent(nodes, (d) => d.x);
  const [y0, y1] = d3.extent(nodes, (d) => d.y);
  const { width, height } = svg.node().getBoundingClientRect();
  const w = y1 - y0 + 340, h = x1 - x0 + 80;
  // Fit, but never so small that labels become unreadable; if the tree is taller than that, center on the root.
  const k = Math.max(0.85, Math.min(1.1, width / w, height / h));
  const cy = h * k > height ? state.root.x : (x0 + x1) / 2;
  svg.call(zoom.transform, d3.zoomIdentity.translate(40 - y0 * k, height / 2 - cy * k).scale(k));
}

function centerOn(d) {
  const { width, height } = svg.node().getBoundingClientRect();
  const k = Math.max(d3.zoomTransform(svg.node()).k, 0.7);
  svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(width * 0.35 - d.y * k, height / 2 - d.x * k).scale(k));
}

function onNodeClick(d) {
  if (d._children) expand(d);
  else if (d === state.selected && d.children && d.depth) collapse(d);
  select(d);
  render();
}

// ---------- tooltip ----------

function pct(x, n) { return n ? Math.round((100 * x) / n) : 0; }
function tipHtml(d) {
  const { n, w, d: dr, l, opp } = d.data;
  return `<div class="t-name">${esc(d.inherited ?? "Starting position")}${d.data.eco ? ` <span class="muted">${d.data.eco}</span>` : ""}</div>
    <div class="t-line">${esc(lineText(d)) || "—"}</div>
    <div><b>${n.toLocaleString()}</b> games · score <b>${pct(w + dr / 2, n)}%</b></div>
    <div>${pct(w, n)}% won · ${pct(dr, n)}% drawn · ${pct(l, n)}% lost</div>
    ${opp ? `<div class="muted">avg opponent ${opp}</div>` : ""}`;
}
function showTip(e, d) {
  const tip = $("#tooltip");
  tip.innerHTML = tipHtml(d);
  tip.classList.remove("hidden");
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
function hideTip() { $("#tooltip").classList.add("hidden"); }

// ---------- details panel ----------

let gamesSeq = 0;
function wdlBar(w, dr, l, n, labels = true) {
  const p = (x) => (n ? (100 * x) / n : 0);
  const lab = (x) => (labels && p(x) >= 12 ? `${Math.round(p(x))}%` : "");
  return `<div class="wdl"><div class="w" style="width:${p(w)}%">${lab(w)}</div><div class="d" style="width:${p(dr)}%">${lab(dr)}</div><div class="l" style="width:${p(l)}%">${lab(l)}</div></div>`;
}

function select(d, scroll = true) {
  state.selected = d;
  nodeLayer.selectAll("g.node").classed("selected", (n) => n === d);
  drawHighlight();
  const { n, w, d: dr, l, opp, fen, eco } = d.data;
  const path = d.ancestors().reverse();
  const crumbs = path.slice(1).map((a) => {
    const m = moveLabel(a);
    const num = a.depth % 2 ? `<span class="num">${m.num}</span>` : "";
    return `${num}<a data-id="${esc(a.id)}" class="${a === d ? "here" : ""}">${esc(a.data.san)}</a>`;
  }).join(" ");
  const next = [...kids(d)].sort((a, b) => b.data.n - a.data.n);
  const lichessFen = fen.replace(/ /g, "_");
  $("#details").innerHTML = `
    <h2>${esc(d.inherited ?? "Starting position")}</h2>
    <div class="eco">${eco ? `${eco} · ` : ""}${state.color === "white" ? "as White" : "as Black"}</div>
    <div class="mini-board" id="mini-board"></div>
    <div class="crumbs"><a data-id="^" class="${d.depth ? "" : "here"}">Start</a> ${crumbs}</div>
    ${wdlBar(w, dr, l, n)}
    <div class="kv">
      <div>Games<b>${n.toLocaleString()}</b></div>
      <div>Score<b>${pct(w + dr / 2, n)}%</b></div>
      <div>Avg opp.<b>${opp ?? "–"}</b></div>
    </div>
    <div class="links">
      <a href="https://lichess.org/analysis/standard/${lichessFen}?color=${state.color}" target="_blank" rel="noopener">Analyse on Lichess</a>
      <a href="https://lichess.org/analysis/standard/${lichessFen}?color=${state.color}#explorer" target="_blank" rel="noopener">Opening explorer</a>
    </div>
    ${next.length ? `<h3>Next moves</h3><table class="next-moves">${next.map((c) => `
      <tr data-id="${esc(c.id)}"><td class="mv">${esc(moveLabel(c).num)}${esc(c.data.san)}</td>
      <td class="cnt">${c.data.n}</td><td class="bar">${wdlBar(c.data.w, c.data.d, c.data.l, c.data.n)}</td></tr>`).join("")}</table>` : ""}
    <h3>Games reaching this position</h3>
    <ul class="tree-games" id="tree-games"><li class="muted">Loading…</li></ul>`;

  const parts = fen.split(" ");
  const lastUci = d.data.uci;
  Chessground($("#mini-board"), {
    fen, viewOnly: true, coordinates: false, orientation: state.color,
    lastMove: lastUci ? [lastUci.slice(0, 2), lastUci.slice(2, 4)] : undefined,
    turnColor: parts[1] === "w" ? "white" : "black",
  });

  const byId = new Map([...everyNode(state.root)].map((x) => [x.id, x]));
  $("#details").querySelectorAll("[data-id]").forEach((el) => {
    el.onclick = () => {
      const target = byId.get(el.dataset.id);
      if (!target) return;
      revealPath(target);
      expand(target);
      select(target);
      render();
      if (state.mode === "2d") centerOn(target);
    };
  });
  if (scroll) $("#details").scrollTop = 0;
  loadGames(d);
}

async function loadGames(d) {
  const seq = ++gamesSeq;
  const games = gamesAt(query(), movesOf(d), 40);
  if (seq !== gamesSeq) return;
  const ply = d.depth;
  $("#tree-games").innerHTML = games.length ? games.map((g) => `
    <li><span><span class="badge ${g.result}">${g.result}</span>
      <a href="#review/${g.id}" title="Review this game">vs ${esc(g.opp_title ? g.opp_title + " " : "")}${esc(g.opp_name)} (${g.opp_rating ?? "?"})</a></span>
      <span class="meta">${new Date(g.created_at).toISOString().slice(0, 10)} · ${g.speed}
      · <a href="https://lichess.org/${g.id}${state.color === "black" ? "/black" : ""}#${ply}" target="_blank" rel="noopener">Lichess</a></span></li>`).join("")
    : `<li class="muted">No games.</li>`;
}

function revealPath(d) {
  for (const a of d.ancestors()) if (a !== d) expand(a);
}

// ---------- search ----------

function fillSearch() {
  const names = new Map();
  for (const d of everyNode(state.root)) {
    if (d.data.name) names.set(d.data.name, Math.max(names.get(d.data.name) ?? 0, d.data.n));
  }
  $("#opening-names").innerHTML = [...names.entries()].sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `<option value="${esc(name)}">${n} games</option>`).join("");
}

function search(text) {
  const q = text.trim().toLowerCase();
  if (!q) return;
  let best = null;
  for (const d of everyNode(state.root)) {
    const name = (d.data.name || "").toLowerCase();
    if (!name.includes(q)) continue;
    const exact = name === q;
    if (!best || (exact && !best.exact) || (exact === best.exact && d.data.n > best.d.data.n)) best = { d, exact };
  }
  if (!best) { $("#status").textContent = `No position named “${text}” in this tree`; return; }
  revealPath(best.d);
  select(best.d);
  render();
  if (state.mode === "2d") centerOn(best.d);
}
$("#search").addEventListener("change", (e) => search(e.target.value));
$("#search").addEventListener("keydown", (e) => { if (e.key === "Enter") search(e.target.value); });

// ---------- 3D ----------

let graph3d = null;
let THREE = null;
let fit3d = true;
const nodes3d = new Map();

// Text sprite drawn on a canvas. Must use the same three.js instance as 3d-force-graph
// (the URL below is the one its +esm bundle imports), or the renderer rejects the object.
function textSprite(text, color, height) {
  const font = 64;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = `600 ${font}px system-ui, sans-serif`;
  canvas.width = Math.ceil(ctx.measureText(text).width) + 16;
  canvas.height = font + 24;
  ctx.font = `600 ${font}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.lineWidth = 10;
  ctx.strokeStyle = "rgba(22,21,18,0.9)";
  ctx.strokeText(text, 8, canvas.height / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, 8, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set((height * canvas.width) / canvas.height, height, 1);
  return sprite;
}

async function render3d() {
  const el = $("#three");
  if (!graph3d) {
    $("#status").textContent = "Loading 3D engine…";
    const [{ default: ForceGraph3D }, three] = await Promise.all([
      import("https://cdn.jsdelivr.net/npm/3d-force-graph@1.80.1/+esm"),
      import("https://cdn.jsdelivr.net/npm/three@0.186.1/+esm"),
    ]);
    THREE = three;
    graph3d = new ForceGraph3D(el)
      .backgroundColor(css("--bg"))
      .dagMode("lr")
      .dagLevelDistance(140)
      .nodeId("id")
      .nodeVal((n) => 2 + Math.sqrt(n.d.data.n))
      .nodeColor((n) => (n.d.depth ? scoreColor(score(n.d)) : css("--text")))
      .nodeOpacity(0.95)
      .nodeLabel((n) => `<div class="tooltip" style="position:static">${tipHtml(n.d)}</div>`)
      .linkColor((l) => scoreColor(score(l.d)))
      .linkWidth((l) => Math.max(0.6, wid(l.d) * 0.7))
      .linkOpacity(0.85)
      .linkLabel((l) => `<div class="tooltip" style="position:static">${tipHtml(l.d)}</div>`)
      .nodeThreeObjectExtend(true)
      .nodeThreeObject((n) => {
        const text = n.d.depth === 0 ? (state.color === "white" ? "Games as White" : "Games as Black")
          : n.d.label ? n.d.label.text : (n.d.data.n >= state.root.data.n * 0.03 ? n.d.data.san : null);
        if (!text) return null;
        const s = textSprite(text, n.d.label || !n.d.depth ? css("--label") : css("--text"),
          n.d.label?.cls === "family" || !n.d.depth ? 12 : 7);
        s.position.y = 10 + Math.sqrt(n.d.data.n) / 4;
        return s;
      })
      .onNodeClick((n) => onNodeClick(n.d))
      .onLinkClick((l) => onNodeClick(l.d))
      .onDagError(() => {})
      .cooldownTicks(150)
      .onEngineStop(() => {
        if (fit3d) { graph3d.zoomToFit(600, 60); fit3d = false; }
      });
    graph3d.d3Force("charge").strength(-60);
    window.addEventListener("resize", () => graph3d.width(el.clientWidth).height(el.clientHeight));
  }
  const visible = state.root.descendants();
  const nodes = visible.map((d) => {
    let n = nodes3d.get(d.id);
    if (!n) { n = { id: d.id }; nodes3d.set(d.id, n); }
    n.d = d;
    return n;
  });
  const links = visible.filter((d) => d.parent).map((d) => ({ source: d.parent.id, target: d.id, d }));
  graph3d.width(el.clientWidth).height(el.clientHeight).graphData({ nodes, links });
  $("#status").textContent = `${state.data.games.toLocaleString()} games · ${visible.length.toLocaleString()} positions shown (3D)`;
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll("#mode-seg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("#svg").classList.toggle("hidden", mode !== "2d");
  $("#three").classList.toggle("hidden", mode !== "3d");
  if (mode === "3d") {
    nodes3d.clear();
    fit3d = true;
    render3d().then(() => graph3d.resumeAnimation());
  } else {
    graph3d?.pauseAnimation();
    render(true);
  }
}

// ---------- controls ----------

function buildPeriods() {
  const now = Date.now(), day = 86400000;
  const opts = [["", "All time"], [`${now - 30 * day}:`, "Last 30 days"], [`${now - 90 * day}:`, "Last 90 days"], [`${now - 365 * day}:`, "Last 12 months"]];
  for (let y = new Date().getUTCFullYear(); y >= 2020; y--) opts.push([`${Date.UTC(y, 0, 1)}:${Date.UTC(y + 1, 0, 1)}`, String(y)]);
  $("#period").innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
}
buildPeriods();

document.querySelectorAll("#color-seg button").forEach((b) => (b.onclick = () => {
  state.color = b.dataset.color;
  document.querySelectorAll("#color-seg button").forEach((x) => x.classList.toggle("active", x === b));
  state.selected = null;
  nodes3d.clear();
  load();
}));
document.querySelectorAll("#speed-seg button").forEach((b) => (b.onclick = () => {
  b.dataset.speed.split(",").forEach((s) => (state.speeds.has(s) ? state.speeds.delete(s) : state.speeds.add(s)));
  b.classList.toggle("active");
  load();
}));
document.querySelectorAll("#mode-seg button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$("#period").onchange = (e) => { state.period = e.target.value; load(); };
$("#rated").onchange = (e) => { state.rated = e.target.value; load(); };

let sliderTimer;
for (const [id, key, out] of [["#depth", "depth", "#depth-out"], ["#min-games", "minGames", "#min-out"]]) {
  $(id).addEventListener("input", (e) => {
    state[key] = +e.target.value;
    $(out).textContent = e.target.value;
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(load, 300);
  });
}
$("#expand-more").onclick = () => {
  const leaves = state.root.descendants().filter((d) => d._children);
  leaves.forEach(expand);
  render();
};
$("#collapse").onclick = () => {
  resetExpansion();
  if (state.selected) revealPath(state.selected);
  render(true);
};
window.addEventListener("resize", () => visible && state.mode === "2d" && state.root && render());

let visible = false, stale = true;
// Rebuild lazily: when the view is shown after data changed.
export function invalidate() { stale = true; if (visible) { stale = false; load(); } }
export function show() {
  visible = true;
  if (stale || !state.root) { stale = false; load(); }
  else if (state.mode === "3d") graph3d?.resumeAnimation();
}
export function hide() {
  visible = false;
  graph3d?.pauseAnimation();
  hideTip();
}
