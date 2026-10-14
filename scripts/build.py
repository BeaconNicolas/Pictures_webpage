#!/usr/bin/env python3
"""Build the gallery site into dist/.

Reads full-resolution photos from photos/ (each sub-folder becomes an album),
writes web-sized WebP copies plus a tiny blurred placeholder for each one,
collects the camera details from EXIF into dist/photos.json, and copies the
site and the untouched originals next to it. Photos that were already
processed are skipped, so rebuilding after adding a few pictures is quick.

    python3 scripts/build.py            # build into dist/
    python3 scripts/build.py --serve    # build, then preview on http://localhost:8000
"""

from __future__ import annotations

import argparse
import base64
import functools
import hashlib
import html
import http.server
import io
import json
import os
import re
import shutil
import sys
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

from PIL import ExifTags, Image, ImageCms, ImageOps

try:  # iPhone photos (.heic) need the optional pillow-heif plugin.
    from pillow_heif import register_heif_opener

    register_heif_opener()
    HEIF = True
except ImportError:
    HEIF = False

ROOT = Path(__file__).resolve().parent.parent

# Large panoramas are the point of the site, so don't treat them as decompression bombs.
Image.MAX_IMAGE_PIXELS = None

TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
}
if HEIF:
    TYPES |= {".heic": "image/heic", ".heif": "image/heif"}

# Formats every current browser can display, so the original can back the deep zoom.
VIEWABLE = {"image/jpeg", "image/png", "image/webp", "image/avif"}

WEBP_MAX = 16383  # WebP can't encode a side longer than this.

DEFAULTS = {
    "title": "Pictures",
    "subtitle": "Photographs in high definition",
    "description": "",
    "author": "",
    "cover": "",
    "sort": "date-desc",
    "sizes": [480, 960, 1600, 2560, 3840],
    "quality": 82,
    "allowDownload": True,
}

# Camera-style file names like IMG_1234, DSC01234 or PXL_20240501_123456 make poor titles.
CAMERA_NAME = re.compile(
    r"^(img|image|dsc[a-z]?|pxl|dji|gopr|mvimg|photo|p|_mg|sam|wp|screenshot)?[\s_-]*\d[\d\s_.()-]*(~\d+)?$",
    re.IGNORECASE,
)


def load_config(path: Path) -> dict:
    config = dict(DEFAULTS)
    if path.exists():
        config |= json.loads(path.read_text(encoding="utf-8"))
    config["description"] = config["description"] or config["subtitle"]
    return config


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "photo"


def humanize(name: str) -> str:
    """Turn a file or folder name into a title; '02-summer_in_rome' -> 'Summer in rome'."""
    name = re.sub(r"^\d+[\s._-]+(?=\D)", "", name)
    name = re.sub(r"[_-]+", " ", name).strip()
    return name[:1].upper() + name[1:]


def title_from_filename(stem: str) -> str:
    return "" if CAMERA_NAME.match(stem.strip()) else humanize(stem)


def clean(value) -> str:
    if isinstance(value, bytes):
        value = value.decode("utf-8", "ignore")
    return str(value).replace("\x00", "").strip() if value is not None else ""


def number(value) -> float | None:
    try:
        if isinstance(value, tuple):
            value = value[0]
        result = float(value)
    except (TypeError, ValueError, ZeroDivisionError, IndexError):
        return None
    return result if result > 0 else None


def read_exif(exif: Image.Exif) -> dict:
    ifd = exif.get_ifd(ExifTags.IFD.Exif)
    tags = ExifTags.Base
    details = {}

    make, model = clean(exif.get(tags.Make)), clean(exif.get(tags.Model))
    if model and make and make.split()[0].lower() in model.lower():
        details["camera"] = model
    elif make or model:
        details["camera"] = f"{make} {model}".strip()

    if lens := clean(ifd.get(tags.LensModel)):
        details["lens"] = lens
    if focal := number(ifd.get(tags.FocalLength)):
        details["focal"] = f"{round(focal, 1):g} mm"
    if aperture := number(ifd.get(tags.FNumber)):
        details["aperture"] = f"ƒ/{round(aperture, 1):g}"
    if exposure := number(ifd.get(tags.ExposureTime)):
        details["shutter"] = f"1/{round(1 / exposure)} s" if exposure < 0.5 else f"{round(exposure, 1):g} s"
    if iso := number(ifd.get(tags.ISOSpeedRatings)):
        details["iso"] = f"ISO {iso:g}"

    taken = clean(ifd.get(tags.DateTimeOriginal) or exif.get(tags.DateTime))
    if match := re.match(r"(\d{4}):(\d\d):(\d\d)[ T](\d\d):(\d\d):(\d\d)", taken):
        year, month, day, hour, minute, second = match.groups()
        if year != "0000":
            details["taken"] = f"{year}-{month}-{day}T{hour}:{minute}:{second}"
    return details


def to_rgb(image: Image.Image, icc: bytes | None) -> tuple[Image.Image, bytes | None]:
    """Convert to RGB(A), keeping the colour profile only when it still describes the pixels."""
    if image.mode in ("RGB", "RGBA"):
        return image, icc
    if image.mode == "CMYK" and icc:
        source = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        return ImageCms.profileToProfile(image, source, ImageCms.createProfile("sRGB"), outputMode="RGB"), None
    alpha = image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info
    keep_icc = image.mode == "P"  # A palette image's profile is an RGB one.
    return image.convert("RGBA" if alpha else "RGB"), icc if keep_icc else None


def plan_widths(width: int, height: int, sizes: list[int], full: bool) -> list[int]:
    largest = int(width * min(1.0, WEBP_MAX / width, WEBP_MAX / height))
    widths = {size for size in sizes if size < largest}
    if full or largest <= max(sizes):
        widths.add(largest)
    return sorted(widths)


def render(source: Path, digest: str, mime: str, out: Path, config: dict) -> dict:
    """Decode one photo and write its WebP sizes; returns everything the manifest needs."""
    with Image.open(source) as opened:
        exif = opened.getexif()
        icc = opened.info.get("icc_profile")
        image, icc = to_rgb(ImageOps.exif_transpose(opened), icc)

    width, height = image.size
    # Without a browser-friendly original, a full-size WebP takes its place for zooming in.
    full = config["allowDownload"] and mime not in VIEWABLE
    widths = plan_widths(width, height, config["sizes"], full)

    options = {"quality": config["quality"], "method": 5}
    if icc:
        options["icc_profile"] = icc
    resized = image
    for w in reversed(widths):  # Largest first, each step resizing the previous one.
        size = (w, max(1, round(height * w / width)))
        if resized.size != size:
            resized = resized.resize(size, Image.LANCZOS, reducing_gap=3.0)
        target = out / "img" / f"{digest}-{w}.webp"
        if not target.exists():
            resized.save(target, "WEBP", **options)

    long_edge = 32
    tiny = resized.resize(
        (long_edge, max(1, round(long_edge * height / width)))
        if width >= height
        else (max(1, round(long_edge * width / height)), long_edge),
        Image.LANCZOS,
    )
    buffer = io.BytesIO()
    tiny.save(buffer, "WEBP", quality=50)
    red, green, blue = tiny.convert("RGB").resize((1, 1), Image.BOX).getpixel((0, 0))

    return {
        "width": width,
        "height": height,
        "widths": widths,
        "color": f"#{red:02x}{green:02x}{blue:02x}",
        "lqip": "data:image/webp;base64," + base64.b64encode(buffer.getvalue()).decode(),
        "exif": read_exif(exif),
        "gps": bool(exif.get_ifd(ExifTags.IFD.GPSInfo)),
    }


def digest_of(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            sha.update(chunk)
    return sha.hexdigest()[:16]


def find_photos(photos: Path) -> list[Path]:
    if not photos.is_dir():
        return []
    return sorted(
        path
        for path in photos.rglob("*")
        if path.is_file()
        and path.suffix.lower() in TYPES
        and not any(part.startswith(".") for part in path.relative_to(photos).parts)
    )


def build(photos_dir: Path, out: Path, config: dict) -> None:
    site = ROOT / "site"
    cache_path = ROOT / ".cache" / "photos.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    captions_path = photos_dir / "captions.json"
    captions = json.loads(captions_path.read_text(encoding="utf-8")) if captions_path.exists() else {}

    (out / "img").mkdir(parents=True, exist_ok=True)
    (out / "original").mkdir(parents=True, exist_ok=True)

    # Settings that change the generated files are part of the cache key.
    settings = hashlib.sha256(
        json.dumps([config["sizes"], config["quality"], config["allowDownload"]]).encode()
    ).hexdigest()[:8]

    sources = find_photos(photos_dir)
    if not HEIF and any(p.suffix.lower() in (".heic", ".heif") for p in photos_dir.rglob("*")):
        print("! .heic photos skipped: install pillow-heif (pip install -r requirements.txt)")

    def process(source: Path) -> tuple[Path, str, dict, bool]:
        digest = digest_of(source)
        mime = TYPES[source.suffix.lower()]
        key = f"{digest}-{settings}"
        meta = cache.get(key)
        fresh = meta is None or not all((out / "img" / f"{digest}-{w}.webp").exists() for w in meta["widths"])
        if fresh:
            meta = render(source, digest, mime, out, config)
        if config["allowDownload"]:
            original = out / "original" / digest / source.name
            if not original.exists():
                original.parent.mkdir(exist_ok=True)
                shutil.copy2(source, original)
        return source, key, meta, fresh

    workers = min(4, os.cpu_count() or 1)
    with ThreadPoolExecutor(workers) as pool:
        results = list(pool.map(process, sources))

    photos, used_ids, located = [], set(), []
    album_names: dict[str, str] = {}
    new_cache = {}
    for source, key, meta, fresh in results:
        new_cache[key] = meta
        rel = source.relative_to(photos_dir)
        digest = key.split("-")[0]
        mime = TYPES[source.suffix.lower()]
        if fresh:
            print(f"  + {rel.as_posix()}  ({meta['width']} × {meta['height']})")
        if meta["gps"]:
            located.append(rel.as_posix())

        album = None
        if len(rel.parts) > 1:
            album = slugify(humanize(rel.parts[0]))
            album_names.setdefault(album, humanize(rel.parts[0]))

        photo_id = slugify(rel.stem)
        if photo_id in used_ids and album:
            photo_id = f"{album}-{photo_id}"
        base, n = photo_id, 2
        while photo_id in used_ids:
            photo_id, n = f"{base}-{n}", n + 1
        used_ids.add(photo_id)

        text = captions.get(rel.as_posix(), {})
        if isinstance(text, str):
            text = {"caption": text}
        original = None
        if config["allowDownload"]:
            original = {
                "url": f"original/{digest}/{quote(source.name)}",
                "name": source.name,
                "size": source.stat().st_size,
                "viewable": mime in VIEWABLE,
            }
        photos.append(
            {
                "id": photo_id,
                "title": text.get("title", title_from_filename(rel.stem)),
                "caption": text.get("caption", ""),
                "album": album,
                "width": meta["width"],
                "height": meta["height"],
                "color": meta["color"],
                "lqip": meta["lqip"],
                "sources": [[w, f"img/{digest}-{w}.webp"] for w in meta["widths"]],
                "original": original,
                "exif": meta["exif"],
                "path": rel.as_posix(),
            }
        )

    if config["sort"] == "name":
        photos.sort(key=lambda p: p["path"])
    else:
        newest = config["sort"] != "date-asc"
        dated = sorted((p for p in photos if p["exif"].get("taken")), key=lambda p: (p["exif"]["taken"], p["path"]))
        if newest:
            dated.reverse()
        photos = dated + [p for p in photos if not p["exif"].get("taken")]
    for photo in photos:
        del photo["path"]

    albums = [
        {"id": album, "name": album_names[album], "count": sum(p["album"] == album for p in photos)}
        for album in sorted(album_names)
    ]

    # Drop generated files that no longer belong to any photo.
    keep_img = {url.split("/")[-1] for p in photos for _, url in p["sources"]}
    for path in (out / "img").iterdir():
        if path.name not in keep_img:
            path.unlink()
    keep_original = {p["original"]["url"].split("/")[1] for p in photos if p["original"]}
    for path in (out / "original").iterdir():
        if path.name not in keep_original:
            shutil.rmtree(path)

    # Copy the site, filling the page's placeholders from the config.
    for path in site.rglob("*"):
        if path.is_file() and path.name != "index.html":
            target = out / path.relative_to(site)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
    version = hashlib.sha256(
        b"".join(p.read_bytes() for p in sorted((site / "assets").rglob("*")) if p.is_file())
    ).hexdigest()[:10]
    page = (site / "index.html").read_text(encoding="utf-8")
    for name in ("title", "subtitle", "description"):
        page = page.replace("{{" + name + "}}", html.escape(str(config[name])))
    (out / "index.html").write_text(page.replace("{{version}}", version), encoding="utf-8")

    site_info = {k: config[k] for k in ("title", "subtitle", "author", "cover", "allowDownload")}
    manifest = {"site": site_info, "albums": albums, "photos": photos}
    (out / "photos.json").write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out / ".nojekyll").touch()

    cache_path.parent.mkdir(exist_ok=True)
    cache_path.write_text(json.dumps(new_cache))

    processed = sum(1 for *_, fresh in results if fresh)
    print(f"Built {len(photos)} photos ({processed} new) in {len(albums)} albums -> {out}")
    if located and config["allowDownload"]:
        print(f"! {len(located)} original(s) contain GPS location, which visitors can read after downloading:")
        for path in located:
            print(f"    {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--photos", type=Path, default=ROOT / "photos", help="folder of original photos")
    parser.add_argument("--out", type=Path, default=ROOT / "dist", help="output folder")
    parser.add_argument("--config", type=Path, default=ROOT / "gallery.config.json")
    parser.add_argument("--serve", action="store_true", help="preview the site after building")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    build(args.photos.resolve(), args.out.resolve(), load_config(args.config))

    if args.serve:
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(args.out))
        with http.server.ThreadingHTTPServer(("", args.port), handler) as server:
            print(f"Previewing on http://localhost:{args.port}  (Ctrl+C to stop)")
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass


if __name__ == "__main__":
    sys.exit(main())
