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
    msg = poster.handle(api, post(f), uploader=lambda uri, tok, file: sent.append((uri, tok, file)))
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
    poster.handle(api, post(f), uploader=boom)
    assert api.failed == [("p1", "Instagram upload refused (400)", False)]


def test_already_started_is_not_an_error(tmp_path):
    f = tmp_path / "clip.mp4"
    f.write_bytes(b"video")
    api = FakeApi(start_error="POST ... -> 409: already started")
    msg = poster.handle(api, post(f), uploader=lambda *_: (_ for _ in ()).throw(AssertionError("must not upload")))
    assert api.failed == [] and "not started" in msg


def test_other_platforms_are_left_to_the_app(tmp_path):
    api = FakeApi()
    assert "skipped" in poster.handle(api, post(tmp_path / "x.mp4", platform="tiktok"))
    assert api.started == [] and api.failed == []
