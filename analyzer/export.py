"""Export games as annotated PGN, and push them into Lichess studies."""

import io
import json
import time

import chess
import chess.pgn
import requests

from . import DATA, EXPORTS
from .db import connect
from .engine import board_for, clamp_cp, win_pct

NAG_FOR_DROP = [(15, chess.pgn.NAG_BLUNDER), (10, chess.pgn.NAG_MISTAKE), (5, chess.pgn.NAG_DUBIOUS_MOVE)]


def eval_comment(cp, mate):
    if mate is not None:
        return f"[%eval #{mate}]"
    if cp is not None and abs(cp) < 10000:
        return f"[%eval {cp / 100:.2f}]"
    return ""


def annotated_pgn(game_id, note=None, key_ply=None, conn=None):
    """Rebuild the game as PGN with clocks, evals, ?!/?/?? marks and a note at the key moment."""
    conn = conn or connect()
    row = conn.execute("SELECT * FROM games WHERE id = ?", (game_id,)).fetchone()
    a = conn.execute("SELECT * FROM analysis WHERE game_id = ?", (game_id,)).fetchone()
    source = chess.pgn.read_game(io.StringIO(row["pgn"])) if row["pgn"] else None

    board = board_for(row["initial_fen"], row["variant"])
    game = chess.pgn.Game()
    if source:
        for k, v in source.headers.items():
            game.headers[k] = v
    game.headers["Annotator"] = "analyzer (Stockfish)" if a and a["source"] == "stockfish" else game.headers.get("Annotator", "")
    if row["initial_fen"]:
        game.setup(board)

    evals = json.loads(a["evals"]) if a else None
    clocks = json.loads(row["clocks"]) if row["clocks"] else None
    white_first = board.turn == chess.WHITE
    wins = [win_pct(clamp_cp(cp if cp is not None else 15, mate)) for cp, mate, _ in evals] if evals else None

    node = game
    if note and key_ply == 0:
        game.comment = note
    for i, san in enumerate(row["moves"].split()):
        move = board.parse_san(san)
        node = node.add_variation(move)
        board.push(move)
        parts = []
        if evals and i + 1 < len(evals):
            parts.append(eval_comment(evals[i + 1][0], evals[i + 1][1]))
            white_moved = (i % 2 == 0) == white_first
            drop = (wins[i] - wins[i + 1]) if white_moved else (wins[i + 1] - wins[i])
            for threshold, nag in NAG_FOR_DROP:
                if drop >= threshold:
                    node.nags.add(nag)
                    best = evals[i][2]
                    if best:
                        try:
                            prev = board.copy()
                            prev.pop()
                            if best != move.uci():
                                parts.append(f"Best was {prev.san(chess.Move.from_uci(best))}.")
                        except (ValueError, AssertionError):
                            pass
                    break
        if clocks and i < len(clocks):
            secs = clocks[i] // 100
            parts.append(f"[%clk {secs // 3600}:{secs % 3600 // 60:02d}:{secs % 60:02d}]")
        if note and key_ply == i + 1:
            parts.insert(0, note)
        node.comment = " ".join(p for p in parts if p)
    return str(game)


def export_highlights(per_category=10):
    path = DATA / "highlights.json"
    if not path.exists():
        raise SystemExit("Run `highlights` first.")
    h = json.loads(path.read_text())
    out_dir = EXPORTS / "highlights"
    out_dir.mkdir(parents=True, exist_ok=True)
    conn = connect()
    for cat in h["categories"]:
        games = cat["games"][:per_category]
        if not games:
            continue
        pgns = []
        for g in games:
            pgn = annotated_pgn(g["id"], note=f"{cat['title']}: {g['metric']}", key_ply=g["key_ply"], conn=conn)
            pgns.append(pgn)
        (out_dir / f"{cat['key']}.pgn").write_text("\n\n".join(pgns) + "\n")
    print(f"Wrote annotated PGNs to {out_dir}")


# --- Lichess studies ---------------------------------------------------------

def create_study(token, name, visibility="unlisted"):
    r = requests.post(
        "https://lichess.org/api/study",
        headers={"Authorization": f"Bearer {token}"},
        data={"name": name[:100], "visibility": visibility, "computer": "everyone", "explorer": "everyone",
              "cloneable": "everyone", "shareable": "everyone", "chat": "everyone"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["id"]


def import_into_study(token, study_id, pgns, orientation=None):
    """Lichess studies hold 64 chapters; one chapter per game. A new study starts with one empty chapter."""
    for pgn in pgns:
        data = {"pgn": pgn}
        if orientation:
            data["orientation"] = orientation
        r = requests.post(f"https://lichess.org/api/study/{study_id}/import-pgn",
                          headers={"Authorization": f"Bearer {token}"}, data=data, timeout=30)
        if r.status_code == 429:
            time.sleep(60)
            r = requests.post(f"https://lichess.org/api/study/{study_id}/import-pgn",
                              headers={"Authorization": f"Bearer {token}"}, data=data, timeout=30)
        r.raise_for_status()
        time.sleep(1)


def push_category_to_study(token, category, per_category=20, visibility="unlisted", study_id=None):
    h = json.loads((DATA / "highlights.json").read_text())
    cat = next((c for c in h["categories"] if c["key"] == category), None)
    if cat is None:
        keys = ", ".join(c["key"] for c in h["categories"])
        raise SystemExit(f"Unknown category {category!r}. Choose from: {keys}")
    games = cat["games"][:min(per_category, 63)]
    if not games:
        raise SystemExit(f"No games in {category}.")
    conn = connect()
    study_id = study_id or create_study(token, f"{h['user']}: {cat['title']}", visibility)
    for i, g in enumerate(games, 1):
        pgn = annotated_pgn(g["id"], note=f"{cat['title']} #{i}: {g['metric']}", key_ply=g["key_ply"], conn=conn)
        game = chess.pgn.read_game(io.StringIO(pgn))
        game.headers["Event"] = f"#{i} {g['metric']}"[:100]
        import_into_study(token, study_id, [str(game)], orientation=g["color"])
        print(f"  {i}/{len(games)} {g['id']}")
    url = f"https://lichess.org/study/{study_id}"
    print(f"Study ready: {url}")
    return url

