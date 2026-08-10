<div align="center">
  <br>
  <img src="public/app-icon.png" width="112" alt="wnacg">
  <h1>wnacg</h1>
  <p><a href="README.md">简体中文</a> · <strong>English</strong></p>
</div>

<p align="center">A desktop shell for wnacg, with a translation team living inside.</p>

<p align="center">
  <a href="#screenshots"><strong>Screenshots</strong></a>
  · <a href="#whats-inside">What's inside</a>
  · <a href="#run-locally">Run locally</a>
  · <a href="#fair-warning">Fair warning</a>
</p>

<br>

I got tired of juggling browser tabs, so I wrote this. Search by category, keyword, or tag, open a title, and just scroll. Reading position and display settings are stored locally — close it and come back to the same page.

> 18+. Source code only, no installers.

## Screenshots

The home screen. Pick a category, keyword, or search on the left; scroll the grid on the right. Covers are blurred by default.

![Album list with Gaussian-blurred covers](docs/images/wnacg-library-masked.jpg)

Opening a title gives you continuous reading. Progress and settings are remembered, and a book can be moved to its own window.

![Continuous reading view, images blurred](docs/images/wnacg-reader-masked.jpg)

The most annoying part of raw manga is vertical Japanese. Local OCR finds and reads the text, DeepSeek translates it, and the Chinese is typeset back into the original bubble.

![Smart translation: original vertical Japanese](docs/images/wnacg-translate-before.jpg)

![Smart translation: Chinese typeset back into the bubble, right to left](docs/images/wnacg-translate-after.jpg)

## What's inside

- Search by category / keyword / tag, with blurred covers
- Continuous reading, fullscreen and zoom, reading position and display settings saved locally, multiple windows per book
- **Local OCR engine** (invisible, powers translation): horizontal Chinese uses Apple Vision; vertical Japanese (the most annoying kind) uses manga-specific models — `comic-text-detector` finds the boxes, `manga-ocr` reads the text. Models are ~230MB, downloaded automatically on first use, and recognition stays fully offline
- **Translated subtitles**: recognized Japanese goes to DeepSeek, the original is covered, and the translation is typeset back into the bubble — horizontal wraps, vertical reads right to left, rounded font, normalized punctuation. One page behind and three ahead are pre-translated, so turning pages usually needs no wait; hover to see the original, click to retry on failure
- **Title translation**: one click turns list and detail titles into Chinese, keeping bracketed author / circle / DL metadata intact, cached locally

It's a Tauri 2 shell with a TypeScript frontend; scraping and image proxying live in Rust.

## Run locally

You'll need [Node.js](https://nodejs.org/), [Rust](https://www.rust-lang.org/tools/install), and [Tauri 2's system dependencies](https://v2.tauri.app/start/prerequisites/). On macOS, local OCR also needs the Xcode command line tools (`swiftc`); the manga engine compiles once with cargo on first use.

DeepSeek key: translation reads `deepseekApiKey` from `~/Library/Application Support/wnacg/config.json`, or you can set the `DEEPSEEK_API_KEY` environment variable instead.

```bash
git clone https://github.com/yuxino/wnacg.git
cd wnacg
npm install
npm run tauri dev
```

To build:

```bash
npm run tauri build
```

## Fair warning

The repo contains no third-party content and won't upload or store anything for you. Mind your local laws and the site's rules; don't keep or share infringing content, and stay away from anything involving minors or non-consensual private content.

The project may break when the upstream site changes. Open an issue for problems, or a PR if you want to fix something. Keep explicit content out of issues, commits, and screenshots.
