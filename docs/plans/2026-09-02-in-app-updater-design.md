# WNACG signed in-app updater design

## Goal and non-goals

Replace the current “check GitHub and open the Releases page” path with the
official Tauri 2 updater. A check is always user initiated. The app may download
only after a second explicit click, reports real byte progress, lets Tauri
verify the updater signature, and never falls back to an unsigned installer.
On macOS and Linux the installed update waits for an explicit relaunch click.
On Windows the copy explains that the app exits when the installer starts,
because the platform installer owns the remainder of the flow. The Releases
page remains a secondary recovery action only after an error.

The bootstrap release cannot update older installations that do not contain
the updater plugin. Its release notes and both READMEs must therefore state
that it needs one final manual installation. This work does not make source
code, the existing private repository, or existing private Releases public.

## Distribution decision

Three distribution approaches were evaluated:

1. **Private Releases (selected).** The user explicitly chose to keep this
   release private. CI can publish and verify signed updater assets with its
   repository credential, but installed applications cannot read them
   anonymously.
2. **Authenticated private updates.** A custom service could authenticate each
   user and add short-lived request headers. Embedding a GitHub PAT or durable
   token in the desktop app is rejected because every installed copy could
   extract it.
3. **A separate public binary-only feed.** This would expose only `latest.json`,
   signed updater bundles, signatures, and conventional installers while the
   source repository stayed private. It was not selected.

The implementation uses option 1 and fixes every URL to the existing private
`yuxino/wnacg` repository. Tagged releases are allowed after signing and CI
verification. Update checks fail safely for installed applications until an
authenticated service is authorized; the recovery action opens the private
Releases page for users who are already signed in to GitHub.

## Application architecture

The frontend uses `@tauri-apps/plugin-updater` and
`@tauri-apps/plugin-process`; Rust only initializes the official plugins. The
checked-in Tauri configuration contains the updater public key, the private
Release endpoint, `createUpdaterArtifacts: true`, and passive (not quiet)
Windows installation. Capabilities grant only the updater workflow, process
restart, and the existing fixed Releases recovery URL.

The UI state machine is `idle -> checking -> current|available -> downloading
-> installing -> restartReady`, with explicit error states and one in-flight
operation guard. If a future authenticated feed reports an available update,
the UI shows its version and release notes. Known content length produces an
actual percentage and progress element; unknown
length shows downloaded bytes with indeterminate progress. `download()` and
`install()` are separate calls so the UI can distinguish transfer, signature
verification, and installation. Tauri remains the only signature verifier.
No startup download or silent installation is added.

## Release pipeline and evidence

An encrypted Tauri updater key is generated outside the repository. The
private key and password are stored as GitHub Actions secrets; only the public
key is committed. CI creates the macOS updater archive and Windows NSIS updater
artifact plus their `.sig` files. A deterministic script builds `latest.json`
for `darwin-aarch64` and `windows-x86_64`, validates SemVer, exact HTTPS URLs,
signature contents, architecture keys, unique assets, and SHA-256 values, then
revalidates the manifest before upload. After the private Release is created,
the workflow downloads it with the job credential and rechecks every digest.

Tests cover the state model, determinate and indeterminate progress, duplicate
click protection, network/check failures, retry, download/signature failures,
installation failure, and relaunch readiness. Canonical checks and real package
builds remain separate from native upgrade evidence. Private publication can be
verified now; native update installation remains unavailable while the endpoint
requires a repository credential.
