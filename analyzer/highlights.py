"""Find extraordinary games: upsets, comebacks, marathons, miniatures, accuracy records...

Each category is a SQL query over `games` (+ `analysis` for engine-based ones).
Results are written to data/highlights.json (consumed by the viewer) and
HIGHLIGHTS.md (a browsable index with Lichess links).
"""

import json
from datetime import datetime, timezone

from . import DATA, ROOT
from .db import connect

BASE = """
SELECT g.*, a.my_accuracy, a.opp_accuracy, a.my_min_cp, a.my_min_cp_ply, a.my_max_cp, a.my_max_cp_ply,
       a.my_min_winpct, a.my_max_winpct, a.my_blunders, a.my_mistakes, a.my_inaccuracies,
       a.lead_changes, a.my_final_cp, a.source AS analysis_source
FROM games g LEFT JOIN analysis a ON a.game_id = g.id
WHERE g.user = :user AND g.variant IN ('standard', 'chess960', 'fromPosition')
"""


def standing(cp, verb_down="Down", verb_up="Up"):
    """'Down 6.3', 'Facing mate in 2', 'Had mate in 3' style phrases (cp from my POV)."""
    if abs(cp) >= 9000:
        n = 10000 - abs(cp)
        return f"Facing mate in {n}" if cp < 0 else f"Had mate in {n}"
    return f"{verb_down if cp < 0 else verb_up} {abs(cp) / 100:.1f}"


STATUS_WORDS = {"mate": "checkmate", "resign": "resignation", "outoftime": "timeout", "timeout": "abandonment",
                "stalemate": "stalemate", "draw": "agreement/repetition", "insufficientMaterialClaim": "insufficient material",
                "variantEnd": "variant end", "noStart": "no start", "cheat": "cheat detection"}


def how(r):
    """'won by checkmate', 'drew by stalemate', ..."""
    verb = {"win": "won", "loss": "lost", "draw": "drew"}[r["result"]]
    return f"{verb} by {STATUS_WORDS.get(r['status'], r['status'])}"


def clock(cs):
    return f"{cs / 100:.1f}s" if cs is not None else "?"


# Each category: key, title, blurb, where (SQL), order (SQL), metric(row) -> str, ply(row) -> key moment
CATEGORIES = [
    {
        "key": "upsets",
        "title": "Biggest upsets",
        "blurb": "Rated wins against the highest-rated opponents relative to your own rating.",
        "where": "g.result = 'win' AND g.rated = 1 AND g.rating_gap > 0",
        "order": "g.rating_gap DESC",
        "metric": lambda r: f"+{r['rating_gap']} rating gap ({r['my_rating']} vs {r['opp_rating']})",
        "ply": lambda r: r["plies"],
    },
    {
        "key": "strongest_beaten",
        "title": "Strongest opponents beaten",
        "blurb": "Wins against the highest absolute ratings, whatever your rating was at the time.",
        "where": "g.result = 'win' AND g.rated = 1 AND g.opp_rating IS NOT NULL",
        "order": "g.opp_rating DESC",
        "metric": lambda r: f"{(r['opp_title'] + ' ') if r['opp_title'] else ''}{r['opp_rating']} rated opponent",
        "ply": lambda r: r["plies"],
    },
    {
        "key": "eval_comebacks",
        "title": "Greatest comebacks (engine)",
        "blurb": "Wins where the engine gave you the lowest winning chances, and you genuinely turned it "
                 "around (not just a flag in a lost position).",
        "where": """g.result = 'win' AND a.my_min_winpct IS NOT NULL
                    AND (g.status IN ('mate', 'resign') OR a.my_final_cp > -200)""",
        "order": "a.my_min_winpct ASC, a.my_min_cp ASC",
        "metric": lambda r: f"{standing(r['my_min_cp'])} at move {(r['my_min_cp_ply'] + 1) // 2}, "
                            f"{how(r)}",
        "ply": lambda r: r["my_min_cp_ply"],
        "engine": True,
    },
    {
        "key": "time_swindles",
        "title": "Flagged them while lost",
        "blurb": "Wins on time from positions the engine had you losing at the end.",
        "where": "g.result = 'win' AND g.status = 'outoftime' AND a.my_final_cp < -200",
        "order": "a.my_final_cp ASC",
        "metric": lambda r: f"{standing(r['my_final_cp'])} at the end; opponent flagged on move {(r['plies'] + 1) // 2}",
        "ply": lambda r: r["plies"],
        "engine": True,
    },
    {
        "key": "material_comebacks",
        "title": "Greatest comebacks (material)",
        "blurb": "Wins after being down the most material for at least three plies in a row.",
        "where": "g.result = 'win' AND g.my_max_material_deficit > 0",
        "order": "g.my_max_material_deficit DESC, g.plies DESC",
        "metric": lambda r: f"Down {r['my_max_material_deficit']} points of material at move "
                            f"{(r['my_max_deficit_ply'] + 1) // 2}",
        "ply": lambda r: r["my_max_deficit_ply"],
    },
    {
        "key": "swindles",
        "title": "Great escapes (draws)",
        "blurb": "Draws salvaged from positions the engine considered lost.",
        "where": "g.result = 'draw' AND a.my_min_winpct IS NOT NULL",
        "order": "a.my_min_winpct ASC",
        "metric": lambda r: f"{standing(r['my_min_cp'])} at move {(r['my_min_cp_ply'] + 1) // 2}, {how(r)}",
        "ply": lambda r: r["my_min_cp_ply"],
        "engine": True,
    },
    {
        "key": "accuracy",
        "title": "Highest accuracy",
        "blurb": "Your most accurate games of 20+ moves (Lichess accuracy formula).",
        "where": "a.my_accuracy IS NOT NULL AND g.plies >= 40",
        "order": "a.my_accuracy DESC",
        "metric": lambda r: f"{r['my_accuracy']:.1f}% accuracy over {(r['plies'] + 1) // 2} moves ({r['result']})",
        "ply": lambda r: 0,
        "engine": True,
    },
    {
        "key": "flawless",
        "title": "Flawless long wins",
        "blurb": "The longest wins without a single inaccuracy, mistake or blunder.",
        "where": "g.result = 'win' AND a.my_blunders = 0 AND a.my_mistakes = 0 AND a.my_inaccuracies = 0",
        "order": "g.plies DESC",
        "metric": lambda r: f"{(r['plies'] + 1) // 2} moves, zero errors",
        "ply": lambda r: 0,
        "engine": True,
    },
    {
        "key": "rollercoasters",
        "title": "Rollercoasters",
        "blurb": "Games where the advantage swung back and forth the most.",
        "where": "a.lead_changes > 0",
        "order": "a.lead_changes DESC, g.plies DESC",
        "metric": lambda r: f"{r['lead_changes']} lead changes ({r['result']})",
        "ply": lambda r: 0,
        "engine": True,
    },
    {
        "key": "longest",
        "title": "Longest games",
        "blurb": "Marathons, by number of moves.",
        "where": "1 = 1",
        "order": "g.plies DESC",
        "metric": lambda r: f"{(r['plies'] + 1) // 2} moves ({how(r)})",
        "ply": lambda r: r["plies"],
    },
    {
        "key": "miniatures",
        "title": "Miniatures",
        "blurb": "Shortest wins by checkmate or resignation.",
        "where": "g.result = 'win' AND g.status IN ('mate', 'resign') AND g.plies >= 4",
        "order": "g.plies ASC",
        "metric": lambda r: f"Won in {(r['plies'] + 1) // 2} moves by {STATUS_WORDS.get(r['status'], r['status'])}",
        "ply": lambda r: r["plies"],
    },
    {
        "key": "time_scrambles",
        "title": "Time scramble wins",
        "blurb": "Wins where you got closest to flagging.",
        "where": "g.result = 'win' AND g.my_min_clock IS NOT NULL",
        "order": "g.my_min_clock ASC, g.plies DESC",
        "metric": lambda r: f"Down to {clock(r['my_min_clock'])} on the clock, {how(r)}",
        "ply": lambda r: r["plies"],
    },
    {
        "key": "special_mates",
        "title": "Unusual checkmates",
        "blurb": "Mates delivered by a pawn, king, castling, en passant or underpromotion.",
        "where": """g.result = 'win' AND g.status = 'mate' AND (
                        g.mate_piece IN ('pawn', 'king')
                        OR g.moves LIKE '%=N#' OR g.moves LIKE '%=B#' OR g.moves LIKE '%=R#')""",
        "order": "g.plies ASC",
        "metric": lambda r: special_mate_label(r),
        "ply": lambda r: r["plies"],
    },
    {
        "key": "thrown_wins",
        "title": "Heartbreakers",
        "blurb": "Losses from your most winning positions. Worth reviewing.",
        "where": "g.result = 'loss' AND a.my_max_winpct IS NOT NULL",
        "order": "a.my_max_winpct DESC, a.my_max_cp DESC",
        "metric": lambda r: f"{standing(r['my_max_cp'])} at move {(r['my_max_cp_ply'] + 1) // 2}, {how(r)}",
        "ply": lambda r: r["my_max_cp_ply"],
        "engine": True,
    },
]


def special_mate_label(r):
    last = r["moves"].split()[-1]
    if last.startswith("O-O"):
        return f"Castling checkmate ({last})"
    if "=" in last and not last.endswith("=Q#"):
        return f"Underpromotion checkmate ({last})"
    return f"Checkmate with the {r['mate_piece']} ({last})"


def lichess_url(row, ply=None):
    url = f"https://lichess.org/{row['id']}"
    if row["color"] == "black":
        url += "/black"
    if ply:
        url += f"#{ply}"
    return url


def entry(cat, row):
    ply = cat["ply"](row)
    return {
        "id": row["id"],
        "url": lichess_url(row, ply),
        "date": datetime.fromtimestamp(row["created_at"] / 1000, timezone.utc).strftime("%Y-%m-%d"),
        "color": row["color"],
        "result": row["result"],
        "status": row["status"],
        "speed": row["speed"],
        "time_control": f"{row['clock_initial'] // 60}+{row['clock_increment']}" if row["clock_initial"] is not None else None,
        "rated": bool(row["rated"]),
        "my_rating": row["my_rating"],
        "opp_name": row["opp_name"],
        "opp_title": row["opp_title"],
        "opp_rating": row["opp_rating"],
        "opening": row["opening"],
        "eco": row["eco"],
        "moves": (row["plies"] + 1) // 2,
        "my_accuracy": round(row["my_accuracy"], 1) if row["my_accuracy"] is not None else None,
        "metric": cat["metric"](row),
        "key_ply": ply,
    }


def find_highlights(user, top=25, conn=None):
    conn = conn or connect()
    analysed = conn.execute("SELECT COUNT(*) FROM analysis a JOIN games g ON g.id = a.game_id WHERE g.user = ?",
                            (user.lower(),)).fetchone()[0]
    total = conn.execute("SELECT COUNT(*) FROM games WHERE user = ?", (user.lower(),)).fetchone()[0]
    out = {
        "user": user,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "games": total,
        "analysed": analysed,
        "categories": [],
    }
    for cat in CATEGORIES:
        rows = conn.execute(f"{BASE} AND ({cat['where']}) ORDER BY {cat['order']} LIMIT :top",
                            {"user": user.lower(), "top": top}).fetchall()
        out["categories"].append({
            "key": cat["key"],
            "title": cat["title"],
            "blurb": cat["blurb"],
            "engine": cat.get("engine", False),
            "games": [entry(cat, r) for r in rows],
        })
    return out


def write_markdown(h, path, per_category=10):
    lines = [
        f"# Notable games: {h['user']}",
        "",
        f"Generated {h['generated_at']} from {h['games']} games "
        f"({h['analysed']} with engine analysis). Regenerate with `./chess highlights`.",
        "",
        "Browse these interactively with `./chess serve`. PGNs per category are in `data/exports/highlights/`.",
        "",
    ]
    for cat in h["categories"]:
        lines += [f"## {cat['title']}", "", f"_{cat['blurb']}_", ""]
        if not cat["games"]:
            lines += ["_No games yet" + (" (needs engine analysis: run `./chess analyse`)" if cat["engine"] else "") + "._", ""]
            continue
        lines += ["| # | Highlight | Opponent | Result | Date | Speed | Game |", "|---|---|---|---|---|---|---|"]
        for i, g in enumerate(cat["games"][:per_category], 1):
            opp = f"{(g['opp_title'] + ' ') if g['opp_title'] else ''}{g['opp_name']} ({g['opp_rating'] or '?'})"
            lines.append(f"| {i} | {g['metric']} | {opp} | {g['result']} as {g['color']} | {g['date']} "
                         f"| {g['time_control'] or g['speed']} | [{g['id']}]({g['url']}) |")
        lines.append("")
    path.write_text("\n".join(lines))


def run(user, top=25):
    h = find_highlights(user, top)
    (DATA / "highlights.json").write_text(json.dumps(h, indent=1))
    write_markdown(h, ROOT / "HIGHLIGHTS.md")
    print(f"Wrote {DATA / 'highlights.json'} and {ROOT / 'HIGHLIGHTS.md'}")
    for cat in h["categories"]:
        best = cat["games"][0]["metric"] if cat["games"] else "(none)"
        print(f"  {cat['title']:<32} {best}")
    return h
