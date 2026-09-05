<div align="center">
  <br>
  <img src="src-tauri/icons/kiri/128x128@2x.png" width="112" alt="wnacg">
  <h1>wnacg</h1>
  <p><a href="README.md">简体中文</a> · <strong>English</strong></p>
  <p>A desktop manga reader for WNACG with focused reading, local OCR, and optional translation. The interface is currently available in Simplified Chinese only.</p>
</div>

> 18+. The repository and installers do not include third-party manga, images, or OCR model weights.

<!-- project-demo-v1 -->
## Demo

[![wnacg — Demo](docs/demos/preview.gif)](docs/demos/demo.mp4)

[Full video (MP4)](docs/demos/demo.mp4) · [About this demo](docs/demos/README.md)

Continuous, single-page and spread layouts with original sample pages. Recorded from the actual frontend with sample data. No upstream site, third-party comics, OCR or translation results are used.
<!-- /project-demo-v1 -->

## Downloads and platforms

Download from [Releases](https://github.com/yuxino/wnacg/releases):

- **Windows x64:** supports 64-bit Windows 10 1709+ and Windows 11. The current installers are marked as previews; installation, launch, browsing, settings, and basic reading have been verified on Windows 11. The installers are unsigned and may trigger SmartScreen or managed-device policy; they download Microsoft Edge WebView2 Runtime when it is missing.
- **macOS:** supports Apple silicon on macOS 11+. The build is ad-hoc signed and not notarized.

Intel Mac and Linux installers are not provided. Windows includes the x64 Japanese-OCR helper, but its first model download and real recognition, plus DeepSeek translation, have not completed end-to-end Windows acceptance.

### In-app updates

`v0.1.11` is the signed updater bootstrap. Older versions do not contain the updater, so this version still needs one manual installation from Releases. Installers and updater bundles carry an independent update signature. The app does not embed a GitHub token and does not download or install updates silently.

Releases remain private as requested. Because a desktop app cannot safely embed repository credentials, its update check cannot read a private Release anonymously; sign in to GitHub and download later versions manually from Releases. The settings page offers the Releases link after a failed check.

## Features

- Browse by category, search by keyword, and follow author, tag, and category links from album details
- Continuous, single-page, and two-page reading with keyboard navigation, fullscreen, zoom, and separate reader windows
- Local OCR through Apple Vision on macOS or `comic-text-detector` with `manga-ocr` for Japanese text
- Optional DeepSeek translation for Japanese dialogue and titles, with in-image typesetting
- Visible recognition, translation, and retryable error states, plus automatic throttling when the site rate-limits requests
- Signed updater foundations, real download-progress states, and an explicit recovery path when private checks fail

## Run locally

The app is built with Tauri 2. Development requires [Node.js](https://nodejs.org/), [Rust](https://www.rust-lang.org/tools/install), and the [Tauri 2 system prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
git clone https://github.com/yuxino/wnacg.git
cd wnacg
npm ci
npm run tauri dev
```

```bash
npm run tauri build
```

## Local data and privacy

OCR runs locally. The first use of Japanese OCR downloads and caches about 224 MiB of pinned models from Hugging Face. The Windows installer includes the helper, so users do not need Rust. Apple Vision on macOS requires Xcode Command Line Tools.

DeepSeek translation is optional and sends only text and titles, not images; source text and translations are cached locally. API keys are stored in macOS Keychain or Windows Credential Manager.

This repository does not include a project-level open-source license. The OCR models and training data have not completed a formal distribution-license review; automatic download does not grant redistribution rights.

## Notes

The app connects to WNACG and its image hosts and depends on the upstream page structure; site changes may break features. Follow local laws and site rules, and keep explicit content out of issues, commits, and screenshots.
