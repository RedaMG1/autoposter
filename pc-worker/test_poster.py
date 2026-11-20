import poster


class FakeApi:
    def __init__(self, start=None, start_error=None):
        self.failed = []
        self.started = []
        self._start = start or {"upload_uri": "https://rupload/x", "access_token": "tok"}
        self._start_error = start_error

    def start_instagram(self, post_id):
        if self._start_error:
            raise RuntimeError(self._start_error)
        self.started.append(post_id)
        return self._start

    def fail(self, post_id, error, permanent=False):
        self.failed.append((post_id, error, permanent))


def post(path, platform="instagram"):
    return {"id": "p1", "platform": platform, "title": "T", "local_path": str(path)}


def test_uploads_an_existing_file(tmp_path):
    f = tmp_path / "clip.mp4"
    f.write_bytes(b"video")
    sent = []
    api = FakeApi()
    msg = poster.handle(api, post(f), uploader=lambda uri, tok, file: sent.append((uri, tok, file)), prepare=None)
    assert sent == [("https://rupload/x", "tok", f)]
    assert api.failed == [] and "processing" in msg


def test_missing_file_fails_permanently_without_starting(tmp_path):
    api = FakeApi()
    poster.handle(api, post(tmp_path / "gone.mp4"))
    assert api.started == []
    assert api.failed[0][2] is True and "file not found" in api.failed[0][1]


def test_upload_error_is_reported_for_retry(tmp_path):
    f = tmp_path / "clip.mp4"
    f.write_bytes(b"video")
    api = FakeApi()

    def boom(*_):
        raise poster.UploadError("Instagram upload refused (400)")
    poster.handle(api, post(f), uploader=boom, prepare=None)
    assert api.failed == [("p1", "Instagram upload refused (400)", False)]


def test_already_started_is_not_an_error(tmp_path):
    f = tmp_path / "clip.mp4"
    f.write_bytes(b"video")
    api = FakeApi(start_error="POST ... -> 409: already started")
    msg = poster.handle(api, post(f), uploader=lambda *_: (_ for _ in ()).throw(AssertionError("must not upload")), prepare=None)
    assert api.failed == [] and "not started" in msg


def test_other_platforms_are_left_to_the_app(tmp_path):
    api = FakeApi()
    assert "skipped" in poster.handle(api, post(tmp_path / "x.mp4", platform="tiktok"))
    assert api.started == [] and api.failed == []


def test_reencode_rule():
    assert not poster.needs_reencode({"bit_rate": 16_000_000, "video": "h264", "audio": "aac"})
    assert poster.needs_reencode({"bit_rate": 24_000_000, "video": "h264", "audio": "aac"})
    assert poster.needs_reencode({"bit_rate": 5_000_000, "video": "hevc", "audio": "aac"})
    assert not poster.needs_reencode({"bit_rate": 5_000_000, "video": "h264", "audio": None})


def test_high_bitrate_clip_gets_an_instagram_safe_copy(tmp_path):
    import subprocess
    src = tmp_path / "loud.mp4"
    # 2 s of noise at ~40 Mbps: well above Instagram's limit
    subprocess.run([poster.find_tool("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "nullsrc=s=1080x1920:r=30,geq=random(1)*255:128:128",
                    "-f", "lavfi", "-i", "sine", "-t", "2", "-c:v", "libx264", "-b:v", "40M", "-maxrate", "40M", "-bufsize", "40M",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", str(src)], check=True)
    assert poster.probe(src)["bit_rate"] > poster.MAX_BITRATE
    out = poster.instagram_ready(src, tmp_path)
    assert out != src and out.exists()
    info = poster.probe(out)
    assert info["video"] == "h264" and info["audio"] == "aac"
    assert info["bit_rate"] < 25_000_000


def test_normal_clip_is_uploaded_as_is(tmp_path):
    import subprocess
    src = tmp_path / "ok.mp4"
    subprocess.run([poster.find_tool("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "testsrc=s=1080x1920:r=30",
                    "-f", "lavfi", "-i", "sine", "-t", "2", "-c:v", "libx264", "-b:v", "5M", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", str(src)], check=True)
    assert poster.instagram_ready(src, tmp_path) == src
