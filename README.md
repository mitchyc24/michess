# Chess

A home for everything chess. First resident: a **Lichess game analyzer** for
[Simply_a_Pawn](https://lichess.org/@/Simply_a_Pawn), which downloads every game,
evaluates every position with Stockfish, finds the extraordinary ones, and lets
you review them in Lichess or in a bespoke local viewer.

```
analyzer/            Python package (CLI: ./chess <command>)
  fetch.py           download games from the Lichess API (incremental)
  ingest.py          NDJSON -> SQLite, plus engine-free facts (material swings, clocks, mates)
  engine.py          parallel Stockfish analysis; Lichess accuracy / win% / blunder formulas
  highlights.py      the "notable games" categories
  export.py          annotated PGNs and Lichess study upload
  openings.py        opening tree builder + Lichess opening-name lookup by position
  server.py          backend for the viewer (game API, opening tree API, live Stockfish)
  stats/             statistics & charts (next phase; load_games() -> DataFrame)
viewer/              local UI: game review (index.html) and opening tree (tree.html)
web/                 the same app as a static, fully client-side website (see web/README.md)
scripts/             build helpers (build_openings.py -> web/data/openings.json)
resources/openings/  Lichess opening names (github.com/lichess-org/chess-openings)
engine/              Stockfish binary (engine/install_stockfish.sh)
data/                games.db, raw downloads, highlights.json, exports/  (gitignored)
reports/             generated charts and reports (next phase)
notebooks/           ad-hoc exploration
HIGHLIGHTS.md        generated index of notable games with Lichess links
```

## Setup

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
engine/install_stockfish.sh            # already done on this machine
cp .env.example .env                   # then paste your Lichess token
```

Lichess no longer allows anonymous game exports, so a personal API token is required:
create one at <https://lichess.org/account/oauth/token>. No scopes are needed to download
games; tick **study:write** if you want `./chess study` to create Lichess studies.

## Usage

```bash
./chess update            # fetch + ingest + analyse + highlights + export (run any time; incremental)
./chess serve             # viewer at http://127.0.0.1:8765
```

Or run the steps individually:

| Command | What it does |
|---|---|
| `./chess fetch` | Download new games to `data/raw/` (resumes where it left off) |
| `./chess ingest` | Load them into `data/games.db` |
| `./chess analyse [--nodes N] [--workers N] [--limit N]` | Stockfish every position of every unanalysed game. Games with Lichess server analysis reuse it. Default 25k nodes/position: roughly 2 hours for ~10k games on 10 cores; it saves as it goes, so it can be stopped and resumed. |
| `./chess highlights` | Rank notable games; writes `HIGHLIGHTS.md` and `data/highlights.json` |
| `./chess export` | Annotated PGNs per category in `data/exports/highlights/` (evals, clocks, `?!`/`?`/`??`, "best was …", a note at the key moment) |
| `./chess study eval_comebacks --count 20` | Create an unlisted Lichess study with one chapter per game, oriented to your side |
| `./chess recompute` | Re-derive metrics from stored evals after changing a formula (no re-analysis) |

## Highlight categories

| Key | Category | Ranked by |
|---|---|---|
| `upsets` | Biggest upsets | Opponent rating minus yours, rated wins |
| `strongest_beaten` | Strongest opponents beaten | Opponent rating |
| `eval_comebacks` | Greatest comebacks (engine) | Lowest engine win% you recovered from (won by mate/resignation, or final position not lost) |
| `time_swindles` | Flagged them while lost | Wins on time from the most lost final positions |
| `material_comebacks` | Greatest comebacks (material) | Largest material deficit held for 3+ plies, then won |
| `swindles` | Great escapes | Draws from the most lost positions |
| `accuracy` | Highest accuracy | Lichess-formula accuracy, games of 20+ moves |
| `flawless` | Flawless long wins | Longest wins with zero inaccuracies |
| `rollercoasters` | Rollercoasters | Times the advantage changed hands (beyond ±1.5) |
| `longest` | Longest games | Move count |
| `miniatures` | Miniatures | Shortest wins by mate/resignation |
| `time_scrambles` | Time scramble wins | Lowest clock you survived |
| `special_mates` | Unusual checkmates | Mate by pawn, king, castling, or underpromotion |
| `thrown_wins` | Heartbreakers | Losses from your most winning positions |

Adding a category is one dict in `CATEGORIES` in `analyzer/highlights.py` (a SQL `where`, an
`order`, a label and a "key moment" ply).

## Reviewing games

- **Lichess:** every entry links to `lichess.org/<id>#<ply>`, which opens at the key moment.
  Request computer analysis there for Lichess's own review.
- **Lichess studies:** `./chess study <category>` bundles a category into a study.
- **Local viewer:** `./chess serve` gives you highlights by category, a searchable list of all games,
  an eval graph (click to jump), blunders marked in the move list, a ★ key-moment jump (`k`),
  clocks, free exploration (play any move to branch off), and live multi-line Stockfish.
  Keys: ← → Home End, `f` to flip, `k` for the key moment.

## Opening tree

`./chess serve`, then **Opening tree →** (or http://127.0.0.1:8765/tree.html).

- Every move sequence you've played, as White or as Black, as a tree: positions are nodes, moves are edges.
- **Line thickness** = number of games down that path. **Color** = your score down that path
  (wins + ½ draws): blue for net wins, gray around 50%, red for net losses (full color at 64% / 36%).
- **Opening names** (Lichess's ~3,800 named positions) label the node where the name changes: the full name
  where a new opening family starts, then just the variation after that. Names are matched by position,
  so transpositions are labeled correctly.
- Click a node to expand it and see details: board, W/D/L, average opponent, next moves with results,
  the games that reached it (open in the review viewer or on Lichess at that move), and links to
  Lichess's analysis board / opening explorer.
- Filters: color, time control, period, rated/casual, depth (plies), minimum games per line.
  Search jumps to a named opening. **Expand** opens one more level everywhere; **Reset** returns to main lines.
- **2D** (pan/zoom tree) or **3D** (rotate with left-drag, zoom with the wheel, click nodes).

## Web app (host it for free)

`web/` is a standalone static version: visitors enter a Lichess username, log in with Lichess (or paste
a token), and their games are downloaded and analysed by Stockfish **in their own browser**. Highlights,
review, opening tree and exports all work, with no server. Run it locally with
`python3 -m http.server 8000 --directory web`, and deploy with the included GitHub Pages workflow
(details in `web/README.md`).

## Notes

- Evaluations are from White's point of view in storage; metrics are from your point of view.
  Mate scores are stored as ±(10000 − n).
- Accuracy, win% and the inaccuracy/mistake/blunder thresholds (5/10/15 win% points lost)
  follow Lichess's published formulas, but are computed from our evals, so numbers differ
  slightly from Lichess's own analysis.
- Set `ANALYZER_DATA=/some/dir` to point the tool at a different data directory (useful for testing).

## Roadmap

- [x] Download + index all games
- [x] Engine analysis, notable-games finder, Lichess links/studies, local viewer
- [ ] Stats & charts: rating history, openings repertoire & performance, time-of-day,
      accuracy trends, opponent bands, time management, endgame conversion (`analyzer/stats/`)
- [x] Opening tree of your own games
- [ ] Puzzle generation from your own blunders
