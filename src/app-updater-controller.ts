export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "installing"
  | "restart-ready"
  | "windows-installing"
  | "check-error"
  | "download-error"
  | "install-error"
  | "relaunch-error";

export type AppDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export type AppUpdateSnapshot = {
  phase: AppUpdatePhase;
  currentVersion: string;
  latestVersion: string | null;
  notes: string;
  publishedAt: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  errorMessage: string | null;
};

export type AppUpdateHandle = {
  version: string;
  body?: string;
  date?: string;
  download: (onEvent?: (event: AppDownloadEvent) => void) => Promise<void>;
  install: (options?: { restartAfterInstall?: boolean }) => Promise<void>;
  close: () => Promise<void>;
};

export type AppUpdaterBackend = {
  currentVersion: () => Promise<string>;
  check: () => Promise<AppUpdateHandle | null>;
  relaunch: () => Promise<void>;
  isWindows: () => boolean;
};

type SnapshotListener = (snapshot: AppUpdateSnapshot) => void;

const BUSY_PHASES = new Set<AppUpdatePhase>([
  "checking",
  "downloading",
  "installing",
  "windows-installing",
]);

function cleanVersion(value: string) {
  return value.trim().replace(/^[vV]/, "");
}

function cleanNotes(value: string | undefined) {
  return (value || "").trim().slice(0, 4_000);
}

function safeUpdateError(error: unknown, phase: "check" | "download" | "install" | "relaunch") {
  const detail = error instanceof Error ? error.message : String(error);
  const normalized = detail.toLowerCase();
  if (normalized.includes("signature") || normalized.includes("minisign") || normalized.includes("public key")) {
    return "更新签名校验失败，未安装任何文件";
  }
  if (
    normalized.includes("404")
    || normalized.includes("network")
    || normalized.includes("connect")
    || normalized.includes("fetch")
    || normalized.includes("http")
  ) {
    return "更新源不可访问，请稍后重试";
  }
  return {
    check: "检查更新失败，请稍后重试",
    download: "更新下载失败，未安装任何文件",
    install: "更新安装失败，未替换当前版本",
    relaunch: "更新已安装，但重新启动失败",
  }[phase];
}

export function initialAppUpdateSnapshot(): AppUpdateSnapshot {
  return {
    phase: "idle",
    currentVersion: "",
    latestVersion: null,
    notes: "",
    publishedAt: null,
    downloadedBytes: 0,
    totalBytes: null,
    percent: null,
    errorMessage: null,
  };
}

export function isAppUpdateSnapshot(value: unknown): value is AppUpdateSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<AppUpdateSnapshot>;
  return typeof snapshot.phase === "string"
    && [
      "idle", "checking", "current", "available", "downloading", "installing",
      "restart-ready", "windows-installing", "check-error", "download-error",
      "install-error", "relaunch-error",
    ].includes(snapshot.phase)
    && typeof snapshot.currentVersion === "string"
    && (typeof snapshot.latestVersion === "string" || snapshot.latestVersion === null)
    && typeof snapshot.notes === "string"
    && (typeof snapshot.publishedAt === "string" || snapshot.publishedAt === null)
    && typeof snapshot.downloadedBytes === "number"
    && (typeof snapshot.totalBytes === "number" || snapshot.totalBytes === null)
    && (typeof snapshot.percent === "number" || snapshot.percent === null)
    && (typeof snapshot.errorMessage === "string" || snapshot.errorMessage === null);
}

export function isAppUpdateBusy(phase: AppUpdatePhase) {
  return BUSY_PHASES.has(phase);
}

export class AppUpdaterController {
  private snapshot = initialAppUpdateSnapshot();
  private listeners = new Set<SnapshotListener>();
  private pendingUpdate: AppUpdateHandle | null = null;
  private operation: Promise<void> | null = null;

  constructor(private readonly backend: AppUpdaterBackend) {}

  getSnapshot() {
    return { ...this.snapshot };
  }

  subscribe(listener: SnapshotListener) {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  applyRemoteSnapshot(snapshot: AppUpdateSnapshot) {
    if (this.operation || isAppUpdateBusy(this.snapshot.phase)) return;
    this.snapshot = { ...snapshot };
    this.publish();
  }

  async loadCurrentVersion() {
    try {
      const currentVersion = cleanVersion(await this.backend.currentVersion());
      if (currentVersion) this.setSnapshot({ currentVersion });
    } catch {
      // The updater check also carries the current version. Browsing must not
      // fail when version metadata is unavailable outside the Tauri shell.
    }
  }

  checkForUpdate() {
    return this.run(async () => {
      await this.closePendingUpdate();
      this.setSnapshot({
        phase: "checking",
        latestVersion: null,
        notes: "",
        publishedAt: null,
        downloadedBytes: 0,
        totalBytes: null,
        percent: null,
        errorMessage: null,
      });
      try {
        const currentVersion = cleanVersion(await this.backend.currentVersion());
        const update = await this.backend.check();
        if (!update) {
          this.setSnapshot({ phase: "current", currentVersion });
          return;
        }
        this.pendingUpdate = update;
        this.setSnapshot({
          phase: "available",
          currentVersion,
          latestVersion: cleanVersion(update.version),
          notes: cleanNotes(update.body),
          publishedAt: update.date || null,
        });
      } catch (error) {
        this.setSnapshot({
          phase: "check-error",
          errorMessage: safeUpdateError(error, "check"),
        });
      }
    });
  }

  downloadAndInstall() {
    return this.run(async () => {
      let update = this.pendingUpdate;
      if (!update) {
        try {
          update = await this.backend.check();
        } catch (error) {
          this.setSnapshot({
            phase: "check-error",
            errorMessage: safeUpdateError(error, "check"),
          });
          return;
        }
        if (!update) {
          this.setSnapshot({ phase: "current", latestVersion: null, notes: "" });
          return;
        }
        this.pendingUpdate = update;
        this.setSnapshot({
          latestVersion: cleanVersion(update.version),
          notes: cleanNotes(update.body),
          publishedAt: update.date || null,
        });
      }

      this.setSnapshot({
        phase: "downloading",
        downloadedBytes: 0,
        totalBytes: null,
        percent: null,
        errorMessage: null,
      });
      try {
        await update.download((event) => this.onDownloadEvent(event));
      } catch (error) {
        this.setSnapshot({
          phase: "download-error",
          errorMessage: safeUpdateError(error, "download"),
        });
        return;
      }

      this.setSnapshot({ phase: "installing", percent: 100 });
      try {
        await update.install({ restartAfterInstall: false });
      } catch (error) {
        this.setSnapshot({
          phase: "install-error",
          errorMessage: safeUpdateError(error, "install"),
        });
        return;
      }

      if (this.backend.isWindows()) {
        this.setSnapshot({ phase: "windows-installing" });
      } else {
        this.setSnapshot({ phase: "restart-ready" });
      }
    });
  }

  dismissAvailableUpdate() {
    return this.run(async () => {
      if (this.snapshot.phase !== "available") return;
      await this.closePendingUpdate();
      this.setSnapshot({
        phase: "idle",
        latestVersion: null,
        notes: "",
        publishedAt: null,
      });
    });
  }

  relaunchAfterUpdate() {
    return this.run(async () => {
      if (this.snapshot.phase !== "restart-ready") return;
      try {
        await this.backend.relaunch();
      } catch (error) {
        this.setSnapshot({
          phase: "relaunch-error",
          errorMessage: safeUpdateError(error, "relaunch"),
        });
      }
    });
  }

  retry() {
    return this.checkForUpdate();
  }

  private run(task: () => Promise<void>) {
    if (this.operation) return this.operation;
    this.operation = task().finally(() => {
      this.operation = null;
    });
    return this.operation;
  }

  private async closePendingUpdate() {
    const update = this.pendingUpdate;
    this.pendingUpdate = null;
    if (update) await update.close().catch(() => {});
  }

  private onDownloadEvent(event: AppDownloadEvent) {
    if (event.event === "Started") {
      const total = event.data.contentLength;
      const totalBytes = Number.isFinite(total) && Number(total) > 0 ? Number(total) : null;
      this.setSnapshot({ totalBytes, percent: totalBytes ? 0 : null });
      return;
    }
    if (event.event === "Progress") {
      const chunkLength = Number.isFinite(event.data.chunkLength)
        ? Math.max(0, event.data.chunkLength)
        : 0;
      const downloadedBytes = this.snapshot.downloadedBytes + chunkLength;
      const percent = this.snapshot.totalBytes
        ? Math.min(100, Math.floor((downloadedBytes * 100) / this.snapshot.totalBytes))
        : null;
      this.setSnapshot({ downloadedBytes, percent });
      return;
    }
    if (event.event === "Finished") {
      this.setSnapshot({
        downloadedBytes: this.snapshot.totalBytes || this.snapshot.downloadedBytes,
        percent: this.snapshot.totalBytes ? 100 : null,
      });
    }
  }

  private setSnapshot(next: Partial<AppUpdateSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    this.publish();
  }

  private publish() {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
