#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { inflateSync } from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconDir = join(repoRoot, "src-tauri", "icons", "kiri");
const sourceIcon = join(repoRoot, "docs", "brand", "kiri", "kiri-app-icon-source.png");
const publicIcon = join(repoRoot, "public", "brand", "kiri-icon-128.png");
const manifestPath = join(iconDir, "icon-manifest.json");
const desktopPngs = [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
];
const desktopPngNames = desktopPngs.map(([name]) => name);
const generatedNames = [...desktopPngNames, "icon.icns", "icon.ico"];
const manifestAssets = [
  ...generatedNames.map((name) => [`src-tauri/icons/kiri/${name}`, join(iconDir, name)]),
  ["public/brand/kiri-icon-128.png", publicIcon],
];
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fail(message) {
  throw new Error(message);
}

function readUInt32BE(buffer, offset, label) {
  if (offset + 4 > buffer.length) fail(`${label}: truncated 32-bit value`);
  return buffer.readUInt32BE(offset);
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodePngAlpha(buffer, label) {
  if (!buffer.subarray(0, 8).equals(pngSignature)) fail(`${label}: not a PNG`);

  let offset = 8;
  let header;
  const compressedParts = [];
  while (offset + 12 <= buffer.length) {
    const length = readUInt32BE(buffer, offset, label);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) fail(`${label}: truncated ${type} chunk`);

    if (type === "IHDR") {
      header = {
        width: readUInt32BE(buffer, dataStart, label),
        height: readUInt32BE(buffer, dataStart + 4, label),
        bitDepth: buffer[dataStart + 8],
        colorType: buffer[dataStart + 9],
        interlace: buffer[dataStart + 12],
      };
    } else if (type === "IDAT") {
      compressedParts.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (!header) fail(`${label}: missing IHDR`);
  if (header.width !== header.height || header.width === 0) {
    fail(`${label}: app icons must be non-empty squares`);
  }
  if (header.bitDepth !== 8 || header.colorType !== 6 || header.interlace !== 0) {
    fail(`${label}: expected a non-interlaced 8-bit RGBA PNG`);
  }
  if (compressedParts.length === 0) fail(`${label}: missing image data`);

  const bytesPerPixel = header.colorType === 6 ? 4 : 2;
  const alphaOffset = bytesPerPixel - 1;
  const stride = header.width * bytesPerPixel;
  const filtered = inflateSync(Buffer.concat(compressedParts));
  if (filtered.length !== (stride + 1) * header.height) {
    fail(`${label}: unexpected decompressed image size`);
  }

  const alpha = new Uint8Array(header.width * header.height);
  let inputOffset = 0;
  let previous = new Uint8Array(stride);
  for (let y = 0; y < header.height; y += 1) {
    const filter = filtered[inputOffset];
    inputOffset += 1;
    if (filter > 4) fail(`${label}: unsupported PNG filter ${filter}`);
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const encoded = filtered[inputOffset];
      inputOffset += 1;
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const above = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      else if (filter === 2) prediction = above;
      else if (filter === 3) prediction = Math.floor((left + above) / 2);
      else if (filter === 4) prediction = paethPredictor(left, above, upperLeft);
      row[x] = (encoded + prediction) & 0xff;
    }
    for (let x = 0; x < header.width; x += 1) {
      alpha[y * header.width + x] = row[x * bytesPerPixel + alphaOffset];
    }
    previous = row;
  }

  return { width: header.width, height: header.height, alpha };
}

function validateAlpha({ width, height, alpha }, label) {
  const corners = [0, width - 1, (height - 1) * width, width * height - 1];
  if (corners.some((index) => alpha[index] > 8)) {
    fail(`${label}: all four corner pixels must be transparent`);
  }

  let transparent = 0;
  let translucent = 0;
  let opaque = 0;
  let visibleMinX = width;
  let visibleMinY = height;
  let visibleMaxX = -1;
  let visibleMaxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = alpha[y * width + x];
      if (value <= 8) {
        transparent += 1;
        continue;
      }

      visibleMinX = Math.min(visibleMinX, x);
      visibleMinY = Math.min(visibleMinY, y);
      visibleMaxX = Math.max(visibleMaxX, x);
      visibleMaxY = Math.max(visibleMaxY, y);
      if (value === 255) opaque += 1;
      else translucent += 1;
    }
  }
  const pixels = alpha.length;
  if (transparent / pixels < 0.05) {
    fail(`${label}: transparent padding is too small to prevent a square icon`);
  }
  if (opaque / pixels < 0.4) fail(`${label}: visible icon content is unexpectedly sparse`);
  if (translucent === 0) fail(`${label}: rounded edge is missing anti-aliasing`);

  const visibleWidth = visibleMaxX - visibleMinX + 1;
  const visibleHeight = visibleMaxY - visibleMinY + 1;
  const [minimumVisibleRatio, maximumVisibleRatio] =
    width >= 64 ? [0.78, 0.84] : width >= 32 ? [0.75, 0.86] : [0.7, 0.9];
  for (const [axis, visibleSize, canvasSize] of [
    ["width", visibleWidth, width],
    ["height", visibleHeight, height],
  ]) {
    const ratio = visibleSize / canvasSize;
    if (ratio < minimumVisibleRatio || ratio > maximumVisibleRatio) {
      fail(
        `${label}: visible ${axis} must occupy ${Math.round(minimumVisibleRatio * 100)}-` +
          `${Math.round(maximumVisibleRatio * 100)}% of the canvas, got ${Math.round(ratio * 100)}%`,
      );
    }
  }

  const center = Math.floor(height / 2) * width + Math.floor(width / 2);
  if (alpha[center] < 250) fail(`${label}: center must remain visible`);

  const cornerSize = Math.max(1, Math.floor(width * 0.03));
  let cornerPixels = 0;
  let clearCornerPixels = 0;
  for (let y = 0; y < cornerSize; y += 1) {
    for (let x = 0; x < cornerSize; x += 1) {
      for (const index of [
        y * width + x,
        y * width + (width - 1 - x),
        (height - 1 - y) * width + x,
        (height - 1 - y) * width + (width - 1 - x),
      ]) {
        cornerPixels += 1;
        if (alpha[index] <= 8) clearCornerPixels += 1;
      }
    }
  }
  if (clearCornerPixels / cornerPixels < 0.95) {
    fail(`${label}: outer corner areas must remain transparent`);
  }

  const sample = (x, y) => {
    const pixelX = Math.round((width - 1) * x);
    const pixelY = Math.round((height - 1) * y);
    return alpha[pixelY * width + pixelX];
  };
  const outerEdges = [
    [0.5, 0.03],
    [0.97, 0.5],
    [0.5, 0.97],
    [0.03, 0.5],
  ];
  const innerEdges = [
    [0.5, 0.12],
    [0.88, 0.5],
    [0.5, 0.88],
    [0.12, 0.5],
  ];
  const roundedCorners = [
    [0.08, 0.08],
    [0.92, 0.08],
    [0.92, 0.92],
    [0.08, 0.92],
  ];
  const innerCorners = [
    [0.18, 0.18],
    [0.82, 0.18],
    [0.82, 0.82],
    [0.18, 0.82],
  ];
  const outerEdgeLimit = width < 32 ? 224 : 128;
  if (outerEdges.some(([x, y]) => sample(x, y) > outerEdgeLimit)) {
    fail(`${label}: transparent padding is missing around the icon`);
  }
  if (roundedCorners.some(([x, y]) => sample(x, y) > 64)) {
    fail(`${label}: expected a transparent rounded-square outline, not a hard square`);
  }
  if ([...innerEdges, ...innerCorners].some(([x, y]) => sample(x, y) < 200)) {
    fail(`${label}: rounded-square silhouette is clipped or too small`);
  }
}

function validatePng(buffer, label, expectedSize) {
  const decoded = decodePngAlpha(buffer, label);
  if (expectedSize && decoded.width !== expectedSize) {
    fail(`${label}: expected ${expectedSize}x${expectedSize}, got ${decoded.width}x${decoded.height}`);
  }
  validateAlpha(decoded, label);
  return decoded.width;
}

function hasStandardSrgbChunk(buffer, label) {
  if (!buffer.subarray(0, 8).equals(pngSignature)) fail(`${label}: not a PNG`);
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = readUInt32BE(buffer, offset, label);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "sRGB") return true;
    const next = offset + 12 + length;
    if (next > buffer.length) fail(`${label}: truncated ${type} chunk`);
    if (type === "IEND") break;
    offset = next;
  }
  return false;
}

function validateIcns(path) {
  const buffer = readFileSync(path);
  if (buffer.toString("ascii", 0, 4) !== "icns") fail("icon.icns: invalid header");
  if (readUInt32BE(buffer, 4, "icon.icns") !== buffer.length) {
    fail("icon.icns: declared size does not match file size");
  }

  const sizes = new Set();
  const types = new Set();
  const expectedPngSizes = new Map([
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
    ["ic11", 32],
    ["ic12", 64],
    ["ic13", 256],
    ["ic14", 512],
  ]);
  const expectedMaskSizes = new Map([
    ["s8mk", 16],
    ["l8mk", 32],
  ]);
  let offset = 8;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) fail("icon.icns: truncated entry header");
    const type = buffer.toString("ascii", offset, offset + 4);
    const length = readUInt32BE(buffer, offset + 4, "icon.icns");
    if (length < 8 || offset + length > buffer.length) fail(`icon.icns: invalid ${type} entry`);
    if (types.has(type)) fail(`icon.icns: duplicate ${type} entry`);
    types.add(type);
    const payload = buffer.subarray(offset + 8, offset + length);
    const isPng = payload.subarray(0, 8).equals(pngSignature);
    if (expectedPngSizes.has(type) && !isPng) {
      fail(`icon.icns:${type}: expected a PNG payload`);
    }
    if (isPng) {
      const size = validatePng(payload, `icon.icns:${type}`, expectedPngSizes.get(type));
      sizes.add(size);
    } else if (["s8mk", "l8mk", "h8mk", "t8mk"].includes(type)) {
      const size = Math.sqrt(payload.length);
      if (!Number.isInteger(size)) fail(`icon.icns:${type}: invalid alpha mask`);
      const expectedSize = expectedMaskSizes.get(type);
      if (expectedSize && size !== expectedSize) {
        fail(`icon.icns:${type}: expected ${expectedSize}x${expectedSize}, got ${size}x${size}`);
      }
      validateAlpha({ width: size, height: size, alpha: payload }, `icon.icns:${type}`);
      sizes.add(size);
    }
    offset += length;
  }

  for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
    if (!sizes.has(size)) fail(`icon.icns: missing ${size}x${size} representation`);
  }
  for (const type of ["is32", "s8mk", "il32", "l8mk", ...expectedPngSizes.keys()]) {
    if (!types.has(type)) fail(`icon.icns: missing required ${type} entry`);
  }
}

function canonicalizeIcns(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "icns") fail("generated icon.icns: invalid header");
  const entries = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = readUInt32BE(buffer, offset + 4, "generated icon.icns");
    if (length < 8 || offset + length > buffer.length) fail("generated icon.icns: invalid entry");
    entries.push(buffer.subarray(offset, offset + length));
    offset += length;
  }
  entries.sort((left, right) => Buffer.compare(left, right));
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + entries.reduce((total, entry) => total + entry.length, 0), 4);
  return Buffer.concat([header, ...entries]);
}

function validateIco(path) {
  const buffer = readFileSync(path);
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    fail("icon.ico: invalid header");
  }
  const count = buffer.readUInt16LE(4);
  if (count === 0 || 6 + count * 16 > buffer.length) fail("icon.ico: invalid directory");

  const sizes = new Set();
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = buffer[entry] || 256;
    const height = buffer[entry + 1] || 256;
    const length = buffer.readUInt32LE(entry + 8);
    const offset = buffer.readUInt32LE(entry + 12);
    if (width !== height || offset + length > buffer.length) fail("icon.ico: invalid image entry");
    const payload = buffer.subarray(offset, offset + length);
    const decodedSize = validatePng(payload, `icon.ico:${width}x${height}`, width);
    sizes.add(decodedSize);
  }

  for (const size of [16, 24, 32, 48, 64, 256]) {
    if (!sizes.has(size)) fail(`icon.ico: missing ${size}x${size} representation`);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function expectedManifest() {
  return {
    version: 1,
    source: "docs/brand/kiri/kiri-app-icon-source.png",
    sourceSha256: sha256(sourceIcon),
    assets: Object.fromEntries(manifestAssets.map(([name, path]) => [name, sha256(path)])),
  };
}

function writeManifest() {
  writeFileSync(manifestPath, `${JSON.stringify(expectedManifest(), null, 2)}\n`);
}

function verifyManifest() {
  if (!existsSync(manifestPath)) fail("icon-manifest.json: missing generated asset manifest");
  let actual;
  try {
    actual = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    fail("icon-manifest.json: invalid JSON");
  }
  const expected = expectedManifest();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("icon assets do not match their source manifest; run npm run icons:generate");
  }
}

function verifyIcons() {
  const sourceBuffer = readFileSync(sourceIcon);
  const sourceSize = validatePng(sourceBuffer, "app-icon-source.png");
  if (sourceSize < 1024) fail("app-icon-source.png: master icon must be at least 1024x1024");
  if (!hasStandardSrgbChunk(sourceBuffer, "app-icon-source.png")) {
    fail("app-icon-source.png: master icon must contain a standard PNG sRGB chunk");
  }
  for (const [name, expectedSize] of desktopPngs) {
    const path = join(iconDir, name);
    if (!existsSync(path)) fail(`${name}: missing generated icon`);
    validatePng(readFileSync(path), name, expectedSize);
  }
  validateIcns(join(iconDir, "icon.icns"));
  validateIco(join(iconDir, "icon.ico"));
  if (!existsSync(publicIcon)) fail("public/brand/kiri-icon-128.png: missing public icon");
  validatePng(readFileSync(publicIcon), "public/brand/kiri-icon-128.png", 128);
  if (!readFileSync(publicIcon).equals(readFileSync(join(iconDir, "128x128.png")))) {
    fail("public/brand/kiri-icon-128.png must match the generated 128x128 desktop icon");
  }

  const config = JSON.parse(readFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"));
  const configured = config.bundle?.icon;
  const expectedConfigured = [
    "icons/kiri/32x32.png",
    "icons/kiri/128x128.png",
    "icons/kiri/128x128@2x.png",
    "icons/kiri/icon.icns",
    "icons/kiri/icon.ico",
  ];
  if (!Array.isArray(configured) || JSON.stringify(configured) !== JSON.stringify(expectedConfigured)) {
    fail("tauri.conf.json: bundle.icon must use the verified desktop icon set in canonical order");
  }
  for (const relativePath of configured) {
    if (!existsSync(join(repoRoot, "src-tauri", relativePath))) {
      fail(`tauri.conf.json: missing configured icon ${relativePath}`);
    }
  }
  verifyManifest();

  console.log(
    "WNACG app icon verification passed: the source, public copy, PNG, ICNS, and ICO assets are synchronized and structurally valid.",
  );
}

function generateIcons() {
  const temporaryOutput = mkdtempSync(join(tmpdir(), "wnacg-app-icons-"));
  try {
    const sourceBuffer = readFileSync(sourceIcon);
    const sourceSize = validatePng(sourceBuffer, "app-icon-source.png");
    if (sourceSize < 1024) fail("app-icon-source.png: master icon must be at least 1024x1024");
    if (!hasStandardSrgbChunk(sourceBuffer, "app-icon-source.png")) {
      fail("app-icon-source.png: master icon must contain a standard PNG sRGB chunk");
    }

    const cli = join(repoRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
    if (!existsSync(cli)) fail("Tauri CLI is not installed; run npm install first");
    const result = spawnSync(process.execPath, [cli, "icon", sourceIcon, "--output", temporaryOutput], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) fail(`Tauri icon generator exited with status ${result.status}`);

    for (const name of generatedNames) {
      const generated = join(temporaryOutput, name);
      if (!existsSync(generated)) fail(`Tauri icon generator did not create ${name}`);
      if (name === "icon.icns") {
        writeFileSync(generated, canonicalizeIcns(readFileSync(generated)));
      }
    }
    for (const [name, expectedSize] of desktopPngs) {
      validatePng(readFileSync(join(temporaryOutput, name)), `generated:${name}`, expectedSize);
    }
    validateIcns(join(temporaryOutput, "icon.icns"));
    validateIco(join(temporaryOutput, "icon.ico"));

    for (const name of generatedNames) {
      copyFileSync(join(temporaryOutput, name), join(iconDir, name));
    }
    copyFileSync(join(iconDir, "128x128.png"), publicIcon);
    writeManifest();
  } finally {
    rmSync(temporaryOutput, { recursive: true, force: true });
  }
  verifyIcons();
}

const command = process.argv[2] ?? "verify";
try {
  if (command === "generate") generateIcons();
  else if (command === "verify") verifyIcons();
  else fail(`unknown command ${command}; use generate or verify`);
} catch (error) {
  console.error(`App icon check failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
