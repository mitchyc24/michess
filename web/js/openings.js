// Opening tree over the in-memory games (port of analyzer/openings.py).
import { db } from "./data.js";
import { startPos, fenOf, bookKey, parseSanMove, moveToUci } from "./chess-util.js";

let bookPromise;
export const book = () => (bookPromise ??= fetch(new URL("../data/openings.json", import.meta.url)).then((r) => r.json()));

export function filterGames(q) {
  const speeds = new Set((q.speed || "").split(",").filter(Boolean));
  return db.games.filter((g) => g.variant === "standard" && !g.initial_fen && g.color === q.color
    && (!speeds.size || speeds.has(g.speed))
    && (q.rated === "" || q.rated == null || g.rated === +q.rated)
    && (!q.since || g.created_at >= q.since)
    && (!q.until || g.created_at < q.until));
}

const newNode = (san = null) => ({ san, n: 0, w: 0, d: 0, l: 0, opp: 0, oppN: 0, kids: new Map() });
const KEY = { win: "w", draw: "d", loss: "l" };

export async function buildTree(q, maxPly = 14, minGames = 3) {
  const names = await book();
  const games = filterGames(q);
  const root = newNode();
  for (const g of games) {
    const path = [root];
    let node = root;
    for (const san of g.moves.split(" ").slice(0, maxPly)) {
      if (!san) break;
      if (!node.kids.has(san)) node.kids.set(san, newNode(san));
      node = node.kids.get(san);
      path.push(node);
    }
    for (const n of path) {
      n.n++;
      n[KEY[g.result]]++;
      if (g.opp_rating) { n.opp += g.opp_rating; n.oppN++; }
    }
  }
  let count = 0;
  const finish = (node, pos, ply) => {
    count++;
    const named = names[bookKey(pos)];
    const out = { san: node.san, ply, n: node.n, w: node.w, d: node.d, l: node.l,
                  opp: node.oppN ? Math.round(node.opp / node.oppN) : null, fen: fenOf(pos), children: [] };
    if (named) [out.eco, out.name] = named;
    const kids = [...node.kids.values()].filter((c) => c.n >= minGames).sort((a, b) => b.n - a.n);
    for (const child of kids) {
      const next = pos.clone();
      let move;
      try { move = parseSanMove(next, child.san); } catch { continue; }
      next.play(move);
      const sub = finish(child, next, ply + 1);
      sub.uci = moveToUci(move);
      out.children.push(sub);
    }
    return out;
  };
  const tree = finish(root, startPos(), 0);
  tree.name = "Starting position";
  return { tree, games: games.length, nodes: count };
}

export function gamesAt(q, moves, limit = 40) {
  const prefix = moves ? moves + " " : "";
  return filterGames(q).filter((g) => !moves || g.moves === moves || g.moves.startsWith(prefix)).slice(0, limit);
}
