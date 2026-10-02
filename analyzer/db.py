"""SQLite storage. One row per game, plus a per-game engine analysis row."""

import sqlite3

from . import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS games (
    id              TEXT PRIMARY KEY,
    user            TEXT NOT NULL,          -- lowercased username these stats are about
    created_at      INTEGER NOT NULL,       -- ms since epoch
    last_move_at    INTEGER,
    rated           INTEGER,
    variant         TEXT,
    speed           TEXT,
    perf            TEXT,
    clock_initial   INTEGER,                -- seconds
    clock_increment INTEGER,
    status          TEXT,                   -- mate, resign, outoftime, draw, stalemate, ...
    color           TEXT,                   -- my color: white / black
    result          TEXT,                   -- my result: win / loss / draw
    my_rating       INTEGER,
    my_rating_diff  INTEGER,
    opp_name        TEXT,
    opp_rating      INTEGER,
    opp_title       TEXT,
    rating_gap      INTEGER,                -- opp_rating - my_rating
    eco             TEXT,
    opening         TEXT,
    plies           INTEGER,
    initial_fen     TEXT,
    moves           TEXT,                   -- SAN, space separated
    clocks          TEXT,                   -- JSON list of centiseconds remaining after each ply
    tournament      TEXT,
    -- Lichess server analysis (only present when someone requested it)
    lichess_evals   TEXT,                   -- JSON list [{eval}|{mate}] after each ply, white POV
    lichess_my_acc  REAL,
    lichess_opp_acc REAL,
    -- Engine-free material facts, computed on ingest
    my_max_material_deficit INTEGER,        -- worst material balance for me (pawn units, >= 0)
    my_max_deficit_ply      INTEGER,
    final_material_balance  INTEGER,        -- my material minus theirs at the end
    mate_piece      TEXT,                   -- piece that delivered checkmate (if mate)
    my_min_clock    INTEGER,                -- lowest clock I reached (centiseconds)
    pgn             TEXT
);
CREATE INDEX IF NOT EXISTS idx_games_user ON games(user, created_at);

CREATE TABLE IF NOT EXISTS analysis (
    game_id         TEXT PRIMARY KEY REFERENCES games(id),
    source          TEXT,                   -- 'lichess' or 'stockfish'
    engine_limit    TEXT,                   -- e.g. 'nodes=100000'
    evals           TEXT,                   -- JSON list per position (ply 0..N): [cp, mate, best_uci], white POV
    my_accuracy     REAL,
    opp_accuracy    REAL,
    my_acpl         REAL,
    my_min_cp       INTEGER,                -- worst eval from my POV (centipawns; mate in n = -(10000 - n))
    my_min_cp_ply   INTEGER,
    my_max_cp       INTEGER,
    my_max_cp_ply   INTEGER,
    my_min_winpct   REAL,
    my_max_winpct   REAL,
    my_inaccuracies INTEGER,
    my_mistakes     INTEGER,
    my_blunders     INTEGER,
    opp_blunders    INTEGER,
    my_final_cp     INTEGER,                -- eval of the final position from my POV
    lead_changes    INTEGER,                -- times the "winning side" flipped (|eval| > 150cp)
    analysed_at     INTEGER
);
"""


# Columns added after the first release: (table, column, type)
MIGRATIONS = [
    ("games", "my_max_deficit_ply", "INTEGER"),
    ("analysis", "my_final_cp", "INTEGER"),
]


def connect(path=DB_PATH):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    for table, column, kind in MIGRATIONS:
        existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
    return conn
