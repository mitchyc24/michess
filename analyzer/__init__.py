"""Lichess game analyzer: fetch, index, evaluate and surface notable games."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ["ANALYZER_DATA"]) if os.environ.get("ANALYZER_DATA") else ROOT / "data"
RAW = DATA / "raw"
EXPORTS = DATA / "exports"
DB_PATH = DATA / "games.db"
DEFAULT_USER = "Simply_a_Pawn"
