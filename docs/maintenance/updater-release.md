# Signed updater release maintenance

## Trust and recovery boundary

WNACG uses the official Tauri 2 updater. The public verification key is
embedded in `src-tauri/tauri.conf.json`; the encrypted private key must never be
committed, logged, copied into an installer, or sent to an application client.

The current signing material is stored in three places:

- encrypted private key: `~/.tauri/wnacg-updater.key` with mode `0600`;
- private-key password: macOS Keychain service
  `com.yuxino.wnacg.updater-signing`, account `wnacg-updater`;
- CI copies: GitHub Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in `yuxino/wnacg`.

Losing either the private key or its password prevents publishing updates that
existing updater-enabled installations will trust. Do not rotate the public key
without first shipping and validating a key-rotation release signed by the old
key. The private key is independent from macOS Developer ID and Windows
Authenticode identities.

## Private Release boundary

The app is restricted to:

`https://github.com/yuxino/wnacg/releases/latest/download/latest.json`

The repository and its Releases remain private. GitHub intentionally returns
`404` for anonymous access to a private Release, so installed applications
cannot currently consume this endpoint. Never work around this with a PAT
embedded in the app or an updater request header containing a durable
repository credential.

Before tagging a private updater-enabled release, the release preflight must
prove all of the following:

1. Both updater signing secrets are present.
2. CI generated each installer, updater archive, and matching signature.
3. The authenticated release job can download the private assets and verify
   every recorded SHA-256 digest.
4. The repository remains private and the application contains no credential.

If any condition fails, stop before creating a tag or Release.

## Release artifacts

The bootstrap and later releases must contain:

- conventional macOS DMG and Windows NSIS/MSI installers;
- macOS `wnacg.app.tar.gz` and its `.sig`;
- Windows x64 NSIS updater and its `.sig`;
- `latest.json`, `updater-assets.json`, and `SHA256SUMS.txt`.

`scripts/updater-manifest.mjs` generates and revalidates the static Tauri feed.
It accepts only stable SemVer, the fixed private repository, exact
`darwin-aarch64` and `windows-x86_64` platform keys, unique assets, canonical
HTTPS URLs, and signatures that exactly match the corresponding `.sig` files.
The release workflow must authenticate as GitHub Actions, download the private
Release, and verify `latest.json` and every checksum again after publication.

## Bootstrap release

Version `0.1.11` is the planned updater bootstrap. Existing versions cannot
self-install it because they do not contain the updater plugin. Users must
manually install this version once; application-managed updates begin only with
an update endpoint that installed applications can authenticate to safely.
