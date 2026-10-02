# Chess Lens (static web app)

The analyzer as a fully client-side web app. A visitor enters their Lichess username and logs in with
Lichess (or pastes an API token); games download straight from the Lichess API into the browser
(IndexedDB), Stockfish 19 runs on their own device in Web Workers, and everything (highlights, game
review, opening tree, PGN and Lichess-study export) is computed locally. No server, no build step.

## Run locally

```bash
python3 -m http.server 8000 --directory web    # then open http://localhost:8000
```

(Must be served over http(s), not opened as a file. "Log in with Lichess" needs https or localhost.)

## Host for free

Any static host works. Nothing needs special headers: the engine is the single-threaded build, run as
one Web Worker per core, so cross-origin isolation (SharedArrayBuffer) isn't required.

- **GitHub Pages:** push this repo to GitHub, set *Settings → Pages → Source* to "GitHub Actions";
  `.github/workflows/pages.yml` publishes `web/` on every push to `main`.
- **Netlify / Cloudflare Pages:** set the publish directory to `web` (no build command).

## How it works

| File | Role |
|---|---|
| `js/app.js` | Shell: setup/login, routing (`#review`, `#review/<id>`, `#tree`), download + analysis jobs |
| `js/auth.js` | Token storage and "Log in with Lichess" (OAuth2 PKCE, no client secret or registration) |
| `js/lichess.js` | Lichess API: streaming NDJSON game export (resumable), account, studies |
| `js/ingest.js` | Raw game → record: material swings, mates, clocks; reuses Lichess server analysis |
| `js/engine.js` | Stockfish worker pool for batch analysis; live multi-PV engine for the board |
| `js/metrics.js` | Lichess win%, accuracy and mistake formulas |
| `js/highlights.js` | Notable-game categories |
| `js/openings.js` | Opening tree + opening-name lookup |
| `js/review.js`, `js/tree.js` | The two views |
| `js/pgn.js` | Annotated PGN export |
| `js/store.js` | IndexedDB (games, analysis, evals) |
| `engine/` | `stockfish-19-lite-single` from [stockfish.js](https://github.com/nmrugg/stockfish.js) (GPLv3) |
| `data/openings.json` | Built by `scripts/build_openings.py` from `resources/openings/` |

Libraries load from jsDelivr: chessops, chessground, d3, 3d-force-graph.

## Privacy

The token is kept in localStorage ("remember on this device") or sessionStorage and is only ever sent
to lichess.org. Games and analysis never leave the browser. "Delete local data" removes a player's data.

## Licensing

Stockfish is GPLv3; its license is in `engine/COPYING-stockfish.txt`, and its source is at the
stockfish.js link above. If you publish this app, keep that file and the credit line on the setup page.
