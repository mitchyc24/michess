"""Settings from environment variables or a .env file in the project root."""

import os

from . import DEFAULT_USER, ROOT


def _load_dotenv():
    path = ROOT / ".env"
    if not path.exists():
        return {}
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            values[k.strip()] = v.strip().strip("'\"")
    return values


_env = _load_dotenv()


def get(key, default=None):
    return os.environ.get(key) or _env.get(key) or default


def token():
    return get("LICHESS_TOKEN")


def user():
    return get("LICHESS_USER", DEFAULT_USER)
