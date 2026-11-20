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


# Instagram rejects Reels above 25 Mbps; re-encode anything near that to a clean 15 Mbps copy
# (Instagram plays Reels back far below this, so there is no visible loss).
MAX_BITRATE = 18_000_000
WINGET_FFMPEG = Path.home() / "AppData/Local/Microsoft/WinGet/Packages"


def find_tool(name: str) -> str:
    import shutil
    found = shutil.which(name)
    if found:
        return found
    for p in WINGET_FFMPEG.glob(f"Gyan.FFmpeg*/**/bin/{name}.exe"):
        return str(p)
    raise UploadError(f"{name} not found (install ffmpeg or add it to PATH)")


def probe(file: Path) -> dict:
    import subprocess
    out = subprocess.run([find_tool("ffprobe"), "-v", "error", "-show_entries", "format=bit_rate:stream=codec_name,codec_type",
                          "-of", "json", str(file)], capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    streams = {s["codec_type"]: s["codec_name"] for s in data.get("streams", [])}
    return {"bit_rate": int(data.get("format", {}).get("bit_rate") or 0), "video": streams.get("video"), "audio": streams.get("audio")}


def needs_reencode(info: dict) -> bool:
    return info["bit_rate"] > MAX_BITRATE or info["video"] != "h264" or info["audio"] not in ("aac", None)


def instagram_ready(file: Path, tmp_dir: Path) -> Path:
    """The file itself when it already fits Instagram, else a 15 Mbps H.264/AAC copy in tmp_dir."""
    import subprocess
    if not needs_reencode(probe(file)):
        return file
    out = tmp_dir / (file.stem[:60] + ".ig.mp4")
    subprocess.run([find_tool("ffmpeg"), "-v", "error", "-y", "-i", str(file),
                    "-c:v", "libx264", "-preset", "medium", "-b:v", "15M", "-maxrate", "18M", "-bufsize", "30M",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out)],
                   check=True, capture_output=True)
    return out


def handle(api: Api, post: dict, uploader=upload_to_instagram, prepare=instagram_ready) -> str:
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
    import subprocess
    import tempfile
    try:
        with tempfile.TemporaryDirectory() as tmp:
            ready = prepare(path, Path(tmp)) if prepare else path
            uploader(start["upload_uri"], start["access_token"], ready)
            note = " (re-encoded to 15 Mbps for Instagram)" if ready != path else ""
    except (UploadError, urllib.error.URLError, TimeoutError, ConnectionError, OSError, subprocess.CalledProcessError) as e:
        api.fail(post["id"], str(e)[:400])
        return f"upload failed: {e}"
    return f"uploaded{note}, Instagram is processing it"


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
