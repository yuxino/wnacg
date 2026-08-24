<div align="center">
  <br>
  <img src="public/brand/kiri-icon-256.png" width="112" alt="wnacg">
  <h1>wnacg</h1>
  <p><a href="README.md">简体中文</a> · <strong>English</strong></p>
  <p>A cleaner desktop reader for wnacg, with local OCR and manga translation.</p>
</div>

> 18+. Source code only. No third-party content or installers are included.

## Features

- Category, keyword, and tag search, with covers blurred by default
- Continuous, single-page, and two-page reading with page controls, fullscreen, zoom, and multiple windows
- Local OCR with Apple Vision, `comic-text-detector`, and `manga-ocr`
- DeepSeek manga translation with vertical Japanese layout, bubble typesetting, and pre-translation

Built with Tauri 2. The UI is TypeScript; scraping and image proxying run on the Rust side.

## Run locally

Requires [Node.js](https://nodejs.org/), [Rust](https://www.rust-lang.org/tools/install), and [Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/). Local OCR on macOS also needs Xcode Command Line Tools.

```bash
git clone https://github.com/yuxino/wnacg.git
cd wnacg
npm install
npm run tauri dev
```

Build:

```bash
npm run tauri build
```

Translation reads `deepseekApiKey` from `~/Library/Application Support/wnacg/config.json`, or from the `DEEPSEEK_API_KEY` environment variable.

## Notes

The project depends on the upstream site and may break after site changes. Follow local laws and site rules, and keep explicit content out of issues, commits, and screenshots.
