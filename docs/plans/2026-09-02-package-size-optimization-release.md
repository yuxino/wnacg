# Package Size Optimization and Release Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce WNACG's distributable and installed size with measured, regression-safe changes, then publish the next private release.

**Architecture:** Measure the published release and a clean local package under comparable conditions, rank binary and resource contributors, and change only build or asset inputs with a demonstrated payoff. Preserve all reader, navigation, credential, custom-protocol, installer, and security boundaries, then repeat the same measurements on the release candidate before publishing.

**Tech Stack:** Tauri 2, Rust, TypeScript/Vite, macOS DMG tooling, Windows MSI/NSIS GitHub Actions, GitHub Releases.

---

### Task 1: Establish the release baseline

**Files:**
- Inspect: `src-tauri/Cargo.toml`
- Inspect: `src-tauri/tauri.conf.json`
- Inspect: `src-tauri/tauri.windows.conf.json`
- Inspect: `.github/workflows/release.yml`

**Steps:**
1. Confirm the dedicated and primary worktrees are clean and match live `origin/main`.
2. Download every `v0.1.9` release asset and record byte size and SHA-256.
3. Mount the DMG and record app, executable, frontend, resource, icon, and code-signature sizes.
4. Inspect Windows packages with available archive tooling or CI package metadata without modifying them.
5. Record source static-resource sizes, release dependencies, and stripped-symbol evidence.

### Task 2: Select the smallest justified optimization

**Files:**
- Modify only the measured build/profile, dependency, or asset inputs that dominate package size.
- Test: existing frontend and Rust suites.

**Steps:**
1. Rank candidates by expected packaged-byte reduction and compatibility risk.
2. Reject candidates that weaken reader/navigation behavior, Windows Credential Manager, custom protocol, installer lifecycle, subprocess safety, or regression coverage.
3. Apply the minimum configuration or asset change that has a measurable payoff.
4. Build a release candidate and repeat Task 1 measurements under the same conditions.
5. Revert any change whose measured benefit is negligible or whose boundary evidence regresses.

### Task 3: Verify the release candidate

**Files:**
- Test: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/ocr.rs`
- Test: `src-tauri/src/translate.rs`
- Test: `scripts/windows-smoke.ps1`

**Steps:**
1. Run `npm run check` and expect frontend build, formatting, Clippy, Rust tests, and OCR helper checks to pass.
2. Run `npm audit --audit-level=high` and expect no high-severity vulnerability.
3. Build the macOS Tauri bundle and validate its DMG, architecture, signing structure, and mounted app.
4. Search the final diff for the preserved credential, custom-protocol, reader, navigation, race-token, and subprocess boundaries.
5. Review `git diff --check`, staged paths, and the complete staged diff.

### Task 4: Version and deliver

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/tauri.conf.json`

**Steps:**
1. Query live tags/releases and choose the next unused patch version.
2. Update every canonical version source and verify exact agreement.
3. Commit only task-owned files and push the single reviewed outgoing commit to `main`.
4. Create and push the matching release tag.
5. Wait for macOS, Windows x64, Windows ARM64-emulation smoke, and release creation jobs to succeed.

### Task 5: Prove private publication

**Steps:**
1. Confirm the authenticated release is non-draft, non-prerelease, and returned as Latest Release.
2. Confirm every expected platform asset and the SHA-256 manifest are present.
3. Download assets through the authenticated private-repository path, recompute SHA-256 values, and compare them with the published manifest.
4. Verify `HEAD`, local `main`, `origin/main`, live remote `main`, and the tag resolve to the release commit.
5. Report package/build evidence separately from native installation, launch, and Windows device interaction.
