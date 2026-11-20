"""Upload the finished clips in Desktop/clips/<Streamer>/ into the autoposter app.

Usage:  python import_existing.py [--clips DIR] [--api URL] [--only NAME_PART]

Reads each "<Streamer> - <moment> (GTA 6).mp4" and its "- post.md", makes a small preview,
and creates the clip as "to review". The video itself stays on this PC (poster.py uploads it
at posting time); --upload-videos stores it online instead (needs R2).
Safe to run again: clips are keyed by a stable id, so re-running updates them.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_CLIPS = Path.home() / "Desktop" / "clips"
SINGLE_UPLOAD_MAX = 90 * 1024 * 1024  # Cloudflare's request limit is 100 MB
USER_AGENT = "autoposter-pc/1.0"  # Cloudflare blocks the default "Python-urllib" agent (error 1010)
PART_SIZE = 50 * 1024 * 1024


def part_ranges(size: int, part: int = PART_SIZE) -> list[tuple[int, int]]:
    """(offset, length) of each part: all the same size except the last."""
    return [(o, min(part, size - o)) for o in range(0, size, part)]


def load_env() -> dict[str, str]:
    env = {}
    f = HERE / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return {**env, **{k: v for k, v in os.environ.items() if k.startswith("AUTOPOSTER_")}}


def clip_id(path: Path) -> str:
    """Stable id from the file name, so re-imports update instead of duplicating."""
    slug = re.sub(r"[^a-z0-9]+", "-", path.stem.lower()).strip("-")[:40]
    return f"{slug}-{hashlib.sha1(path.stem.encode()).hexdigest()[:6]}"


def section(text: str, name: str) -> str:
    m = re.search(rf"^## {re.escape(name)}\n(.*?)(?=^## |\Z)", text, re.S | re.M)
    return m.group(1).strip() if m else ""


def parse_post(md: str) -> dict:
    shorts = section(md, "YouTube Shorts")
    title = re.search(r"^Title: (.+)$", shorts, re.M)
    score = re.search(r"score ([0-9.]+)", md)
    hook = re.search(r"^Hook: (.+)$", md, re.M)
    vod = re.search(r"https://www\.twitch\.tv/videos/\d+", md)
    return {
        "title": title.group(1).strip() if title else md.splitlines()[0].lstrip("# ").strip(),
        "caption_tiktok": section(md, "TikTok"),
        "caption_instagram": section(md, "Instagram Reels"),
        "hook": hook.group(1).strip() if hook else "",
        "score": float(score.group(1)) if score else None,
        "source_vod": vod.group(0) if vod else "",
    }


def duration(mp4: Path) -> float | None:
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(mp4)],
                             capture_output=True, text=True, check=True).stdout
        return round(float(out), 2)
    except (subprocess.CalledProcessError, ValueError, FileNotFoundError):
        return None


def thumbnail(mp4: Path, out: Path) -> bool:
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "1.5", "-i", str(mp4), "-frames:v", "1",
                        "-vf", "scale=360:-2", "-q:v", "4", str(out)], capture_output=True)
    return r.returncode == 0 and out.exists()


class Api:
    def __init__(self, base: str, token: str):
        self.base, self.token = base.rstrip("/"), token

    def _send(self, method: str, path: str, data=None, headers=None) -> dict:
        h = {"authorization": f"Bearer {self.token}", "user-agent": USER_AGENT, **(headers or {})}
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"{method} {path} -> {e.code}: {e.read()[:300]!r}") from None

    def _retry(self, fn, attempts: int = 3):
        for n in range(1, attempts + 1):
            try:
                return fn()
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if n == attempts:
                    raise
                print(f"    retry {n}/{attempts - 1} after: {e}")
        raise AssertionError("unreachable")

    def upload(self, key: str, file: Path) -> dict:
        size = file.stat().st_size
        if size > SINGLE_UPLOAD_MAX:
            return self.upload_multipart(key, file, size)

        def once():
            with open(file, "rb") as fh:  # streamed, never loaded into memory
                return self._send("PUT", f"/api/worker/upload/{key}", data=fh, headers={"content-length": str(size)})
        return self._retry(once)

    def upload_multipart(self, key: str, file: Path, size: int) -> dict:
        """Cloudflare caps one request at 100 MB, so big videos go up in equal parts."""
        base = f"/api/worker/multipart/{key}"
        upload_id = self._send("POST", f"{base}?action=create")["uploadId"]
        q = urllib.parse.quote(upload_id, safe="")
        parts = []
        try:
            with open(file, "rb") as fh:
                for number, (offset, length) in enumerate(part_ranges(size), 1):
                    fh.seek(offset)
                    chunk = fh.read(length)
                    parts.append(self._retry(lambda: self._send(
                        "PUT", f"{base}?uploadId={q}&part={number}", data=chunk,
                        headers={"content-length": str(len(chunk))})))
            return self._send("POST", f"{base}?action=complete&uploadId={q}",
                              data=json.dumps({"parts": parts}).encode(), headers={"content-type": "application/json"})
        except Exception:
            try:
                self._send("POST", f"{base}?action=abort&uploadId={q}")
            except Exception:
                pass
            raise

    def put_thumb(self, clip_id: str, file: Path) -> dict:
        return self._send("PUT", f"/api/worker/thumb/{clip_id}", data=file.read_bytes(),
                          headers={"content-type": "image/jpeg"})

    def create_clip(self, clip: dict) -> dict:
        return self._send("POST", "/api/worker/clips", data=json.dumps(clip).encode(),
                          headers={"content-type": "application/json"})


def find_clips(root: Path) -> list[tuple[str, Path, Path]]:
    out = []
    for d in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith("_")):
        for mp4 in sorted(d.glob("*.mp4")):
            md = mp4.with_name(mp4.stem + " - post.md")
            if md.exists():
                out.append((d.name, mp4, md))
            else:
                print(f"  skip (no post.md): {mp4.name}")
    return out


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    env = load_env()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--clips", type=Path, default=DEFAULT_CLIPS)
    ap.add_argument("--api", default=env.get("AUTOPOSTER_API", "http://127.0.0.1:8787"))
    ap.add_argument("--only", default="", help="import only files whose name contains this text")
    ap.add_argument("--upload-videos", action="store_true",
                    help="also upload the videos to R2 (only if the app has R2 storage; default keeps them on this PC)")
    a = ap.parse_args(argv)
    token = env.get("AUTOPOSTER_WORKER_TOKEN", "")
    if not token:
        print("AUTOPOSTER_WORKER_TOKEN missing (pc-worker/.env)")
        return 2
    api = Api(a.api, token)
    clips = [c for c in find_clips(a.clips) if a.only.lower() in c[1].name.lower()]
    print(f"{len(clips)} clips in {a.clips} -> {a.api}")
    failed = 0
    with tempfile.TemporaryDirectory() as tmp:
        for i, (streamer, mp4, md) in enumerate(clips, 1):
            cid = clip_id(mp4)
            try:
                meta = parse_post(md.read_text(encoding="utf-8"))
                thumb = Path(tmp) / f"{cid}.jpg"
                has_thumb = thumbnail(mp4, thumb)
                record = {"id": cid, "streamer": streamer, **meta, "duration": duration(mp4),
                          "local_path": str(mp4.resolve())}
                if a.upload_videos:  # optional R2 mode
                    record["video_key"] = f"clips/{cid}/video.mp4"
                    api.upload(record["video_key"], mp4)
                api.create_clip(record)
                if has_thumb:
                    api.put_thumb(cid, thumb)
                where = "uploaded" if a.upload_videos else "video stays on this PC"
                print(f"  [{i}/{len(clips)}] {mp4.stem}  ({mp4.stat().st_size / 1e6:.0f} MB, {where})")
            except Exception as e:  # keep going, report at the end
                failed += 1
                print(f"  [{i}/{len(clips)}] FAILED {mp4.stem}: {e}")
    print(f"done: {len(clips) - failed} imported, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
