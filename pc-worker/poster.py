"""PC poster: uploads clips that are due, straight from this PC, at full quality.

Runs in the background. Every minute it asks the online app what is due, uploads those
videos to Instagram from their file on this PC, and the app then publishes them and marks
them posted. If the PC was off at a posting time, the post goes out when it is back on.

Usage:  python poster.py          (keeps running)
        python poster.py --once   (one check, then exit)
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from import_existing import Api, load_env

HERE = Path(__file__).resolve().parent
log = logging.getLogger("poster")


def upload_to_instagram(upload_uri: str, access_token: str, file: Path, timeout: int = 900) -> None:
    """Send the whole file to Instagram's resumable upload address (streamed from disk)."""
    size = file.stat().st_size
    with open(file, "rb") as fh:
        req = urllib.request.Request(upload_uri, data=fh, method="POST", headers={
            "Authorization": f"OAuth {access_token}",
            "offset": "0",
            "file_size": str(size),
            "content-length": str(size),
            "content-type": "application/octet-stream",
            "user-agent": "autoposter-pc/1.0",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raise UploadError(f"Instagram upload refused ({e.code}): {e.read()[:300].decode(errors='replace')}") from None
    if not body.get("success", False):
        raise UploadError(f"Instagram upload did not confirm: {json.dumps(body)[:300]}")


class UploadError(Exception):
    pass


def handle(api: Api, post: dict, uploader=upload_to_instagram) -> str:
    """Process one due post. Returns what happened, for the log."""
    if post["platform"] != "instagram":
        return "skipped (only Instagram uploads from the PC for now)"
    path = Path(post["local_path"])
    if not path.is_file():
        api.fail(post["id"], f"file not found: {path}", permanent=True)
        return f"file missing: {path}"
    try:
        start = api.start_instagram(post["id"])
    except RuntimeError as e:
        # 409 = already started or not connected: nothing to upload now
        return f"not started: {e}"
    try:
        uploader(start["upload_uri"], start["access_token"], path)
    except (UploadError, urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
        api.fail(post["id"], str(e)[:400])
        return f"upload failed: {e}"
    return "uploaded, Instagram is processing it"


class PosterApi(Api):
    def due(self) -> list[dict]:
        return self._send("GET", "/api/worker/due")  # type: ignore[return-value]

    def start_instagram(self, post_id: str) -> dict:
        return self._send("POST", f"/api/worker/posts/{post_id}/instagram/start")

    def fail(self, post_id: str, error: str, permanent: bool = False) -> None:
        self._send("POST", f"/api/worker/posts/{post_id}/fail",
                   data=json.dumps({"error": error, "permanent": permanent}).encode(),
                   headers={"content-type": "application/json"})


def check_once(api: PosterApi) -> int:
    posts = api.due()
    for p in posts:
        log.info("%s %s: %s", p["platform"], p["title"], handle(api, p))
    return len(posts)


def main(argv: list[str] | None = None) -> int:
    env = load_env()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--once", action="store_true", help="check one time and exit")
    ap.add_argument("--every", type=int, default=60, help="seconds between checks")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", handlers=[
        logging.FileHandler(HERE / "poster.log", encoding="utf-8"), logging.StreamHandler(sys.stdout)])
    if not env.get("AUTOPOSTER_WORKER_TOKEN") or not env.get("AUTOPOSTER_API"):
        log.error("AUTOPOSTER_API and AUTOPOSTER_WORKER_TOKEN must be set in pc-worker/.env")
        return 2
    api = PosterApi(env["AUTOPOSTER_API"], env["AUTOPOSTER_WORKER_TOKEN"])
    log.info("poster started, checking %s every %ss", env["AUTOPOSTER_API"], a.every)
    while True:
        try:
            check_once(api)
        except Exception as e:  # network down, PC just woke up...: try again next round
            log.warning("check failed: %s", e)
        if a.once:
            return 0
        time.sleep(a.every)


if __name__ == "__main__":
    raise SystemExit(main())
