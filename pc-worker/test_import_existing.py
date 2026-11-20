from pathlib import Path

import import_existing as ie

POST = """# LIRIK demands a refund because GTA 6 won't let him get fatter

Hook: Rockstar, I was promised obesity
Moment: 2:53:40 - 2:54:33, score 8.0
Why: hits max body fat

## YouTube Shorts
Title: LIRIK demands a refund because GTA 6 won't let him get fatter

He ate everything 🍔

Full stream: https://www.twitch.tv/videos/2932444934

#GTA6 #LIRIK #Shorts

## TikTok
He ate everything 🍔 Stream: LIRIK #GTA6 #LIRIK

## Instagram Reels
He ate everything 🍔

Stream: LIRIK

#GTA6 #LIRIK

## X
He ate everything 🍔
"""


def test_parse_post_reads_every_field():
    p = ie.parse_post(POST)
    assert p["title"] == "LIRIK demands a refund because GTA 6 won't let him get fatter"
    assert p["caption_tiktok"] == "He ate everything 🍔 Stream: LIRIK #GTA6 #LIRIK"
    assert p["caption_instagram"] == "He ate everything 🍔\n\nStream: LIRIK\n\n#GTA6 #LIRIK"
    assert p["hook"] == "Rockstar, I was promised obesity"
    assert p["score"] == 8.0
    assert p["source_vod"] == "https://www.twitch.tv/videos/2932444934"


def test_parse_post_falls_back_to_heading():
    p = ie.parse_post("# Just a title\n\nnothing else")
    assert p["title"] == "Just a title"
    assert p["caption_tiktok"] == "" and p["score"] is None


def test_clip_id_is_stable_and_safe():
    a = ie.clip_id(Path("Lirik - Demands a refund because he can't get fatter (GTA 6).mp4"))
    b = ie.clip_id(Path("Lirik - Demands a refund because he can't get fatter (GTA 6).mp4"))
    assert a == b
    assert len(a) <= 64
    import re
    assert re.fullmatch(r"[a-z0-9-]+", a)


def test_find_clips_needs_post_md_and_skips_underscore_folders(tmp_path):
    (tmp_path / "Lirik").mkdir()
    (tmp_path / "_notes").mkdir()
    (tmp_path / "Lirik" / "Lirik - A (GTA 6).mp4").write_bytes(b"x")
    (tmp_path / "Lirik" / "Lirik - A (GTA 6) - post.md").write_text("# A")
    (tmp_path / "Lirik" / "Lirik - B (GTA 6).mp4").write_bytes(b"x")  # no post.md
    (tmp_path / "_notes" / "x.mp4").write_bytes(b"x")
    found = ie.find_clips(tmp_path)
    assert [(s, m.name) for s, m, _ in found] == [("Lirik", "Lirik - A (GTA 6).mp4")]
