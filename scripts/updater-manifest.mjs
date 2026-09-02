import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const UPDATER_FEED_REPOSITORY = "yuxino/wnacg";
export const UPDATER_PLATFORMS = ["darwin-aarch64", "windows-x86_64"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertStableSemver(version) {
  assert(/^\d+\.\d+\.\d+$/.test(version), `expected a stable SemVer, found: ${version}`);
}

function updaterAssetUrl(repository, version, fileName) {
  assert(repository === UPDATER_FEED_REPOSITORY, `unexpected updater repository: ${repository}`);
  assertStableSemver(version);
  assert(fileName === basename(fileName) && fileName.length > 0, `unsafe updater filename: ${fileName}`);
  const url = new URL(`https://github.com/${repository}/releases/download/v${version}/${fileName}`);
  assert(url.protocol === "https:", "updater URL must use HTTPS");
  assert(url.hostname === "github.com", "updater URL must use github.com");
  assert(url.port === "" && url.username === "" && url.password === "", "updater URL has unsafe authority fields");
  return url.toString();
}

function readSignature(filePath) {
  const signature = readFileSync(filePath, "utf8").trim();
  assert(signature.length >= 64 && signature.length <= 2_048, `invalid updater signature length: ${filePath}`);
  assert(/^[A-Za-z0-9+/=\r\n]+$/.test(signature), `invalid updater signature encoding: ${filePath}`);
  return signature;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function checkedAsset(filePath, signaturePath, platform) {
  assert(existsSync(filePath) && statSync(filePath).isFile(), `missing updater asset: ${filePath}`);
  assert(statSync(filePath).size > 0, `empty updater asset: ${filePath}`);
  assert(existsSync(signaturePath) && statSync(signaturePath).isFile(), `missing updater signature: ${signaturePath}`);
  return {
    platform,
    filePath,
    fileName: basename(filePath),
    size: statSync(filePath).size,
    sha256: sha256(filePath),
    signaturePath,
    signatureFileName: basename(signaturePath),
    signature: readSignature(signaturePath),
    signatureSha256: sha256(signaturePath),
  };
}

export function buildUpdaterManifest({
  version,
  notes,
  pubDate,
  repository = UPDATER_FEED_REPOSITORY,
  macBundle,
  macSignature,
  windowsBundle,
  windowsSignature,
}) {
  assertStableSemver(version);
  assert(typeof notes === "string" && notes.trim().length > 0, "release notes must not be empty");
  const published = new Date(pubDate);
  assert(!Number.isNaN(published.valueOf()), `invalid updater publication date: ${pubDate}`);

  const assets = [
    checkedAsset(macBundle, macSignature, "darwin-aarch64"),
    checkedAsset(windowsBundle, windowsSignature, "windows-x86_64"),
  ];
  const fileNames = assets.flatMap((asset) => [asset.fileName, asset.signatureFileName]);
  assert(new Set(fileNames).size === fileNames.length, "updater asset filenames must be unique");

  const platforms = Object.fromEntries(assets.map((asset) => [asset.platform, {
    signature: asset.signature,
    url: updaterAssetUrl(repository, version, asset.fileName),
  }]));

  return {
    manifest: {
      version,
      notes: notes.trim(),
      pub_date: published.toISOString(),
      platforms,
    },
    assets: assets.map(({ signature, filePath, signaturePath, ...asset }) => asset),
  };
}

export function verifyUpdaterManifest({ manifest, version, repository, signatures }) {
  assert(manifest && typeof manifest === "object", "latest.json must be an object");
  assert(manifest.version === version, `latest.json version mismatch: ${manifest.version}`);
  assertStableSemver(manifest.version);
  assert(typeof manifest.notes === "string" && manifest.notes.trim().length > 0, "latest.json notes are missing");
  assert(!Number.isNaN(new Date(manifest.pub_date).valueOf()), "latest.json pub_date is invalid");
  assert(manifest.platforms && typeof manifest.platforms === "object", "latest.json platforms are missing");
  const platformKeys = Object.keys(manifest.platforms).sort();
  assert(JSON.stringify(platformKeys) === JSON.stringify([...UPDATER_PLATFORMS].sort()), "latest.json platform set is invalid");

  const seenUrls = new Set();
  for (const platform of UPDATER_PLATFORMS) {
    const entry = manifest.platforms[platform];
    assert(entry && typeof entry === "object", `latest.json is missing ${platform}`);
    assert(typeof entry.url === "string", `${platform} URL is missing`);
    const url = new URL(entry.url);
    assert(url.toString() === updaterAssetUrl(repository, version, basename(url.pathname)), `${platform} URL is not canonical`);
    assert(!seenUrls.has(entry.url), "latest.json updater URLs must be unique");
    seenUrls.add(entry.url);
    assert(entry.signature === signatures[platform], `${platform} signature does not match its .sig file`);
  }
  return true;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  assert(value, `missing environment variable: ${name}`);
  return value;
}

function runCli() {
  const mode = process.env.UPDATER_MODE || "generate";
  const version = requiredEnv("UPDATER_VERSION");
  const repository = process.env.UPDATER_REPOSITORY?.trim() || UPDATER_FEED_REPOSITORY;
  const output = resolve(process.env.UPDATER_OUTPUT || "latest.json");
  const macSignaturePath = resolve(requiredEnv("UPDATER_MAC_SIGNATURE"));
  const windowsSignaturePath = resolve(requiredEnv("UPDATER_WINDOWS_SIGNATURE"));
  const signatures = {
    "darwin-aarch64": readSignature(macSignaturePath),
    "windows-x86_64": readSignature(windowsSignaturePath),
  };

  if (mode === "verify") {
    const manifest = JSON.parse(readFileSync(output, "utf8"));
    verifyUpdaterManifest({ manifest, version, repository, signatures });
    return;
  }

  const notes = readFileSync(resolve(requiredEnv("UPDATER_NOTES_FILE")), "utf8");
  const result = buildUpdaterManifest({
    version,
    notes,
    pubDate: requiredEnv("UPDATER_PUB_DATE"),
    repository,
    macBundle: resolve(requiredEnv("UPDATER_MAC_BUNDLE")),
    macSignature: macSignaturePath,
    windowsBundle: resolve(requiredEnv("UPDATER_WINDOWS_BUNDLE")),
    windowsSignature: windowsSignaturePath,
  });
  writeFileSync(output, `${JSON.stringify(result.manifest, null, 2)}\n`);
  const reportPath = resolve(process.env.UPDATER_ASSET_REPORT || "updater-assets.json");
  writeFileSync(reportPath, `${JSON.stringify({ version, repository, assets: result.assets }, null, 2)}\n`);
  verifyUpdaterManifest({ manifest: result.manifest, version, repository, signatures });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli();
}
