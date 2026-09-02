import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import {
  AppUpdaterController,
  type AppDownloadEvent,
  type AppUpdateHandle,
} from "./app-updater-controller";

function asUpdateHandle(update: Update): AppUpdateHandle {
  return {
    version: update.version,
    body: update.body,
    date: update.date,
    download: (onEvent) => update.download((event: DownloadEvent) => {
      onEvent?.(event as AppDownloadEvent);
    }),
    install: (options) => update.install(options),
    close: () => update.close(),
  };
}

export function createAppUpdaterController() {
  return new AppUpdaterController({
    currentVersion: getVersion,
    check: async () => {
      const update = await check({ timeout: 12_000 });
      return update ? asUpdateHandle(update) : null;
    },
    relaunch,
    isWindows: () => /Windows/i.test(navigator.userAgent),
  });
}
