"""Spotify app-credential store backed by a file in a bind-mounted directory.

The Spotify client credentials (client_id / client_secret) are persisted to
credentials.json inside the credentials directory. The directory defaults to
/spotify-tracker and may be overridden with the SPOTIFY_CREDS_DIR environment
variable (a path knob, not a credential).

The server reads the file on demand (no caching) and writes it when
credentials are configured through the API, so the credentials themselves
never need to live in environment variables.
"""
import json
import os

_DEFAULT_DIR = "/spotify-tracker"
_FILE_NAME = "credentials.json"


def creds_dir() -> str:
    return os.environ.get("SPOTIFY_CREDS_DIR", _DEFAULT_DIR)


def creds_path() -> str:
    return os.path.join(creds_dir(), _FILE_NAME)


def load_credentials() -> dict:
    """Read the credential file fresh. Returns empty values when missing/invalid."""
    try:
        with open(creds_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return {
            "client_id": str(data.get("client_id", "")),
            "client_secret": str(data.get("client_secret", "")),
        }
    except Exception:
        return {"client_id": "", "client_secret": ""}


def save_credentials(client_id: str, client_secret: str) -> str:
    """Atomically write the credential file (mode 0600). Returns the file path."""
    d = creds_dir()
    os.makedirs(d, exist_ok=True)
    path = creds_path()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"client_id": client_id, "client_secret": client_secret}, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


def configured() -> bool:
    c = load_credentials()
    return bool(c["client_id"].strip() and c["client_secret"].strip())
