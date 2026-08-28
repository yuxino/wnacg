<div align="center">
  <br>
  <img src="public/brand/kiri-icon-256.png" width="112" alt="wnacg">
  <h1>wnacg</h1>
  <p><a href="README.md">简体中文</a> · <strong>English</strong></p>
  <p>A cleaner desktop reader for wnacg, with local OCR and manga translation.</p>
</div>

> 18+. The repository contains no third-party content. Automated installers, when available, are published on [Releases](https://github.com/yuxino/wnacg/releases); they are not currently notarized or store-signed.

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

The reader settings store the DeepSeek key in macOS Keychain. A legacy `config.json` key is removed only after a verified Keychain migration; `DEEPSEEK_API_KEY` remains a compatibility input. The Windows build cannot yet save a key securely from the UI.

The first manga OCR run downloads about 230 MB of models and compiles a Rust helper locally; models and build cache may use roughly 500 MB in total. Apple Vision OCR is available only on macOS.

## Notes

The project depends on the upstream site and may break after site changes. Follow local laws and site rules, and keep explicit content out of issues, commits, and screenshots.
