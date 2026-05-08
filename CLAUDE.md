# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Tauri 2 desktop reader for the wnacg site. Frontend is vanilla TypeScript + Vite (no framework, no router); backend is a single Rust crate that scrapes HTML and proxies images.

## Commands

- `npm run tauri dev` — full app (Tauri spawns Vite at `localhost:1420` automatically; do **not** start `npm run dev` separately)
- `npm run dev` — frontend only, useful for CSS/layout work without Rust rebuilds
- `npm run build` — `tsc && vite build` (typecheck gate before bundling)
- `cd src-tauri && cargo check` — fast Rust validation without rebuilding the bundle
- `npm run tauri build` — produce platform installers (slow)

There is no test suite, linter, or formatter wired up — `tsc --noEmit` and `cargo check` are the only correctness checks.

## Architecture

### Two processes, one HTTP boundary

All scraping and image fetching happens in Rust (`src-tauri/src/lib.rs`); the frontend calls them through `invokeTauri()` (`src/main.ts:670`), which prefers `window.__TAURI__.core.invoke` (enabled via `withGlobalTauri: true` in `tauri.conf.json`) and falls back to dynamic import. Never call wnacg URLs from the frontend — CORS aside, the Rust side handles cookies, headers, and Cloudflare workarounds.

Tauri commands registered in `lib.rs` `run()`:
- List/search: `fetch_albums`, `search_albums`, `search_tag`
- Reader: `fetch_album_photos` (returns `AlbumDetail { photos, tags, title }`), `fetch_photo_image`
- Image proxy: `fetch_image_data_url`, `fetch_image_data_url_progress` (streams `image-progress` events back via `Emitter`)
- Window: `is_window_fullscreen`, `toggle_window_fullscreen`, `open_album_window`, `set_window_title`

When adding a Rust command, both register it in `generate_handler!` **and** check `src-tauri/capabilities/default.json` — `windows` uses the `["main", "album-*"]` glob to cover spawned reader windows.

### Scraper resilience: BASE_URLS + curl fallback

`BASE_URLS` (lib.rs:14) holds three mirror domains; every list/detail/image command iterates them and aggregates errors. `fetch_page` (lib.rs:532) tries `reqwest` first, then falls back to a `curl --http1.1` subprocess (`fetch_page_via_curl`) if the response is empty, non-2xx, or matches Cloudflare challenge fingerprints (`cf_chl`, `Just a moment`, `challenge-platform`). HTML parsers also re-check for these markers and surface a friendly Chinese error string. **Don't remove the curl path** — it is the recovery channel when reqwest's TLS handshake gets flagged.

When parsing breaks (e.g. site HTML changes), look at `parse_albums`, `parse_album_photos`, `parse_album_max_page`, `parse_photo_image`, `parse_album_tags`, `parse_album_title` — selectors there are deliberately broad (`.gallary_item, li, .pic_box, .album, .list li`) because the site's markup is inconsistent across pages.

### Frontend is one big state machine in `src/main.ts`

Everything lives in `state` (main.ts:174) — `view: "list" | "reader"`, `mode: "category" | "search" | "tag"`, current album, photos, lightbox index/zoom/pan, reader prefs. There is no component framework; functions read DOM refs declared at module top and mutate them.

Three monotonically-incrementing **race tokens** guard against late async results:
- `state.listToken` — bumped when changing category/search/page; `loadAlbums`/`loadNextPage` abort if the token shifted mid-request
- `state.readerToken` — same, for `loadAlbumReader`
- `state.lightboxToken` — same, for image fetches

Whenever you add an async path that mutates state on completion, capture the token before `await` and check it after. This is the project's primary concurrency discipline.

### Multi-window model

The "open in new window" feature (`open_album_window` Rust command) launches a second webview pointing at `index.html#aid=<aid>`. On boot, `getInitialAlbumFromHash()` (main.ts:2523) detects the hash, adds `.standalone-album` to `.shell`, hides the sidebar via CSS, and goes straight to `loadAlbumReader`. In standalone mode `backToList` calls `closeStandaloneWindow()` instead of returning to the list. Window labels are sanitized via `sanitize_window_label` (alphanumeric only, prefixed `album-`) — the capabilities glob depends on this prefix.

After `fetch_album_photos` returns, `applyAlbumTitle()` updates `document.title` **and** invokes `set_window_title` so the OS chrome reflects the real album name (placeholders during loading are intentional).

### Reader prefs & reading progress

Both persisted to `localStorage` under versioned keys (`wnacg.readerPrefs.v1`, `wnacg.readingProgress.v1`). `readingProgressLimit = 60` caps the LRU. The reading-marks API (`recordReadingMark`/`getReadingMark`) drives the "已读" badge on album cards via `applyReadBadge()` and the auto-resume on reopen via `restoreReadingMark()` (currently stream-mode only).

### Tray + macOS specifics

Tray icon uses a template-style PNG (`icons/tray-icon.png`) for proper macOS menu bar appearance. `RunEvent::Reopen` (Dock click on macOS) is gated behind `#[cfg(target_os = "macos")]` — don't drop that gate, it doesn't compile on other platforms. Window close is intercepted to hide-to-tray rather than quit.

## Conventions worth knowing

- User-facing strings are Chinese; keep new ones consistent (e.g. `"加载失败"`, `"暂无内容"`).
- DOM is built imperatively with `createElement` + `append`, never `innerHTML` (the codebase has no sanitizer).
- `hydrateImage()` is the only correct way to render a wnacg image — it routes through the Rust proxy with progress reporting; setting `<img src>` directly to a wnacg URL will fail (referer/CORS).
- CSS lives in one `src/styles.css` file (~1700 lines); search by selector, not by file.
