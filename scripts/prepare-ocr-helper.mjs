import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform !== "win32") {
  console.log("Windows OCR helper: skipped on this platform");
  process.exit(0);
}

const ortVersion = "1.24.2";
const ortArchiveName = `onnxruntime-win-x64-${ortVersion}.zip`;
const ortArchiveUrl = `https://github.com/microsoft/onnxruntime/releases/download/v${ortVersion}/${ortArchiveName}`;
const ortArchiveSha256 = "8e3e9c826375352e29cb2614fe44f3d7a4b0ff7b8028ad7a456af9d949a7e8b0";
const ortArchiveBytes = 74_075_355;
const helperRoot = join(root, "src-tauri", "ocr", "manga_helper");
const runtimeCache = join(helperRoot, "target", "onnxruntime-runtime");
const archivePath = join(runtimeCache, ortArchiveName);
const archivePart = `${archivePath}.part`;
const extractedRuntime = join(runtimeCache, `onnxruntime-win-x64-${ortVersion}`);
const runtimeLib = join(extractedRuntime, "lib");
const outputDir = join(root, "src-tauri", "binaries", "windows");

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function ensureRuntimeArchive() {
  mkdirSync(runtimeCache, { recursive: true });
  if (existsSync(archivePath)) {
    const archive = lstatSync(archivePath);
    if (archive.isFile() && !archive.isSymbolicLink()
      && archive.size === ortArchiveBytes
      && await sha256(archivePath) === ortArchiveSha256) return;
  }
  rmSync(archivePath, { force: true });
  rmSync(archivePart, { force: true });

  const response = await fetch(ortArchiveUrl, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`ONNX Runtime download failed: HTTP ${response.status}`);
  }
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:") {
    throw new Error(`ONNX Runtime download redirected to an insecure URL: ${response.url}`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes !== ortArchiveBytes) {
      throw new Error(`ONNX Runtime size mismatch: ${contentLength}`);
    }
  }
  let receivedBytes = 0;
  const sizeLimit = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      callback(receivedBytes > ortArchiveBytes
        ? new Error("ONNX Runtime download exceeded the pinned size")
        : null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      sizeLimit,
      createWriteStream(archivePart, { flags: "wx" }),
    );
  } catch (error) {
    rmSync(archivePart, { force: true });
    throw error;
  }
  if (receivedBytes !== ortArchiveBytes) {
    rmSync(archivePart, { force: true });
    throw new Error(`ONNX Runtime download was incomplete: ${receivedBytes}`);
  }
  const digest = await sha256(archivePart);
  if (digest !== ortArchiveSha256) {
    rmSync(archivePart, { force: true });
    throw new Error(`ONNX Runtime SHA-256 mismatch: ${digest}`);
  }
  renameSync(archivePart, archivePath);
}

function ensureRuntimeExtracted() {
  const requiredFiles = [
    join(runtimeLib, "onnxruntime.dll"),
    join(runtimeLib, "onnxruntime_providers_shared.dll"),
    join(extractedRuntime, "LICENSE"),
    join(extractedRuntime, "ThirdPartyNotices.txt"),
  ];
  const isComplete = () => requiredFiles.every((path) => {
    try {
      const file = lstatSync(path);
      return file.isFile() && !file.isSymbolicLink() && file.size > 0;
    } catch {
      return false;
    }
  });
  if (isComplete()) return;
  rmSync(extractedRuntime, { recursive: true, force: true });
  const result = spawnSync("tar", ["-xf", archivePath, "-C", runtimeCache], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Unable to extract ${ortArchiveName}`);
  if (!isComplete()) throw new Error("Extracted ONNX Runtime archive is incomplete");
}

await ensureRuntimeArchive();
ensureRuntimeExtracted();

const manifest = join(helperRoot, "Cargo.toml");
const build = spawnSync(
  "cargo",
  ["build", "--release", "--locked", "--manifest-path", manifest],
  { cwd: root, stdio: "inherit" },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const releaseDir = join(helperRoot, "target", "release");
mkdirSync(outputDir, { recursive: true });

function copyRequired(source, name) {
  const stat = statSync(source);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Windows OCR dependency is invalid: ${source}`);
  }
  copyFileSync(source, join(outputDir, name));
}

copyRequired(join(releaseDir, "manga_ocr_helper.exe"), "manga_ocr_helper.exe");
copyRequired(join(runtimeLib, "onnxruntime.dll"), "onnxruntime.dll");
copyRequired(join(runtimeLib, "onnxruntime_providers_shared.dll"), "onnxruntime_providers_shared.dll");
copyRequired(join(extractedRuntime, "LICENSE"), "onnxruntime-LICENSE.txt");
copyRequired(join(extractedRuntime, "ThirdPartyNotices.txt"), "onnxruntime-ThirdPartyNotices.txt");

const crtNames = [
  "MSVCP140.dll",
  "MSVCP140_1.dll",
  "VCRUNTIME140.dll",
  "VCRUNTIME140_1.dll",
];

function existingCrtDirectory(base) {
  if (!base) return null;
  const x64Directory = join(base, "x64");
  let runtimeDirectories = [];
  try {
    runtimeDirectories = readdirSync(x64Directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^Microsoft\.VC\d+\.CRT$/i.test(entry.name))
      .map((entry) => join(x64Directory, entry.name))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {}
  return runtimeDirectories.find((directory) => crtNames.every((name) => {
    try {
      return statSync(join(directory, name)).isFile();
    } catch {
      return false;
    }
  })) ?? null;
}

function newestCrtDirectory() {
  const fromEnvironment = existingCrtDirectory(process.env.VCToolsRedistDir);
  if (fromEnvironment) return fromEnvironment;

  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const visualStudioRoot = join(programFiles, "Microsoft Visual Studio");
  let releases = [];
  try {
    releases = readdirSync(visualStudioRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {}

  const candidates = [];
  for (const release of releases) {
    const releaseRoot = join(visualStudioRoot, release);
    let editions = [];
    try {
      editions = readdirSync(releaseRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {}
    for (const edition of editions) {
      const redistRoot = join(releaseRoot, edition, "VC", "Redist", "MSVC");
      let versions = [];
      try {
        versions = readdirSync(redistRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
      } catch {}
      for (const version of versions) {
        const directory = existingCrtDirectory(join(redistRoot, version));
        if (directory) candidates.push(directory);
      }
    }
  }
  return candidates[0] ?? null;
}

const crtDirectory = newestCrtDirectory();
if (!crtDirectory) {
  throw new Error("Microsoft VC++ x64 redistributable files were not found in Visual Studio Build Tools");
}
for (const name of crtNames) copyRequired(join(crtDirectory, name), name);

const packaged = [
  "manga_ocr_helper.exe",
  "onnxruntime.dll",
  "onnxruntime_providers_shared.dll",
  ...crtNames,
]
  .map((name) => `${name}=${statSync(join(outputDir, name)).size}`)
  .join(", ");
console.log(`Windows OCR helper prepared: ${packaged}`);
