// Notable-game categories (port of analyzer/highlights.py).
import { db } from "./data.js";

const SUPPORTED = new Set(["standard", "chess960", "fromPosition"]);
const moveNo = (ply) => Math.floor((ply + 1) / 2);
const fullMoves = (r) => Math.floor((r.plies + 1) / 2);

const STATUS_WORDS = {
  mate: "checkmate", resign: "resignation", outoftime: "timeout", timeout: "abandonment",
  stalemate: "stalemate", draw: "agreement/repetition", insufficientMaterialClaim: "insufficient material",
  variantEnd: "variant end", noStart: "no start", cheat: "cheat detection",
};
export const statusWord = (s) => STATUS_WORDS[s] ?? s;
const how = (r) => `${{ win: "won", loss: "lost", draw: "drew" }[r.result]} by ${statusWord(r.status)}`;

export function standing(cp) {
  if (Math.abs(cp) >= 9000) {
    const n = 10000 - Math.abs(cp);
    return cp < 0 ? `Facing mate in ${n}` : `Had mate in ${n}`;
  }
  return `${cp < 0 ? "Down" : "Up"} ${(Math.abs(cp) / 100).toFixed(1)}`;
}
const clock = (cs) => (cs != null ? `${(cs / 100).toFixed(1)}s` : "?");

function specialMateLabel(r) {
  const last = r.moves.split(" ").at(-1);
  if (last.startsWith("O-O")) return `Castling checkmate (${last})`;
  if (last.includes("=") && !last.endsWith("=Q#")) return `Underpromotion checkmate (${last})`;
  return `Checkmate with the ${r.mate_piece} (${last})`;
}

const has = (v) => v !== null && v !== undefined;

// order: list of [key, "asc" | "desc"]
export const CATEGORIES = [
  {
    key: "upsets", title: "Biggest upsets",
    blurb: "Rated wins against the highest-rated opponents relative to your own rating.",
    where: (r) => r.result === "win" && r.rated && r.rating_gap > 0,
    order: [["rating_gap", "desc"]],
    metric: (r) => `+${r.rating_gap} rating gap (${r.my_rating} vs ${r.opp_rating})`,
    ply: (r) => r.plies,
  },
  {
    key: "strongest_beaten", title: "Strongest opponents beaten",
    blurb: "Wins against the highest absolute ratings, whatever your rating was at the time.",
    where: (r) => r.result === "win" && r.rated && has(r.opp_rating),
    order: [["opp_rating", "desc"]],
    metric: (r) => `${r.opp_title ? r.opp_title + " " : ""}${r.opp_rating} rated opponent`,
    ply: (r) => r.plies,
  },
  {
    key: "eval_comebacks", title: "Greatest comebacks (engine)", engine: true,
    blurb: "Wins where the engine gave you the lowest winning chances, and you genuinely turned it around (not just a flag in a lost position).",
    where: (r) => r.result === "win" && has(r.my_min_winpct) && (["mate", "resign"].includes(r.status) || r.my_final_cp > -200),
    order: [["my_min_winpct", "asc"], ["my_min_cp", "asc"]],
    metric: (r) => `${standing(r.my_min_cp)} at move ${moveNo(r.my_min_cp_ply)}, ${how(r)}`,
    ply: (r) => r.my_min_cp_ply,
  },
  {
    key: "time_swindles", title: "Flagged them while lost", engine: true,
    blurb: "Wins on time from positions the engine had you losing at the end.",
    where: (r) => r.result === "win" && r.status === "outoftime" && has(r.my_final_cp) && r.my_final_cp < -200,
    order: [["my_final_cp", "asc"]],
    metric: (r) => `${standing(r.my_final_cp)} at the end; opponent flagged on move ${fullMoves(r)}`,
    ply: (r) => r.plies,
  },
  {
    key: "material_comebacks", title: "Greatest comebacks (material)",
    blurb: "Wins after being down the most material for at least three plies in a row.",
    where: (r) => r.result === "win" && r.my_max_material_deficit > 0,
    order: [["my_max_material_deficit", "desc"], ["plies", "desc"]],
    metric: (r) => `Down ${r.my_max_material_deficit} points of material at move ${moveNo(r.my_max_deficit_ply)}`,
    ply: (r) => r.my_max_deficit_ply,
  },
  {
    key: "swindles", title: "Great escapes (draws)", engine: true,
    blurb: "Draws salvaged from positions the engine considered lost.",
    where: (r) => r.result === "draw" && has(r.my_min_winpct),
    order: [["my_min_winpct", "asc"], ["my_min_cp", "asc"]],
    metric: (r) => `${standing(r.my_min_cp)} at move ${moveNo(r.my_min_cp_ply)}, ${how(r)}`,
    ply: (r) => r.my_min_cp_ply,
  },
  {
    key: "accuracy", title: "Highest accuracy", engine: true,
    blurb: "Your most accurate games of 20+ moves (Lichess accuracy formula).",
    where: (r) => has(r.my_accuracy) && r.plies >= 40,
    order: [["my_accuracy", "desc"]],
    metric: (r) => `${r.my_accuracy.toFixed(1)}% accuracy over ${fullMoves(r)} moves (${r.result})`,
    ply: () => 0,
  },
  {
    key: "flawless", title: "Flawless long wins", engine: true,
    blurb: "The longest wins without a single inaccuracy, mistake or blunder.",
    where: (r) => r.result === "win" && r.my_blunders === 0 && r.my_mistakes === 0 && r.my_inaccuracies === 0,
    order: [["plies", "desc"]],
    metric: (r) => `${fullMoves(r)} moves, zero errors`,
    ply: () => 0,
  },
  {
    key: "rollercoasters", title: "Rollercoasters", engine: true,
    blurb: "Games where the advantage swung back and forth the most.",
    where: (r) => r.lead_changes > 0,
    order: [["lead_changes", "desc"], ["plies", "desc"]],
    metric: (r) => `${r.lead_changes} lead changes (${r.result})`,
    ply: () => 0,
  },
  {
    key: "longest", title: "Longest games",
    blurb: "Marathons, by number of moves.",
    where: () => true,
    order: [["plies", "desc"]],
    metric: (r) => `${fullMoves(r)} moves (${how(r)})`,
    ply: (r) => r.plies,
  },
  {
    key: "miniatures", title: "Miniatures",
    blurb: "Shortest wins by checkmate or resignation.",
    where: (r) => r.result === "win" && ["mate", "resign"].includes(r.status) && r.plies >= 4,
    order: [["plies", "asc"]],
    metric: (r) => `Won in ${fullMoves(r)} moves by ${statusWord(r.status)}`,
    ply: (r) => r.plies,
  },
  {
    key: "time_scrambles", title: "Time scramble wins",
    blurb: "Wins where you got closest to flagging.",
    where: (r) => r.result === "win" && has(r.my_min_clock),
    order: [["my_min_clock", "asc"], ["plies", "desc"]],
    metric: (r) => `Down to ${clock(r.my_min_clock)} on the clock, ${how(r)}`,
    ply: (r) => r.plies,
  },
  {
    key: "special_mates", title: "Unusual checkmates",
    blurb: "Mates delivered by a pawn, king, castling, en passant or underpromotion.",
    where: (r) => r.result === "win" && r.status === "mate" &&
      (["pawn", "king"].includes(r.mate_piece) || /=[NBR]#$/.test(r.moves)),
    order: [["plies", "asc"]],
    metric: specialMateLabel,
    ply: (r) => r.plies,
  },
  {
    key: "thrown_wins", title: "Heartbreakers", engine: true,
    blurb: "Losses from your most winning positions. Worth reviewing.",
    where: (r) => r.result === "loss" && has(r.my_max_winpct),
    order: [["my_max_winpct", "desc"], ["my_max_cp", "desc"]],
    metric: (r) => `${standing(r.my_max_cp)} at move ${moveNo(r.my_max_cp_ply)}, ${how(r)}`,
    ply: (r) => r.my_max_cp_ply,
  },
];

function comparator(order) {
  return (a, b) => {
    for (const [k, dir] of order) {
      const d = (a[k] ?? 0) - (b[k] ?? 0);
      if (d) return dir === "asc" ? d : -d;
    }
    return b.created_at - a.created_at;
  };
}

export function rows() {
  return db.games.filter((g) => SUPPORTED.has(g.variant)).map((g) => ({ ...db.analysis.get(g.id), ...g }));
}

export function findHighlights(top = 25) {
  const all = rows();
  return CATEGORIES.map((cat) => {
    const games = all.filter(cat.where).sort(comparator(cat.order)).slice(0, top);
    return { key: cat.key, title: cat.title, blurb: cat.blurb, engine: !!cat.engine,
             games: games.map((r) => ({ ...r, metric: cat.metric(r), key_ply: cat.ply(r) })) };
  });
}
