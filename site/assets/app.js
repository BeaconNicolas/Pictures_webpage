(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const gallery = $("gallery");
  const viewerEl = $("viewer");
  const stage = $("stage");
  const viewImg = $("viewer-img");
  const infoEl = $("info");

  const coarsePointer = matchMedia("(pointer: coarse)");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  // Phones can run out of memory decoding huge originals, so they stop at this size.
  const MOBILE_MAX_PIXELS = 50e6;
  const SLIDESHOW_MS = 5000;

  let site = {};
  let photos = [];
  let albums = [];
  const byId = new Map();
  const tiles = new Map();
  let visible = [];
  let album = null;

  /* ---------- Helpers ---------- */

  const dpr = () => window.devicePixelRatio || 1;

  function pickSource(photo, cssWidth) {
    const need = cssWidth * dpr();
    const found = photo.sources.find(([w]) => w >= need * 0.95);
    const [w, url] = found || photo.sources[photo.sources.length - 1];
    return { w, url };
  }

  const srcset = (photo) => photo.sources.map(([w, url]) => `${url} ${w}w`).join(", ");

  const formatBytes = (n) =>
    n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

  function formatDate(iso, style = "long") {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, style === "long" ? { dateStyle: "long", timeStyle: "short" } : { dateStyle: "medium" }).format(date);
  }

  const settings = (exif) => [exif.focal, exif.aperture, exif.shutter, exif.iso].filter(Boolean).join("  ·  ");

  const label = (photo) => photo.title || photo.caption || `Photo ${photos.indexOf(photo) + 1}`;

  function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  let toastTimer;
  function toast(message) {
    const node = $("toast");
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("show"), 2200);
  }

  /* ---------- Start ---------- */

  init();

  async function init() {
    try {
      const response = await fetch("photos.json");
      if (!response.ok) throw new Error(response.statusText);
      ({ site, photos, albums } = await response.json());
    } catch (error) {
      $("empty").hidden = false;
      $("empty").querySelector("p").textContent = "The photo list couldn't be loaded. Run the build first (python3 scripts/build.py).";
      return;
    }

    photos.forEach((photo) => byId.set(photo.id, photo));
    renderMeta();
    renderHero();
    renderAlbums();
    renderTiles();
    $("empty").hidden = photos.length > 0;

    route();
    window.addEventListener("hashchange", route);
    window.addEventListener("popstate", route);
    let lastWidth = 0;
    new ResizeObserver(() => {
      if (gallery.clientWidth !== lastWidth) {
        lastWidth = gallery.clientWidth;
        layout();
      }
    }).observe(gallery);
    document.addEventListener("click", onLinkClick);
  }

  function renderMeta() {
    const parts = [`${photos.length} ${photos.length === 1 ? "photograph" : "photographs"}`];
    if (albums.length) parts.push(`${albums.length} ${albums.length === 1 ? "album" : "albums"}`);
    $("site-meta").textContent = photos.length ? parts.join("  ·  ") : "";
    const year = new Date().getFullYear();
    $("footer").textContent = site.author ? `© ${year} ${site.author}` : `© ${year}`;
  }

  function renderHero() {
    const cover = byId.get(site.cover) || photos.find((p) => p.width >= p.height * 1.2) || photos[0];
    if (!cover) return;
    const hero = $("hero");
    const img = $("hero-img");
    hero.hidden = false;
    hero.href = `#/photo/${encodeURIComponent(cover.id)}`;
    hero.dataset.photo = cover.id;
    hero.setAttribute("aria-label", `Open ${label(cover)}`);
    hero.style.backgroundImage = `url("${cover.lqip}")`;
    hero.style.backgroundColor = cover.color;
    img.sizes = "100vw";
    img.srcset = srcset(cover);
    img.alt = cover.title || "";
    const done = () => img.classList.add("loaded");
    img.complete && img.naturalWidth ? done() : img.addEventListener("load", done, { once: true });
    $("masthead").classList.add("has-hero");
  }

  function renderAlbums() {
    if (!albums.length) return;
    const nav = $("albums");
    const chip = (id, name, count) => {
      const button = el("button", { type: "button", className: "chip" }, [name, el("span", { className: "chip-count", textContent: count })]);
      button.dataset.album = id || "";
      button.addEventListener("click", () => {
        const hash = id ? `#/album/${encodeURIComponent(id)}` : "";
        if (hash !== location.hash) {
          history.pushState(null, "", hash || location.pathname + location.search);
          route();
        }
        const top = gallery.getBoundingClientRect().top + scrollY - nav.offsetHeight - 8;
        if (scrollY > top) scrollTo({ top, behavior: reducedMotion.matches ? "auto" : "smooth" });
      });
      return button;
    };
    nav.append(chip(null, "All", photos.length), ...albums.map((a) => chip(a.id, a.name, a.count)));
    nav.hidden = false;
  }

  function renderTiles() {
    const fragment = document.createDocumentFragment();
    for (const photo of photos) {
      const tile = el("a", { className: "tile", href: `#/photo/${encodeURIComponent(photo.id)}` });
      tile.dataset.photo = photo.id;
      tile.style.backgroundColor = photo.color;
      tile.style.backgroundImage = `url("${photo.lqip}")`;
      tile.setAttribute("aria-label", label(photo));

      const img = el("img", { alt: photo.title || photo.caption || "", loading: "lazy", decoding: "async" });
      img.sizes = "320px";
      img.srcset = srcset(photo);
      const done = () => tile.classList.add("loaded");
      img.addEventListener("load", done, { once: true });
      tile.append(img);
      if (photo.title) tile.append(el("span", { className: "tile-caption", textContent: photo.title }));

      tiles.set(photo.id, tile);
      fragment.append(tile);
    }
    gallery.append(fragment);
  }

  /* ---------- Justified layout ---------- */

  function layout() {
    const width = gallery.clientWidth;
    if (!width) return;
    const gap = width < 640 ? 4 : 8;
    const target = width < 640 ? 170 : width < 1200 ? 250 : 320;
    let y = 0;

    const place = (row, sum, fill) => {
      const avail = width - gap * (row.length - 1);
      const height = Math.round(fill ? avail / sum : Math.min(target, avail / sum));
      let x = 0;
      row.forEach((photo, i) => {
        const w = fill && i === row.length - 1 ? width - x : Math.round((photo.width / photo.height) * height);
        const tile = tiles.get(photo.id);
        tile.style.transform = `translate(${x}px, ${y}px)`;
        tile.style.width = `${w}px`;
        tile.style.height = `${height}px`;
        tile.firstChild.sizes = `${w}px`;
        x += w + gap;
      });
      y += height + gap;
    };

    let row = [];
    let sum = 0;
    for (const photo of visible) {
      const ratio = photo.width / photo.height;
      if (row.length) {
        const withIt = (width - gap * row.length) / (sum + ratio);
        if (withIt < target) {
          // The row is full: end it either before or after this photo, whichever height is nearer the target.
          const without = (width - gap * (row.length - 1)) / sum;
          if (Math.abs(Math.log(without / target)) < Math.abs(Math.log(withIt / target))) {
            place(row, sum, true);
            row = [photo];
            sum = ratio;
          } else {
            place([...row, photo], sum + ratio, true);
            row = [];
            sum = 0;
          }
          continue;
        }
      }
      row.push(photo);
      sum += ratio;
    }
    if (row.length) place(row, sum, false);
    gallery.style.height = `${Math.max(0, y - gap)}px`;
  }

  function setAlbum(id) {
    id = albums.some((a) => a.id === id) ? id : null;
    const changed = id !== album || !visible.length;
    album = id;
    visible = photos.filter((p) => !album || p.album === album);
    if (!changed) return;
    for (const photo of photos) tiles.get(photo.id).hidden = Boolean(album && photo.album !== album);
    document.querySelectorAll(".chip").forEach((chip) => chip.setAttribute("aria-pressed", String(chip.dataset.album === (album || ""))));
    if (gallery.clientWidth && !reducedMotion.matches && gallery.style.height) {
      gallery.classList.add("animate");
      setTimeout(() => gallery.classList.remove("animate"), 550);
    }
    layout();
  }

  /* ---------- Routing ---------- */

  function onLinkClick(event) {
    const link = event.target.closest("a[data-photo]");
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.pushState({ viewer: true }, "", link.getAttribute("href"));
    route();
  }

  function route() {
    const match = location.hash.match(/^#\/(photo|album)\/(.+)$/);
    const id = match ? decodeURIComponent(match[2]) : null;
    if (match && match[1] === "photo" && byId.has(id)) {
      const photo = byId.get(id);
      if (!visible.includes(photo)) setAlbum(null);
      openViewer(photo);
      return;
    }
    if (viewer.photo) closeViewer({ fromHistory: true });
    setAlbum(match && match[1] === "album" ? id : null);
  }

  /* ---------- Viewer ---------- */

  const viewer = {
    photo: null,
    index: -1,
    fit: 1, // Scale that fits the whole photo in the stage.
    z: 1, // Zoom relative to fit.
    x: 0,
    y: 0,
    shownWidth: 0, // Pixel width of the file currently on screen.
    token: 0,
    returnFocus: null,
    playing: false,
    playTimer: 0,
  };

  const stageSize = () => ({ w: stage.clientWidth, h: stage.clientHeight });

  function computeFit() {
    const { w, h } = stageSize();
    const photo = viewer.photo;
    viewer.fit = Math.min(w / photo.width, h / photo.height, 1);
  }

  // Zoom at which one photo pixel covers one screen pixel.
  const actualZoom = () => 1 / (viewer.fit * dpr());
  const maxZoom = () => Math.max(2, actualZoom() * 2);

  function clampPosition() {
    const { w, h } = stageSize();
    const width = viewer.photo.width * viewer.fit * viewer.z;
    const height = viewer.photo.height * viewer.fit * viewer.z;
    viewer.x = width <= w ? (w - width) / 2 : Math.min(0, Math.max(w - width, viewer.x));
    viewer.y = height <= h ? (h - height) / 2 : Math.min(0, Math.max(h - height, viewer.y));
  }

  function apply({ animate = false, clamp = true } = {}) {
    if (clamp) clampPosition();
    const scale = viewer.fit * viewer.z;
    if (animate && !reducedMotion.matches) {
      viewerEl.classList.add("animating");
      clearTimeout(apply.timer);
      apply.timer = setTimeout(() => viewerEl.classList.remove("animating"), 320);
    }
    viewImg.style.width = `${viewer.photo.width * scale}px`;
    viewImg.style.height = `${viewer.photo.height * scale}px`;
    viewImg.style.transform = `translate3d(${viewer.x}px, ${viewer.y}px, 0)`;
    const zoomed = viewer.z > 1.01;
    viewerEl.classList.toggle("zoomed", zoomed);
    const zoomButton = $("btn-zoom");
    zoomButton.querySelector("use").setAttribute("href", zoomed ? "#i-zoom-out" : "#i-zoom-in");
    zoomButton.setAttribute("aria-label", zoomed ? "Zoom out" : "Zoom to actual pixels");
    scheduleResolution();
  }

  function zoomAt(z, cx, cy, animate = false) {
    z = Math.min(maxZoom(), Math.max(1, z));
    const ratio = z / viewer.z;
    viewer.x = cx - (cx - viewer.x) * ratio;
    viewer.y = cy - (cy - viewer.y) * ratio;
    viewer.z = z;
    apply({ animate });
  }

  function toggleZoom(cx, cy) {
    stopSlideshow();
    const { w, h } = stageSize();
    if (cx === undefined) [cx, cy] = [w / 2, h / 2];
    if (viewer.z > 1.01) zoomAt(1, cx, cy, true);
    else zoomAt(Math.max(actualZoom(), 2), cx, cy, true);
  }

  // Load a sharper file once the photo is shown larger than the current one can cover.
  function scheduleResolution() {
    clearTimeout(scheduleResolution.timer);
    scheduleResolution.timer = setTimeout(upgradeResolution, 120);
  }

  function bestFile(photo, cssWidth) {
    const need = cssWidth * dpr();
    const largest = photo.sources[photo.sources.length - 1];
    const original = photo.original;
    const pixels = photo.width * photo.height;
    if (
      need > largest[0] * 1.05 &&
      original?.viewable &&
      !(coarsePointer.matches && pixels > MOBILE_MAX_PIXELS)
    ) {
      return { url: original.url, w: photo.width, original: true };
    }
    return pickSource(photo, cssWidth);
  }

  async function upgradeResolution() {
    const photo = viewer.photo;
    if (!photo) return;
    const file = bestFile(photo, photo.width * viewer.fit * viewer.z);
    if (file.w <= viewer.shownWidth) return;
    const token = viewer.token;
    if (upgradeResolution.pending === file.url) return;
    upgradeResolution.pending = file.url;
    if (file.original) showBadge(`Loading full resolution  ·  ${formatBytes(photo.original.size)}`);
    viewerEl.classList.toggle("loading", viewImg.classList.contains("preview") || file.original);
    try {
      const loader = new Image();
      loader.src = file.url;
      await loader.decode();
      if (token !== viewer.token || file.w <= viewer.shownWidth) return;
      viewImg.src = file.url;
      viewer.shownWidth = file.w;
      viewImg.classList.remove("preview");
      if (file.original) showBadge(`Full resolution  ·  ${photo.width} × ${photo.height}`, 1800);
      if (viewer.playing) queueNextSlide();
      preloadNeighbours();
    } catch {
      if (token === viewer.token && file.original) showBadge("Couldn't load the full-resolution file", 2500);
    } finally {
      if (upgradeResolution.pending === file.url) upgradeResolution.pending = null;
      if (token === viewer.token) viewerEl.classList.remove("loading");
    }
  }

  let badgeTimer;
  function showBadge(text, hideAfter) {
    const badge = $("badge");
    badge.textContent = text;
    badge.classList.add("show");
    clearTimeout(badgeTimer);
    if (hideAfter) badgeTimer = setTimeout(() => badge.classList.remove("show"), hideAfter);
  }

  function hideBadge() {
    clearTimeout(badgeTimer);
    $("badge").classList.remove("show");
  }

  function preloadNeighbours() {
    const { w, h } = stageSize();
    for (const offset of [1, -1]) {
      const photo = visible[viewer.index + offset];
      if (!photo) continue;
      const fit = Math.min(w / photo.width, h / photo.height, 1);
      new Image().src = pickSource(photo, photo.width * fit).url;
    }
  }

  function openViewer(photo) {
    const opening = !viewer.photo;
    if (opening) {
      viewer.returnFocus = document.activeElement;
      viewerEl.hidden = false;
      document.documentElement.classList.add("viewer-open");
      document.addEventListener("keydown", onKey);
      wakeChrome();
    }
    showPhoto(photo);
    if (opening) $("btn-close").focus({ preventScroll: true });
  }

  function showPhoto(photo) {
    viewer.photo = photo;
    viewer.index = visible.indexOf(photo);
    viewer.token++;
    viewer.z = 1;
    upgradeResolution.pending = null;
    hideBadge();
    computeFit();

    // Show the gallery thumbnail (or the blurred placeholder) straight away, then sharpen.
    const thumb = tiles.get(photo.id)?.firstChild;
    if (thumb?.complete && thumb.naturalWidth) {
      viewImg.src = thumb.currentSrc;
      viewer.shownWidth = thumb.naturalWidth;
      viewImg.classList.toggle("preview", thumb.naturalWidth < photo.width * viewer.fit * dpr() * 0.5);
    } else {
      viewImg.src = photo.lqip;
      viewer.shownWidth = 0;
      viewImg.classList.add("preview");
    }
    viewImg.alt = photo.title || photo.caption || "";
    viewImg.style.backgroundColor = photo.color;
    apply();
    clearTimeout(scheduleResolution.timer);
    upgradeResolution();

    $("counter").textContent = visible.length > 1 ? `${viewer.index + 1} / ${visible.length}` : "";
    $("viewer-title").textContent = photo.title || photo.caption;
    $("viewer-exif").textContent = [photo.exif.camera, settings(photo.exif)].filter(Boolean).join("   ·   ");
    $("btn-prev").disabled = viewer.index <= 0;
    $("btn-next").disabled = viewer.index >= visible.length - 1;
    $("btn-play").hidden = visible.length < 2;

    const download = $("btn-download");
    download.hidden = !photo.original;
    if (photo.original) {
      download.href = photo.original.url;
      download.download = photo.original.name;
      download.title = `Download original  ·  ${formatBytes(photo.original.size)} (D)`;
    }
    if (!infoEl.hidden) renderInfo();
    if (viewer.playing) queueNextSlide();
  }

  function renderInfo() {
    const photo = viewer.photo;
    const exif = photo.exif;
    const rows = [];
    const add = (term, value) => value && rows.push(el("dt", { textContent: term }), el("dd", { textContent: value }));
    add("Taken", exif.taken && formatDate(exif.taken));
    add("Camera", exif.camera);
    add("Lens", exif.lens);
    add("Exposure", settings(exif));
    add("Size", `${photo.width.toLocaleString()} × ${photo.height.toLocaleString()} px  ·  ${((photo.width * photo.height) / 1e6).toFixed(1)} MP`);
    if (photo.original) add("File", `${photo.original.name}  ·  ${formatBytes(photo.original.size)}`);
    add("Album", albums.find((a) => a.id === photo.album)?.name);

    const children = [el("h2", { textContent: photo.title || "Untitled" })];
    if (photo.caption && photo.caption !== photo.title) children.push(el("p", { className: "caption", textContent: photo.caption }));
    children.push(el("dl", {}, rows));
    infoEl.replaceChildren(...children);
  }

  function toggleInfo(force) {
    const open = force ?? infoEl.hidden;
    infoEl.hidden = !open;
    viewerEl.classList.toggle("info-open", open);
    $("btn-info").setAttribute("aria-pressed", String(open));
    if (open) renderInfo();
  }

  function go(offset) {
    const next = visible[viewer.index + offset];
    if (!next) return false;
    history.replaceState(history.state, "", `#/photo/${encodeURIComponent(next.id)}`);
    showPhoto(next);
    return true;
  }

  function closeViewer({ fromHistory = false } = {}) {
    if (!viewer.photo) return;
    if (!fromHistory) {
      // Opened from the gallery: step back so the browser's Back button stays in sync.
      if (history.state?.viewer) {
        history.back();
        return;
      }
      history.replaceState(null, "", album ? `#/album/${encodeURIComponent(album)}` : location.pathname + location.search);
    }
    const photo = viewer.photo;
    stopSlideshow();
    viewer.photo = null;
    viewer.token++;
    viewerEl.hidden = true;
    viewerEl.classList.remove("idle", "loading", "zoomed");
    toggleInfo(false);
    hideBadge();
    viewImg.removeAttribute("src");
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.documentElement.classList.remove("viewer-open");
    document.removeEventListener("keydown", onKey);

    const tile = tiles.get(photo.id);
    const focusTarget = tile && !tile.hidden ? tile : viewer.returnFocus;
    if (tile && !tile.hidden) {
      const rect = tile.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight) tile.scrollIntoView({ block: "center" });
    }
    focusTarget?.focus?.({ preventScroll: true });
  }

  /* ---------- Slideshow ---------- */

  function startSlideshow() {
    viewer.playing = true;
    $("btn-play").querySelector("use").setAttribute("href", "#i-pause");
    $("btn-play").setAttribute("aria-label", "Pause slideshow");
    if (viewer.z > 1.01) zoomAt(1, 0, 0, true);
    queueNextSlide();
  }

  function queueNextSlide() {
    clearTimeout(viewer.playTimer);
    viewer.playTimer = setTimeout(() => {
      if (!viewer.playing) return;
      if (!go(1)) {
        history.replaceState(history.state, "", `#/photo/${encodeURIComponent(visible[0].id)}`);
        showPhoto(visible[0]);
      }
    }, SLIDESHOW_MS);
  }

  function stopSlideshow() {
    if (!viewer.playing) return;
    viewer.playing = false;
    clearTimeout(viewer.playTimer);
    $("btn-play").querySelector("use").setAttribute("href", "#i-play");
    $("btn-play").setAttribute("aria-label", "Slideshow");
  }

  /* ---------- Controls ---------- */

  $("btn-close").addEventListener("click", () => closeViewer());
  $("btn-prev").addEventListener("click", () => (stopSlideshow(), go(-1)));
  $("btn-next").addEventListener("click", () => (stopSlideshow(), go(1)));
  $("btn-zoom").addEventListener("click", () => toggleZoom());
  $("btn-info").addEventListener("click", () => toggleInfo());
  $("btn-play").addEventListener("click", () => (viewer.playing ? stopSlideshow() : startSlideshow()));
  $("btn-share").addEventListener("click", share);
  $("btn-download").addEventListener("click", stopSlideshow);

  const fullscreenButton = $("btn-fullscreen");
  fullscreenButton.hidden = !document.fullscreenEnabled;
  fullscreenButton.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", () => {
    const on = Boolean(document.fullscreenElement);
    fullscreenButton.querySelector("use").setAttribute("href", on ? "#i-shrink" : "#i-expand");
    fullscreenButton.setAttribute("aria-label", on ? "Exit full screen" : "Full screen");
  });

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else viewerEl.requestFullscreen().catch(() => {});
  }

  async function share() {
    const photo = viewer.photo;
    const data = { title: photo.title || site.title, url: location.href };
    if (navigator.share && coarsePointer.matches) {
      try {
        await navigator.share(data);
      } catch {}
      return;
    }
    try {
      await navigator.clipboard.writeText(location.href);
      toast("Link copied");
    } catch {
      toast(location.href);
    }
  }

  function onKey(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const { w, h } = stageSize();
    switch (event.key) {
      case "Escape":
        if (!infoEl.hidden && innerWidth <= 760) toggleInfo(false);
        else closeViewer();
        break;
      case "ArrowLeft":
        stopSlideshow();
        go(-1);
        break;
      case "ArrowRight":
        stopSlideshow();
        go(1);
        break;
      case "+":
      case "=":
        stopSlideshow();
        zoomAt(viewer.z * 1.5, w / 2, h / 2, true);
        break;
      case "-":
        zoomAt(viewer.z / 1.5, w / 2, h / 2, true);
        break;
      case "0":
        zoomAt(1, w / 2, h / 2, true);
        break;
      case "z":
      case "Z":
        toggleZoom();
        break;
      case "i":
      case "I":
        toggleInfo();
        break;
      case "f":
      case "F":
        if (document.fullscreenEnabled) toggleFullscreen();
        break;
      case "d":
      case "D":
        if (viewer.photo.original) $("btn-download").click();
        break;
      case " ":
        if (event.target.closest("button, a")) return;
        if (visible.length > 1) viewer.playing ? stopSlideshow() : startSlideshow();
        break;
      case "Tab":
        trapFocus(event);
        return;
      default:
        return;
    }
    wakeChrome();
    event.preventDefault();
  }

  function trapFocus(event) {
    const focusable = [...viewerEl.querySelectorAll("button, a[href]")].filter((node) => !node.hidden && !node.disabled && node.offsetParent);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !viewerEl.contains(document.activeElement))) {
      last.focus();
      event.preventDefault();
    } else if (!event.shiftKey && (document.activeElement === last || !viewerEl.contains(document.activeElement))) {
      first.focus();
      event.preventDefault();
    }
  }

  // Hide the controls after a few still seconds so the photo has the screen to itself.
  let idleTimer;
  function wakeChrome() {
    viewerEl.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (viewer.photo && infoEl.hidden && !hoveringControls) viewerEl.classList.add("idle");
    }, 3000);
  }

  let hoveringControls = false;
  viewerEl.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse") return;
    hoveringControls = Boolean(event.target.closest(".viewer-bar button, .viewer-bar a, .viewer-nav"));
    wakeChrome();
  });

  /* ---------- Gestures: drag, swipe, pinch, wheel, double-tap ---------- */

  const pointers = new Map();
  let gesture = null;
  let lastTap = null;
  let tapTimer;

  function point(event) {
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function beginGesture() {
    const points = [...pointers.values()];
    if (points.length >= 2) {
      const [a, b] = points;
      gesture = {
        type: "pinch",
        distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        z: viewer.z,
        x: viewer.x,
        y: viewer.y,
        moved: true,
      };
    } else if (points.length === 1) {
      const zoomed = viewer.z > 1.01;
      gesture = { type: zoomed ? "pan" : "swipe", start: points[0], x: viewer.x, y: viewer.y, moved: false, time: performance.now() };
    } else {
      gesture = null;
    }
  }

  stage.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, point(event));
    const moved = gesture?.moved;
    beginGesture();
    if (gesture && moved) gesture.moved = true;
  });

  stage.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId) || !gesture) return;
    pointers.set(event.pointerId, point(event));
    const points = [...pointers.values()];

    if (gesture.type === "pinch" && points.length >= 2) {
      const [a, b] = points;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const z = Math.min(maxZoom() * 1.2, Math.max(0.6, (gesture.z * distance) / gesture.distance));
      viewer.x = mid.x - (gesture.mid.x - gesture.x) * (z / gesture.z);
      viewer.y = mid.y - (gesture.mid.y - gesture.y) * (z / gesture.z);
      viewer.z = z;
      stopSlideshow();
      apply({ clamp: z >= 1 });
      return;
    }

    const p = points[0];
    const dx = p.x - gesture.start.x;
    const dy = p.y - gesture.start.y;
    if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
    gesture.moved = true;
    viewerEl.classList.add("dragging");

    if (gesture.type === "pan") {
      viewer.x = gesture.x + dx;
      viewer.y = gesture.y + dy;
      apply();
    } else {
      // Not zoomed: follow the finger, then decide on release between next/previous and close.
      viewer.x = gesture.x + dx;
      viewer.y = gesture.y + Math.max(0, dy) * (Math.abs(dy) > Math.abs(dx) ? 1 : 0);
      viewerEl.style.backgroundColor = `rgba(0, 0, 0, ${1 - Math.min(0.6, Math.max(0, viewer.y - gesture.y) / 400)})`;
      apply({ clamp: false });
    }
  });

  function endPointer(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    const ended = gesture;

    if (pointers.size) {
      // One finger lifted mid-pinch: carry on panning with the other.
      beginGesture();
      if (gesture) gesture.moved = true;
      return;
    }
    gesture = null;
    viewerEl.classList.remove("dragging");
    if (!ended) return;

    if (ended.type === "pinch") {
      if (viewer.z < 1) zoomAt(1, 0, 0, true);
      else if (viewer.z > maxZoom()) {
        const { w, h } = stageSize();
        zoomAt(maxZoom(), w / 2, h / 2, true);
      }
      return;
    }

    if (ended.type === "swipe" && ended.moved) {
      const dx = viewer.x - ended.x;
      const dy = viewer.y - ended.y;
      viewerEl.style.backgroundColor = "";
      if (dy > 110 && dy > Math.abs(dx)) return closeViewer();
      if (Math.abs(dx) > 70 && go(dx < 0 ? 1 : -1)) return stopSlideshow();
      apply({ animate: true });
      return;
    }

    if (!ended.moved && event.type === "pointerup") onTap(event, ended);
  }

  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", endPointer);

  function onTap(event, ended) {
    const at = point(event);
    const now = performance.now();
    if (lastTap && now - lastTap.time < 320 && Math.hypot(at.x - lastTap.x, at.y - lastTap.y) < 40) {
      clearTimeout(tapTimer);
      lastTap = null;
      toggleZoom(at.x, at.y);
      return;
    }
    lastTap = { ...at, time: now };
    const width = viewer.photo.width * viewer.fit * viewer.z;
    const height = viewer.photo.height * viewer.fit * viewer.z;
    const onImage = at.x >= viewer.x && at.x <= viewer.x + width && at.y >= viewer.y && at.y <= viewer.y + height;
    tapTimer = setTimeout(() => {
      lastTap = null;
      if (event.pointerType === "mouse") {
        if (!onImage && viewer.z <= 1.01) closeViewer();
      } else if (viewerEl.classList.contains("idle")) {
        wakeChrome();
      } else {
        clearTimeout(idleTimer);
        viewerEl.classList.add("idle");
      }
    }, 320);
  }

  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      stopSlideshow();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      const factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0018));
      const at = point(event);
      zoomAt(viewer.z * factor, at.x, at.y);
    },
    { passive: false },
  );

  new ResizeObserver(() => {
    if (!viewer.photo) return;
    const before = viewer.fit * viewer.z;
    const zoomed = viewer.z > 1.01;
    computeFit();
    // A zoomed photo keeps its scale; an unzoomed one refits the new stage size.
    viewer.z = zoomed ? Math.max(1, before / viewer.fit) : 1;
    apply();
  }).observe(stage);

  // Safari fires its own gesture events for trackpad pinches; the wheel handler covers them.
  stage.addEventListener("gesturestart", (event) => event.preventDefault());
})();
