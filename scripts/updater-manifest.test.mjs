import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildUpdaterManifest,
  UPDATER_FEED_REPOSITORY,
  verifyUpdaterManifest,
} from "./updater-manifest.mjs";

function fixture() {
  const dir = join(tmpdir(), `wnacg-updater-test-${crypto.randomUUID()}`);
  fixtureDirectories.add(dir);
  mkdirSync(dir, { recursive: false });
  const macBundle = join(dir, "wnacg.app.tar.gz");
  const macSignature = `${macBundle}.sig`;
  const windowsBundle = join(dir, "wnacg_0.1.11_x64-setup.exe");
  const windowsSignature = `${windowsBundle}.sig`;
  writeFileSync(macBundle, "mac updater");
  writeFileSync(windowsBundle, "windows updater");
  writeFileSync(macSignature, "A".repeat(96));
  writeFileSync(windowsSignature, "B".repeat(96));
  return { macBundle, macSignature, windowsBundle, windowsSignature };
}

const fixtureDirectories = new Set();

afterAll(() => {
  for (const dir of fixtureDirectories) rmSync(dir, { recursive: true, force: true });
});

describe("updater manifest", () => {
  it("builds the exact signed platform map and SHA-256 audit report", () => {
    const files = fixture();
    const result = buildUpdaterManifest({
      version: "0.1.11",
      notes: "Manual bootstrap install required.",
      pubDate: "2026-09-02T00:00:00Z",
      ...files,
    });
    expect(result.manifest.platforms["darwin-aarch64"].url).toBe(
      "https://github.com/yuxino/wnacg/releases/download/v0.1.11/wnacg.app.tar.gz",
    );
    expect(result.manifest.platforms["windows-x86_64"].signature).toBe("B".repeat(96));
    expect(result.assets.every((asset) => /^[a-f0-9]{64}$/.test(asset.sha256))).toBe(true);
  });

  it("rejects a signature that does not match its .sig file", () => {
    const files = fixture();
    const result = buildUpdaterManifest({
      version: "0.1.11",
      notes: "notes",
      pubDate: "2026-09-02T00:00:00Z",
      ...files,
    });
    result.manifest.platforms["darwin-aarch64"].signature = "C".repeat(96);
    expect(() => verifyUpdaterManifest({
      manifest: result.manifest,
      version: "0.1.11",
      repository: UPDATER_FEED_REPOSITORY,
      signatures: {
        "darwin-aarch64": "A".repeat(96),
        "windows-x86_64": "B".repeat(96),
      },
    })).toThrow(/signature does not match/);
  });

  it("rejects prerelease versions and unapproved repositories", () => {
    const files = fixture();
    expect(() => buildUpdaterManifest({
      version: "0.1.11-beta.1",
      notes: "notes",
      pubDate: "2026-09-02T00:00:00Z",
      ...files,
    })).toThrow(/stable SemVer/);
    expect(() => buildUpdaterManifest({
      version: "0.1.11",
      notes: "notes",
      pubDate: "2026-09-02T00:00:00Z",
      repository: "someone/wnacg",
      ...files,
    })).toThrow(/unexpected updater repository/);
  });

  it("rejects duplicate updater filenames", () => {
    const files = fixture();
    expect(() => buildUpdaterManifest({
      version: "0.1.11",
      notes: "notes",
      pubDate: "2026-09-02T00:00:00Z",
      ...files,
      windowsBundle: files.macBundle,
      windowsSignature: files.macSignature,
    })).toThrow(/filenames must be unique/);
  });
});
