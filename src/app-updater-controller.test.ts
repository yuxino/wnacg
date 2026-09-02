import { describe, expect, it, vi } from "vitest";
import {
  AppUpdaterController,
  type AppUpdateHandle,
  type AppUpdateSnapshot,
  type AppUpdaterBackend,
} from "./app-updater-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function updateHandle(overrides: Partial<AppUpdateHandle> = {}): AppUpdateHandle {
  return {
    version: "0.1.11",
    body: "Bootstrap updater release",
    date: "2026-09-02T00:00:00Z",
    download: vi.fn(async (onEvent) => {
      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 40 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 60 } });
      onEvent?.({ event: "Finished" });
    }),
    install: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function backend(overrides: Partial<AppUpdaterBackend> = {}): AppUpdaterBackend {
  return {
    currentVersion: vi.fn(async () => "0.1.10"),
    check: vi.fn(async () => null),
    relaunch: vi.fn(async () => {}),
    isWindows: () => false,
    ...overrides,
  };
}

describe("AppUpdaterController", () => {
  it("reports the current version when no update exists", async () => {
    const controller = new AppUpdaterController(backend());
    await controller.checkForUpdate();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "current",
      currentVersion: "0.1.10",
      latestVersion: null,
    });
  });

  it("shows version and bounded release notes before downloading", async () => {
    const update = updateHandle({ body: "x".repeat(5_000) });
    const controller = new AppUpdaterController(backend({ check: vi.fn(async () => update) }));
    await controller.checkForUpdate();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "available",
      latestVersion: "0.1.11",
      publishedAt: "2026-09-02T00:00:00Z",
    });
    expect(controller.getSnapshot().notes).toHaveLength(4_000);
  });

  it("uses real determinate progress and waits for an explicit relaunch on macOS", async () => {
    const update = updateHandle();
    const snapshots: AppUpdateSnapshot[] = [];
    const updaterBackend = backend({ check: vi.fn(async () => update) });
    const controller = new AppUpdaterController(updaterBackend);
    controller.subscribe((snapshot) => snapshots.push(snapshot));
    await controller.checkForUpdate();
    await controller.downloadAndInstall();

    expect(snapshots).toContainEqual(expect.objectContaining({
      phase: "downloading",
      downloadedBytes: 40,
      totalBytes: 100,
      percent: 40,
    }));
    expect(update.install).toHaveBeenCalledWith({ restartAfterInstall: false });
    expect(controller.getSnapshot().phase).toBe("restart-ready");
    expect(updaterBackend.relaunch).not.toHaveBeenCalled();
    await controller.relaunchAfterUpdate();
    expect(updaterBackend.relaunch).toHaveBeenCalledOnce();
  });

  it("keeps progress indeterminate when the server omits content length", async () => {
    const update = updateHandle({
      download: vi.fn(async (onEvent) => {
        onEvent?.({ event: "Started", data: {} });
        onEvent?.({ event: "Progress", data: { chunkLength: 2_048 } });
        onEvent?.({ event: "Finished" });
      }),
    });
    const snapshots: AppUpdateSnapshot[] = [];
    const controller = new AppUpdaterController(backend({ check: vi.fn(async () => update) }));
    controller.subscribe((snapshot) => snapshots.push(snapshot));
    await controller.checkForUpdate();
    await controller.downloadAndInstall();
    expect(snapshots).toContainEqual(expect.objectContaining({
      phase: "downloading",
      downloadedBytes: 2_048,
      totalBytes: null,
      percent: null,
    }));
  });

  it("never installs after a signature failure and allows a fresh retry", async () => {
    const broken = updateHandle({
      download: vi.fn(async () => {
        throw new Error("minisign signature verification failed");
      }),
    });
    const recovered = updateHandle();
    const check = vi.fn()
      .mockResolvedValueOnce(broken)
      .mockResolvedValueOnce(recovered);
    const controller = new AppUpdaterController(backend({ check }));
    await controller.checkForUpdate();
    await controller.downloadAndInstall();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "download-error",
      errorMessage: "更新签名校验失败，未安装任何文件",
    });
    expect(broken.install).not.toHaveBeenCalled();
    await controller.retry();
    expect(controller.getSnapshot().phase).toBe("available");
  });

  it("reports an inaccessible feed without exposing raw server detail", async () => {
    const controller = new AppUpdaterController(backend({
      check: vi.fn(async () => {
        throw new Error("HTTP 404 at private endpoint");
      }),
    }));
    await controller.checkForUpdate();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "check-error",
      errorMessage: "更新源不可访问，请稍后重试",
    });
  });

  it("protects against duplicate checks", async () => {
    const pending = deferred<AppUpdateHandle | null>();
    const check = vi.fn(() => pending.promise);
    const controller = new AppUpdaterController(backend({ check }));
    const first = controller.checkForUpdate();
    const second = controller.checkForUpdate();
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
    pending.resolve(null);
    await Promise.all([first, second]);
  });

  it("can postpone an available update without downloading it", async () => {
    const update = updateHandle();
    const controller = new AppUpdaterController(backend({ check: vi.fn(async () => update) }));
    await controller.checkForUpdate();
    await controller.dismissAvailableUpdate();
    expect(controller.getSnapshot().phase).toBe("idle");
    expect(update.close).toHaveBeenCalledOnce();
    expect(update.download).not.toHaveBeenCalled();
  });

  it("describes the Windows installer handoff without promising a relaunch", async () => {
    const update = updateHandle();
    const updaterBackend = backend({
      check: vi.fn(async () => update),
      isWindows: () => true,
    });
    const controller = new AppUpdaterController(updaterBackend);
    await controller.checkForUpdate();
    await controller.downloadAndInstall();
    expect(controller.getSnapshot().phase).toBe("windows-installing");
    expect(update.install).toHaveBeenCalledWith({ restartAfterInstall: false });
    expect(updaterBackend.relaunch).not.toHaveBeenCalled();
  });

  it("rechecks before downloading a remote available state without a local handle", async () => {
    const update = updateHandle();
    const check = vi.fn(async () => update);
    const controller = new AppUpdaterController(backend({ check }));
    controller.applyRemoteSnapshot({
      phase: "available",
      currentVersion: "0.1.10",
      latestVersion: "0.1.11",
      notes: "remote",
      publishedAt: null,
      downloadedBytes: 0,
      totalBytes: null,
      percent: null,
      errorMessage: null,
    });
    await controller.downloadAndInstall();
    expect(check).toHaveBeenCalledOnce();
    expect(update.download).toHaveBeenCalledOnce();
  });
});
