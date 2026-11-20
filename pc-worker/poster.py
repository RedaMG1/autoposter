"""PC poster: uploads clips that are due, straight from this PC, at full quality.

Runs in the background. Every minute it asks the online app what is due and uploads those
videos from their file on this PC to Instagram, TikTok and YouTube; the app then marks them posted. If the PC was off at a posting time, the post goes out when it is back on.

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
    out = subprocess.run([find_tool("ffprobe"), "-v", "error", "-show_entries", "format=bit_rate:stream=codec_name,codec_type,r_frame_rate",
                          "-of", "json", str(file)], capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    streams = {s["codec_type"]: s["codec_name"] for s in data.get("streams", [])}
    rate = next((s.get("r_frame_rate") for s in data.get("streams", []) if s["codec_type"] == "video"), None)
    return {"bit_rate": int(data.get("format", {}).get("bit_rate") or 0), "video": streams.get("video"), "audio": streams.get("audio"),
            "fps": rate}


def steady_fps(rate: str | None) -> bool:
    """True for a normal constant frame rate (30/1, 60/1, 30000/1001...). Recorder output like 911891/15198 is not."""
    if not rate or "/" not in rate:
        return True
    num, den = (int(x) for x in rate.split("/"))
    return den in (1, 1001) and num > 0


def target_fps(rate: str | None) -> int:
    try:
        num, den = (int(x) for x in (rate or "60/1").split("/"))
        return 30 if num / den < 45 else 60
    except (ValueError, ZeroDivisionError):
        return 30


def needs_reencode(info: dict) -> bool:
    return (info["bit_rate"] > MAX_BITRATE or info["video"] != "h264" or info["audio"] not in ("aac", None)
            or not steady_fps(info.get("fps")))


def instagram_ready(file: Path, tmp_dir: Path) -> Path:
    """The file itself when it already fits Instagram, else a 15 Mbps H.264/AAC copy in tmp_dir."""
    import subprocess
    info = probe(file)
    if not needs_reencode(info):
        return file
    out = tmp_dir / (file.stem[:60] + ".ig.mp4")
    subprocess.run([find_tool("ffmpeg"), "-v", "error", "-y", "-i", str(file),
                    "-c:v", "libx264", "-preset", "medium", "-b:v", "15M", "-maxrate", "18M", "-bufsize", "30M",
                    "-pix_fmt", "yuv420p", "-r", str(target_fps(info.get("fps"))), "-fps_mode", "cfr",
                    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", str(out)],
                   check=True, capture_output=True)
    return out


def upload_to_youtube(upload_uri: str, access_token: str, file: Path, timeout: int = 1800) -> str:
    """PUT the whole file to the resumable session. Returns the YouTube video id."""
    size = file.stat().st_size
    with open(file, "rb") as fh:
        req = urllib.request.Request(upload_uri, data=fh, method="PUT", headers={
            "Authorization": f"Bearer {access_token}", "content-type": "video/mp4",
            "content-length": str(size), "user-agent": "autoposter-pc/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raise UploadError(f"YouTube upload refused ({e.code}): {e.read()[:300].decode(errors='replace')}") from None
    if not body.get("id"):
        raise UploadError(f"YouTube upload did not return a video id: {json.dumps(body)[:300]}")
    return body["id"]


def tiktok_chunks(size: int, chunk_size: int, count: int) -> list[tuple[int, int]]:
    """(first byte, last byte) of each chunk; the last chunk takes the remainder."""
    out = []
    for i in range(count):
        start = i * chunk_size
        end = size - 1 if i == count - 1 else start + chunk_size - 1
        out.append((start, end))
    return out


def upload_to_tiktok(upload_url: str, chunk_size: int, count: int, file: Path, timeout: int = 900) -> None:
    size = file.stat().st_size
    with open(file, "rb") as fh:
        for start, end in tiktok_chunks(size, chunk_size, count):
            fh.seek(start)
            data = fh.read(end - start + 1)
            req = urllib.request.Request(upload_url, data=data, method="PUT", headers={
                "content-type": "video/mp4", "content-length": str(len(data)),
                "content-range": f"bytes {start}-{end}/{size}", "user-agent": "autoposter-pc/1.0"})
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    r.read()
            except urllib.error.HTTPError as e:
                raise UploadError(f"TikTok upload refused ({e.code}): {e.read()[:300].decode(errors='replace')}") from None


def handle(api: Api, post: dict, uploader=upload_to_instagram, prepare=instagram_ready,
           yt_uploader=upload_to_youtube, tt_uploader=upload_to_tiktok) -> str:
    """Process one due post. Returns what happened, for the log."""
    import subprocess
    import tempfile
    platform = post["platform"]
    path = Path(post["local_path"])
    if not path.is_file():
        api.fail(post["id"], f"file not found: {path}", permanent=True)
        return f"file missing: {path}"
    try:
        with tempfile.TemporaryDirectory() as tmp:
            # Instagram has a bitrate limit; TikTok and YouTube take the original file
            ready = prepare(path, Path(tmp)) if (prepare and platform == "instagram") else path
            try:
                start = api.start(post["id"], ready.stat().st_size)
            except RuntimeError as e:
                # 409 = already started, 502 = the platform refused (already reported by the app)
                return f"not started: {e}"
            if start["kind"] == "instagram":
                uploader(start["upload_uri"], start["access_token"], ready)
                note = " (re-encoded to 15 Mbps)" if ready != path else ""
                return f"uploaded{note}, Instagram is processing it"
            if start["kind"] == "youtube":
                video_id = yt_uploader(start["upload_uri"], start["access_token"], ready)
                api.uploaded(post["id"], video_id)
                return f"posted on YouTube: https://youtube.com/shorts/{video_id}"
            tt_uploader(start["upload_url"], start["chunk_size"], start["total_chunk_count"], ready)
            private = " as private (TikTok app not audited yet)" if start.get("privacy") == "SELF_ONLY" else ""
            return f"uploaded{private}, TikTok is processing it"
    except (UploadError, urllib.error.URLError, TimeoutError, ConnectionError, OSError, subprocess.CalledProcessError) as e:
        api.fail(post["id"], str(e)[:400])
        return f"upload failed: {e}"


class PosterApi(Api):
    def due(self) -> list[dict]:
        return self._send("GET", "/api/worker/due")  # type: ignore[return-value]

    def start(self, post_id: str, file_size: int) -> dict:
        return self._send("POST", f"/api/worker/posts/{post_id}/start",
                          data=json.dumps({"file_size": file_size}).encode(), headers={"content-type": "application/json"})

    def uploaded(self, post_id: str, remote_id: str) -> None:
        self._send("POST", f"/api/worker/posts/{post_id}/uploaded",
                   data=json.dumps({"remote_id": remote_id}).encode(), headers={"content-type": "application/json"})

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
