import poster


class FakeApi:
    def __init__(self, start=None, start_error=None):
        self.failed = []
        self.started = []
        self.uploaded_ids = []
        self._start = start or {"kind": "instagram", "upload_uri": "https://rupload/x", "access_token": "tok"}
        self._start_error = start_error

    def start(self, post_id, file_size):
        if self._start_error:
            raise RuntimeError(self._start_error)
        self.started.append((post_id, file_size))
        return self._start

    def uploaded(self, post_id, remote_id):
        self.uploaded_ids.append((post_id, remote_id))

    def fail(self, post_id, error, permanent=False):
        self.failed.append((post_id, error, permanent))


def post(path, platform="instagram"):
    return {"id": "p1", "platform": platform, "title": "T", "local_path": str(path)}


def clip(tmp_path, data=b"video"):
    f = tmp_path / "clip.mp4"
    f.write_bytes(data)
    return f


def test_instagram_upload(tmp_path):
    f = clip(tmp_path)
    sent = []
    api = FakeApi()
    msg = poster.handle(api, post(f), uploader=lambda uri, tok, file: sent.append((uri, tok, file)), prepare=None)
    assert sent == [("https://rupload/x", "tok", f)]
    assert api.started == [("p1", 5)]
    assert api.failed == [] and "Instagram is processing" in msg


def test_youtube_upload_reports_the_video_id(tmp_path):
    f = clip(tmp_path)
    api = FakeApi(start={"kind": "youtube", "upload_uri": "https://up/yt", "access_token": "ya29"})
    msg = poster.handle(api, post(f, "youtube"), yt_uploader=lambda uri, tok, file: "vid123", prepare=None)
    assert api.uploaded_ids == [("p1", "vid123")]
    assert "youtube.com/shorts/vid123" in msg


def test_tiktok_upload_sends_chunks(tmp_path):
    f = clip(tmp_path)
    got = []
    api = FakeApi(start={"kind": "tiktok", "upload_url": "https://up/tt", "chunk_size": 5, "total_chunk_count": 1, "privacy": "SELF_ONLY"})
    msg = poster.handle(api, post(f, "tiktok"), tt_uploader=lambda url, cs, n, file: got.append((url, cs, n, file)), prepare=None)
    assert got == [("https://up/tt", 5, 1, f)]
    assert "private" in msg


def test_only_instagram_is_re_encoded(tmp_path):
    f = clip(tmp_path)
    prepared = []

    def prep(path, tmp):
        prepared.append(path)
        return path
    api = FakeApi(start={"kind": "youtube", "upload_uri": "u", "access_token": "t"})
    poster.handle(api, post(f, "youtube"), prepare=prep, yt_uploader=lambda *_: "v1")
    assert prepared == []


def test_tiktok_chunk_ranges_cover_the_file():
    mb = 1024 * 1024
    r = poster.tiktok_chunks(156 * mb, 10 * mb, 15)
    assert r[0] == (0, 10 * mb - 1)
    assert r[-1] == (140 * mb, 156 * mb - 1)
    assert sum(e - s + 1 for s, e in r) == 156 * mb
    assert poster.tiktok_chunks(100, 100, 1) == [(0, 99)]


def test_missing_file_fails_permanently_without_starting(tmp_path):
    api = FakeApi()
    poster.handle(api, post(tmp_path / "gone.mp4"))
    assert api.started == []
    assert api.failed[0][2] is True and "file not found" in api.failed[0][1]


def test_upload_error_is_reported_for_retry(tmp_path):
    f = clip(tmp_path)
    api = FakeApi()

    def boom(*_):
        raise poster.UploadError("Instagram upload refused (400)")
    poster.handle(api, post(f), uploader=boom, prepare=None)
    assert api.failed == [("p1", "Instagram upload refused (400)", False)]


def test_already_started_is_not_an_error(tmp_path):
    f = clip(tmp_path)
    api = FakeApi(start_error="POST ... -> 409: already started")
    msg = poster.handle(api, post(f), uploader=lambda *_: (_ for _ in ()).throw(AssertionError("must not upload")), prepare=None)
    assert api.failed == [] and "not started" in msg


def test_reencode_rule():
    assert not poster.needs_reencode({"bit_rate": 16_000_000, "video": "h264", "audio": "aac"})
    assert poster.needs_reencode({"bit_rate": 24_000_000, "video": "h264", "audio": "aac"})
    assert poster.needs_reencode({"bit_rate": 5_000_000, "video": "hevc", "audio": "aac"})
    assert not poster.needs_reencode({"bit_rate": 5_000_000, "video": "h264", "audio": None})


def test_high_bitrate_clip_gets_an_instagram_safe_copy(tmp_path):
    import subprocess
    src = tmp_path / "loud.mp4"
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
