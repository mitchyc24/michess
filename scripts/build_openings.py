"""Build web/data/openings.json: {"<placement> <turn> <castling>": [eco, name]} from resources/openings/*.tsv.

The key omits the en-passant square so it matches regardless of how a FEN library writes it.
Run after updating resources/openings (github.com/lichess-org/chess-openings).
"""

import csv
import json
from pathlib import Path

import chess

ROOT = Path(__file__).resolve().parent.parent
out = {}
for path in sorted((ROOT / "resources" / "openings").glob("*.tsv")):
    with path.open() as f:
        for row in csv.DictReader(f, delimiter="\t"):
            board = chess.Board()
            for tok in row["pgn"].split():
                if not tok[0].isdigit():
                    board.push_san(tok)
            out[" ".join(board.fen().split()[:3])] = [row["eco"], row["name"]]
dest = ROOT / "web" / "data" / "openings.json"
dest.write_text(json.dumps(out, separators=(",", ":")))
print(f"{len(out)} positions -> {dest} ({dest.stat().st_size // 1024} KB)")
