"""Download a user's games from the Lichess API as NDJSON.

Incremental: re-running only fetches games newer than the newest one on disk.
"""

import json
import time

import requests

from . import RAW

API = "https://lichess.org/api/games/user/{user}"


def raw_path(user):
    return RAW / f"{user.lower()}.ndjson"


def newest_timestamp(path):
    newest = 0
    if path.exists():
        with path.open() as f:
            for line in f:
                if line.strip():
                    newest = max(newest, json.loads(line)["createdAt"])
    return newest


def fetch_games(user, token=None, since=None, max_games=None):
    path = raw_path(user)
    path.parent.mkdir(parents=True, exist_ok=True)
    if since is None:
        newest = newest_timestamp(path)
        since = newest + 1 if newest else None

    params = {
        "pgnInJson": "true",
        "evals": "true",
        "accuracy": "true",
        "clocks": "true",
        "opening": "true",
        "division": "true",
        "sort": "dateAsc",
    }
    if since:
        params["since"] = since
    if max_games:
        params["max"] = max_games
    headers = {"Accept": "application/x-ndjson"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    count = 0
    start = time.time()
    while True:
        try:
            with requests.get(API.format(user=user), params=params, headers=headers,
                              stream=True, timeout=60) as r:
                if r.status_code == 429:
                    print("Rate limited; sleeping 60s")
                    time.sleep(60)
                    continue
                if r.status_code in (401, 404) and not token:
                    raise SystemExit(
                        "Lichess refused an anonymous export. Create a token at "
                        "https://lichess.org/account/oauth/token (study:write scope recommended) "
                        "and put LICHESS_TOKEN=... in .env")
                r.raise_for_status()
                with path.open("a") as out:
                    for line in r.iter_lines():
                        if not line:
                            continue
                        game = json.loads(line)
                        out.write(json.dumps(game) + "\n")
                        count += 1
                        params["since"] = game["createdAt"] + 1
                        if count % 250 == 0:
                            print(f"  {count} games ({count / (time.time() - start):.1f}/s)", flush=True)
            break
        except (requests.ConnectionError, requests.Timeout, requests.exceptions.ChunkedEncodingError) as e:
            # Resume from the last game written.
            print(f"Connection dropped ({e.__class__.__name__}); resuming after {count} games")
            time.sleep(5)
    print(f"Fetched {count} new games -> {path}")
    return count
