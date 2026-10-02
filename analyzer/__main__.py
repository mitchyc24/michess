"""Command-line entry point: python -m analyzer <command> (or ./chess <command>)."""

import argparse

from . import config


def main():
    p = argparse.ArgumentParser(prog="chess", description="Lichess game analyzer")
    p.add_argument("--user", default=config.user(), help="Lichess username (default: %(default)s)")
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch", help="download new games from Lichess")
    f.add_argument("--max", type=int, help="limit number of games (for testing)")

    sub.add_parser("ingest", help="load downloaded games into the database")

    a = sub.add_parser("analyse", help="evaluate games with Stockfish")
    a.add_argument("--nodes", type=int, default=25000, help="nodes per position (default: %(default)s)")
    a.add_argument("--depth", type=int, help="fixed depth per position instead of nodes")
    a.add_argument("--workers", type=int, help="parallel engine processes (default: CPUs - 2)")
    a.add_argument("--limit", type=int, help="only analyse this many games (newest first)")
    a.add_argument("--no-lichess", action="store_true", help="ignore Lichess server analysis")

    sub.add_parser("recompute", help="re-derive metrics from stored evals")

    h = sub.add_parser("highlights", help="find notable games; writes HIGHLIGHTS.md + data/highlights.json")
    h.add_argument("--top", type=int, default=25)

    e = sub.add_parser("export", help="write annotated PGNs per highlight category")
    e.add_argument("--per-category", type=int, default=10)

    s = sub.add_parser("study", help="push a highlight category into a new Lichess study")
    s.add_argument("category", help="category key, e.g. eval_comebacks, upsets")
    s.add_argument("--count", type=int, default=20, help="games to include (max 63)")
    s.add_argument("--visibility", default="unlisted", choices=["public", "unlisted", "private"])
    s.add_argument("--study-id", help="add to an existing study instead of creating one")

    u = sub.add_parser("update", help="fetch + ingest + analyse + highlights + export")
    u.add_argument("--nodes", type=int, default=25000)

    v = sub.add_parser("serve", help="run the local game viewer")
    v.add_argument("--port", type=int, default=8765)

    args = p.parse_args()

    if args.cmd in ("fetch", "update"):
        from .fetch import fetch_games
        fetch_games(args.user, token=config.token(), max_games=getattr(args, "max", None))
    if args.cmd in ("ingest", "update"):
        from .ingest import ingest
        ingest(args.user)
    if args.cmd in ("analyse", "update"):
        from .engine import analyse_all
        analyse_all(args.user, nodes=args.nodes, depth=getattr(args, "depth", None),
                    workers=getattr(args, "workers", None), limit=getattr(args, "limit", None),
                    use_lichess=not getattr(args, "no_lichess", False))
    if args.cmd == "recompute":
        from .engine import recompute_metrics
        recompute_metrics()
    if args.cmd in ("highlights", "update"):
        from .highlights import run
        run(args.user, top=getattr(args, "top", 25))
    if args.cmd in ("export", "update"):
        from .export import export_highlights
        export_highlights(getattr(args, "per_category", 10))
    if args.cmd == "study":
        from .export import push_category_to_study
        if not config.token():
            raise SystemExit("Needs LICHESS_TOKEN with study:write scope (see README).")
        push_category_to_study(config.token(), args.category, args.count, args.visibility, args.study_id)
    if args.cmd == "serve":
        from .server import serve
        serve(args.port)


if __name__ == "__main__":
    main()
