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

1. **A separate public binary-only feed (recommended).** It can expose only
   `latest.json`, signed updater bundles, signatures, and conventional
   installers while the source repository stays private. Creating or exposing
   that feed is an external publication decision and is not authorized here.
2. **Authenticated private updates.** A custom service could authenticate each
   user and add short-lived request headers. Embedding a GitHub PAT or durable
   token in the desktop app is rejected because every installed copy could
   extract it.
3. **The current private GitHub Release URL.** It is controlled and safe to
   compile as a staging endpoint, but unauthenticated requests return 404. It
   is not a usable production feed and must not be described as one.

The implementation uses option 3 only as a safe staging default. Tagged
release publication is gated on an explicitly configured HTTPS updater
endpoint and public reachability. Until option 1 or an authenticated service is
authorized, main can carry and test the implementation but no updater-enabled
tag should be published.

## Application architecture

The frontend uses `@tauri-apps/plugin-updater` and
`@tauri-apps/plugin-process`; Rust only initializes the official plugins. The
checked-in Tauri configuration contains the updater public key, the controlled
staging endpoint, `createUpdaterArtifacts: true`, and passive (not quiet)
Windows installation. Capabilities grant only the updater workflow, process
restart, and the existing fixed Releases recovery URL.

The UI state machine is `idle -> checking -> current|available -> downloading
-> installing -> restartReady`, with explicit error states and one in-flight
operation guard. An available update shows version and release notes. Known
content length produces an actual percentage and progress element; unknown
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
revalidates the manifest before upload.

Tests cover the state model, determinate and indeterminate progress, duplicate
click protection, network/check failures, retry, download/signature failures,
installation failure, and relaunch readiness. Canonical checks and real package
builds remain separate from native upgrade evidence. A tag is allowed only
when the configured feed is reachable without repository credentials; this is
the current external blocker.
