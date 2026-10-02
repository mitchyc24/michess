// Annotated PGN (port of analyzer/export.py): evals, clocks, ?!/?/?? and "best was" notes.
import { startPos, parseSanMove, uciToMove, makeSan } from "./chess-util.js";
import { winSeries } from "./metrics.js";

const NAGS = [[15, "??"], [10, "?"], [5, "?!"]];
const pad = (n) => String(n).padStart(2, "0");
const date = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`; };
const TERMINATION = { mate: "Normal", resign: "Normal", outoftime: "Time forfeit", timeout: "Abandoned", draw: "Normal", stalemate: "Normal" };

function evalTag(cp, mate) {
  if (mate != null) return `[%eval #${mate}]`;
  if (cp != null && Math.abs(cp) < 10000) return `[%eval ${(cp / 100).toFixed(2)}]`;
  return "";
}
const clk = (cs) => { const s = Math.floor(cs / 100); return `[%clk ${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}]`; };

export function resultToken(g) {
  if (g.result === "draw") return "1/2-1/2";
  return (g.result === "win") === (g.color === "white") ? "1-0" : "0-1";
}

export function annotatedPgn(g, evals, { note, keyPly, event } = {}) {
  const white = g.color === "white" ? g.my_name : g.opp_name;
  const black = g.color === "white" ? g.opp_name : g.my_name;
  const res = resultToken(g);
  const headers = {
    Event: event ?? `${g.rated ? "Rated" : "Casual"} ${g.speed} game`,
    Site: `https://lichess.org/${g.id}`,
    Date: date(g.created_at),
    White: white, Black: black, Result: res,
    WhiteElo: (g.color === "white" ? g.my_rating : g.opp_rating) ?? "?",
    BlackElo: (g.color === "white" ? g.opp_rating : g.my_rating) ?? "?",
    TimeControl: g.clock_initial != null ? `${g.clock_initial}+${g.clock_increment}` : "-",
    ECO: g.eco ?? "?", Opening: g.opening ?? "?",
    Termination: TERMINATION[g.status] ?? "Normal",
  };
  if (g.variant === "chess960") headers.Variant = "Chess960";
  if (g.initial_fen) { headers.FEN = g.initial_fen; headers.SetUp = "1"; }
  if (evals) headers.Annotator = "Stockfish 19 (in browser)";

  const pos = startPos(g.initial_fen);
  const wins = evals ? winSeries(evals) : null;
  const out = [];
  if (note && keyPly === 0) out.push(`{ ${note} }`);
  g.moves.split(" ").forEach((s, i) => {
    const before = pos.clone();
    const move = parseSanMove(pos, s);
    const whiteMoved = pos.turn === "white";
    const num = whiteMoved ? `${pos.fullmoves}. ` : i === 0 ? `${pos.fullmoves}... ` : "";
    pos.play(move);
    let token = num + s;
    const parts = [];
    if (note && keyPly === i + 1) parts.push(note);
    if (evals && i + 1 < evals.length) {
      parts.push(evalTag(evals[i + 1][0], evals[i + 1][1]));
      const drop = whiteMoved ? wins[i] - wins[i + 1] : wins[i + 1] - wins[i];
      const nag = NAGS.find(([t]) => drop >= t);
      if (nag) {
        token += nag[1];
        const best = evals[i][2] && uciToMove(before, evals[i][2]);
        if (best) { const bs = makeSan(before, best); if (bs !== s) parts.push(`Best was ${bs}.`); }
      }
    }
    if (g.clocks && i < g.clocks.length) parts.push(clk(g.clocks[i]));
    const comment = parts.filter(Boolean).join(" ");
    out.push(comment ? `${token} { ${comment} }` : token);
  });
  out.push(res);
  const head = Object.entries(headers).map(([k, v]) => `[${k} "${String(v).replace(/"/g, "'")}"]`).join("\n");
  // Wrap movetext at ~80 columns.
  const lines = [];
  let line = "";
  for (const tok of out.join(" ").split(" ")) {
    if ((line + " " + tok).length > 80 && line) { lines.push(line); line = tok; } else line = line ? `${line} ${tok}` : tok;
  }
  if (line) lines.push(line);
  return `${head}\n\n${lines.join("\n")}\n`;
}

export function download(filename, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/x-chess-pgn" }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
