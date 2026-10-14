# Pictures

A fast, dark photo gallery for high-definition pictures. Drop full-resolution
photos into `photos/`, push, and GitHub builds and publishes the site.

- **Justified gallery.** Photos sit in tidy rows at their true shape, never cropped to squares.
- **Fast at any size.** Each photo is resized to WebP versions from 480 to 3840 px wide, and
  every screen loads only the size it needs. A blurred placeholder shows while a photo loads.
- **Full-resolution viewer.** Open any photo full screen and zoom in with the wheel,
  a pinch or a double-click. Once the zoom outgrows the 3840 px version, the untouched
  original loads so you see every pixel.
- **Albums.** Each sub-folder of `photos/` becomes an album with its own filter.
- **Details.** Camera, lens, exposure and date are read from each photo's EXIF data.
- **Viewer controls.** Keyboard and touch navigation, swipe down to close, slideshow,
  full screen, share links to a single photo, and download of the original file.
- **Colour.** Colour profiles (such as Display P3 from iPhones) are kept in the resized copies.

## Adding photos

1. Put your pictures in `photos/`. JPEG, PNG, WebP, AVIF, TIFF and HEIC (iPhone) all work.
   Use sub-folders for albums. A number prefix sets the album order and isn't shown,
   so `photos/01-landscapes/` becomes the album "Landscapes":

   ```
   photos/
     01-landscapes/
       alpine_lake.jpg
       IMG_4821.jpg
     02-city/
       neon_crossing.jpg
     harbour-evening.jpg      <- photos outside a folder show only under "All"
   ```

2. Commit and push. The **Build and deploy gallery** workflow publishes the site in a minute or two.

Titles come from file names (`alpine_lake.jpg` becomes "Alpine lake"). Camera names like
`IMG_4821` or `PXL_20260710_101112` are left untitled. To set titles and captions yourself,
add `photos/captions.json`, keyed by the path inside `photos/`:

```json
{
  "harbour-evening.jpg": { "title": "Harbour at dusk", "caption": "Boats settling in as the light fades." },
  "01-landscapes/IMG_4821.jpg": { "title": "First light" }
}
```

Photos are sorted newest first by the date they were taken.

## Settings

Edit `gallery.config.json`:

| Setting         | What it does                                                                        |
| --------------- | ----------------------------------------------------------------------------------- |
| `title`         | Site name, shown large at the top and in the browser tab.                           |
| `subtitle`      | Line under the title, also used as the page description.                            |
| `author`        | Name shown in the footer copyright line.                                            |
| `cover`         | ID of the photo for the large header image (its file name in lowercase, with dashes, e.g. `harbour-evening`). Empty picks the newest landscape photo. |
| `sort`          | `date-desc` (newest first), `date-asc` or `name`.                                   |
| `sizes`         | Widths, in pixels, of the resized copies.                                           |
| `quality`       | WebP quality, 1 to 100.                                                             |
| `allowDownload` | `true` publishes the original files for full-resolution zoom and download. `false` keeps originals off the site, and zoom stops at the largest resized copy. |

## Turning on the website (one time)

1. In the repository on GitHub, open **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Push a commit, or run the workflow from the **Actions** tab. The site address appears
   in the workflow run and in Settings → Pages (`https://<user>.github.io/<repository>/`).

The workflow publishes from the repository's default branch only. GitHub Pages on a
private repository needs a paid GitHub plan; public repositories are free.

## Previewing on your computer

```sh
pip install -r requirements.txt
python3 scripts/build.py --serve
```

Then open http://localhost:8000. Rebuilds only process new or changed photos.

## Things to know

- **Location data.** With `allowDownload` on, originals are published exactly as they are,
  including any GPS location in their EXIF data. The build lists any photos that contain a
  location. To remove it, turn off location before sharing on your phone, or run
  `exiftool -gps:all= photo.jpg`. The resized copies never include EXIF data.
  If this repository is public, people can also download the originals from GitHub itself.
- **Size limits.** GitHub rejects files over 100 MB, and a Pages site should stay under about 1 GB
  in total, including originals. For a very large collection, set `allowDownload` to `false`
  to publish only the resized copies.
