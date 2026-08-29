<div align="center">
  <br>
  <img src="src-tauri/icons/kiri/128x128@2x.png" width="112" alt="wnacg">
  <h1>wnacg</h1>
  <p><a href="README.md">简体中文</a> · <strong>English</strong></p>
  <p>A desktop manga reader for WNACG with focused reading, local OCR, and optional translation. The interface is currently available in Simplified Chinese only.</p>
</div>

> 18+. The repository and installers do not include third-party manga, images, or OCR model weights. Download the installer for macOS 11+ on Apple silicon or 64-bit Windows 10 1709+ / Windows 11 from [Releases](https://github.com/yuxino/wnacg/releases); Intel Mac and Linux installers are not currently provided. The macOS build is only ad-hoc signed and is not notarized. The Windows build requires Microsoft Edge WebView2 Runtime; the installer downloads it if missing, so that step needs internet access. The Windows installers are not code-signed, so SmartScreen may block them and managed-device policy may prevent continuing.

## Features

- Browse by category, search by keyword, and continue through category, author/uploader, and tag links in album details
- Continuous, single-page, and two-page reading with keyboard navigation, fullscreen, zoom, and separate reader windows
- Local OCR: Apple Vision for Chinese-first recognition, or `comic-text-detector` with `manga-ocr` for Japanese-first recognition
- Optional DeepSeek translation for recognized Japanese dialogue and titles, with in-image typesetting and pre-translation

Built with Tauri 2.

## Run locally

Requires [Node.js](https://nodejs.org/), [Rust](https://www.rust-lang.org/tools/install), and the [Tauri 2 system prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
git clone https://github.com/yuxino/wnacg.git
cd wnacg
npm ci
npm run tauri dev
```

Build:

```bash
npm run tauri build
```

DeepSeek translation is an optional cloud feature: when enabled, text and titles awaiting translation are sent to DeepSeek, but images are not; source text and translations are cached locally. The key is stored in macOS Keychain. On other platforms, use `DEEPSEEK_API_KEY` because secure saving from the UI is not yet supported.

OCR runs locally. Enabling Japanese manga OCR for the first time downloads about 224 MiB of pinned models from Hugging Face and compiles a helper with Rust. Apple Vision is macOS-only and also requires Xcode Command Line Tools on first use.

This repository does not currently include a project-level open-source license. The OCR models and training data have not completed a formal distribution-license review; automatic download does not grant redistribution rights.

## Notes

The app connects to WNACG and its image hosts and depends on the upstream page structure; site changes may break it. Follow local laws and site rules, and keep explicit content out of issues, commits, and screenshots.
