<div align="center">
  <br>
  <img src="src-tauri/icons/kiri/128x128@2x.png" width="112" alt="wnacg">
  <h1>wnacg</h1>
  <p><a href="README.md">简体中文</a> · <strong>English</strong></p>
  <p>A cleaner desktop reader for wnacg, with local OCR and manga translation.</p>
</div>

> 18+. The repository and installers do not bundle third-party manga, image content, or OCR model weights. Automated installers, when available, are published on [Releases](https://github.com/yuxino/wnacg/releases); they are not currently notarized or store-signed.

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

Manga OCR models are not shipped in the installer. The first run downloads about 224 MiB of pinned models and compiles a helper locally, so installed builds also require a Rust toolchain. After a successful build, temporary Cargo artifacts are removed and only the models and a compact helper cache remain. Apple Vision OCR is available only on macOS and requires Xcode Command Line Tools to compile its helper on first use.

This repository does not currently include a project-level open-source license, and the OCR models and training data have not completed a formal distribution-license review. Automatic download does not imply redistribution permission; each source must be confirmed before a formal release.

## Notes

The project depends on the upstream site and may break after site changes. Follow local laws and site rules, and keep explicit content out of issues, commits, and screenshots.
