"""Statistics and charts (next phase).

Everything starts from `load_games()`, one row per game with engine metrics
joined in. Planned modules (each producing tables + charts into reports/):

    rating.py     rating history per speed, peak/trough, streaks
    openings.py   performance by ECO/opening as white and black, repertoire tree
    time.py       results by time of day/weekday, clock usage, time-trouble losses
    accuracy.py   accuracy and blunder rate trends, by phase (Lichess `division`)
    opponents.py  results vs rating bands, nemeses, most-played opponents
    endings.py    how games end (mate/resign/flag), conversion of winning positions
"""

import pandas as pd

from ..db import connect


def load_games(user=None):
    from .. import config
    user = (user or config.user()).lower()
    conn = connect()
    df = pd.read_sql_query(
        """SELECT g.*, a.source AS analysis_source, a.my_accuracy, a.opp_accuracy, a.my_acpl,
                  a.my_min_cp, a.my_max_cp, a.my_final_cp, a.my_min_winpct, a.my_max_winpct,
                  a.my_inaccuracies, a.my_mistakes, a.my_blunders, a.opp_blunders, a.lead_changes
           FROM games g LEFT JOIN analysis a ON a.game_id = g.id
           WHERE g.user = ? ORDER BY g.created_at""",
        conn, params=(user,),
    )
    df["date"] = pd.to_datetime(df["created_at"], unit="ms", utc=True)
    df["score"] = df["result"].map({"win": 1.0, "draw": 0.5, "loss": 0.0})
    return df.drop(columns=["pgn", "lichess_evals"])
