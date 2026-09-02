import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createAppUpdaterController } from "./app-updater";
import {
  isAppUpdateBusy,
  isAppUpdateSnapshot,
  type AppUpdateSnapshot,
} from "./app-updater-controller";

type Album = {
  aid: string;
  title: string;
  url: string;
  cover?: string;
  meta: string;
};

type PhotoEntry = {
  id: string;
  url: string;
  title: string;
};

type PhotoImage = {
  url: string;
};

type ImageData = {
  dataUrl: string;
};

type ImageDownloadProgress = {
  requestId: string;
  loaded: number;
  total: number | null;
  percent: number | null;
};

type OcrModelProgress = {
  requestId: string;
  phase: "checking" | "migrating" | "downloading" | "verifying" | "ready";
  fileName: string | null;
  fileIndex: number;
  fileCount: number;
  fileLoaded: number;
  fileTotal: number;
  loaded: number;
  total: number;
  percent: number;
};

type OcrCapabilities = {
  vision: boolean;
  manga: boolean;
};

type ProgressState = {
  loaded: number;
  total: number | null;
  percent: number | null;
};

type DisplayImageResult = {
  url: string;
  imageUrl: string;
};

type Tag = {
  name: string;
  path: string;
};

type AlbumDetail = {
  photos: PhotoEntry[];
  tags: Tag[];
  categories: Tag[];
  author?: Tag | null;
  title?: string | null;
};

type BrowseKind = "tag" | "author" | "classification";

type BrowseLinkRequest = Tag & {
  kind: BrowseKind;
};

type PreloadResult = "loaded" | "failed" | "cached";

type GestureEventLike = Event & {
  scale?: number;
  clientX?: number;
  clientY?: number;
};

type Category = {
  label: string;
  path: string;
};

type ListSnapshot = {
  albums: Album[];
  page: number;
  allLoaded: boolean;
  scrollTop: number;
  status: string;
};

type PersistentListEntry = {
  page: number;
  albums: Album[];
  savedAt: number;
};

type ReaderWidth = "comfort" | "wide" | "edge";
type ReaderGap = "relaxed" | "compact";
type ReaderFit = "width" | "page" | "spread";
type ReaderOcrLang = "zh" | "ja";

type ReaderPrefs = {
  width: ReaderWidth;
  zoom: number;
  gap: ReaderGap;
  fit: ReaderFit;
  conserveImages: boolean;
  ocrBoxes: boolean;
  ocrLang: ReaderOcrLang;
  translateMode: boolean;
};

const readerPrefKey = "wnacg.readerPrefs.v1";
const persistentListCacheKey = "wnacg.listCache.v1";
const persistentListMaxAge = 24 * 60 * 60 * 1000;
const READER_ZOOM_MIN = 0.5;
const READER_ZOOM_MAX = 2.5;
const READER_ZOOM_STEP = 0.1;
const allowedImageDomains = [
  "wnacg.com",
  "wnacg.org",
  "wn03.cfd",
  "wn09.shop",
  "wnacgimg.date",
  "wnimg1.ru",
  "qy0.ru",
];

function hostIsDomain(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

function isAllowedRemoteImageUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.trim().replace(/\.$/, "").toLowerCase();
    return url.protocol === "https:"
      && !url.port
      && !url.username
      && !url.password
      && allowedImageDomains.some((domain) => hostIsDomain(host, domain));
  } catch {
    return false;
  }
}

function normalizeReaderZoom(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(READER_ZOOM_MIN, Math.min(READER_ZOOM_MAX, value));
}

function readPersistentList(contextKey: string, page: number): Album[] | null {
  try {
    const raw = localStorage.getItem(persistentListCacheKey);
    if (!raw) return null;
    const entries = JSON.parse(raw) as Record<string, PersistentListEntry>;
    const entry = entries[contextKey];
    if (!entry || entry.page !== page || Date.now() - entry.savedAt > persistentListMaxAge) return null;
    return Array.isArray(entry.albums) && entry.albums.length > 0 ? entry.albums : null;
  } catch {
    return null;
  }
}

function writePersistentList(contextKey: string, page: number, albums: Album[]) {
  if (albums.length === 0) return;
  try {
    const raw = localStorage.getItem(persistentListCacheKey);
    const entries = raw ? JSON.parse(raw) as Record<string, PersistentListEntry> : {};
    entries[contextKey] = { page, albums: albums.slice(0, 60), savedAt: Date.now() };
    const newest = Object.entries(entries)
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, 8);
    localStorage.setItem(persistentListCacheKey, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    // A stale-while-revalidate cache is opportunistic; storage limits must not
    // interfere with browsing.
  }
}

const defaultReaderPrefs: ReaderPrefs = {
  width: "comfort",
  zoom: 1,
  gap: "relaxed",
  fit: "width",
  conserveImages: true,
  ocrBoxes: false,
  ocrLang: "ja",
  translateMode: false,
};

function loadReaderPrefs(): ReaderPrefs {
  try {
    const raw = localStorage.getItem(readerPrefKey);
    if (!raw) return { ...defaultReaderPrefs };
    const parsed = JSON.parse(raw) as Partial<ReaderPrefs>;
    const ocrBoxes = typeof parsed.ocrBoxes === "boolean"
      ? parsed.ocrBoxes
      : defaultReaderPrefs.ocrBoxes;
    const ocrLang = parsed.ocrLang === "zh" || parsed.ocrLang === "ja"
      ? parsed.ocrLang
      : defaultReaderPrefs.ocrLang;
    return {
      width: parsed.width === "wide" || parsed.width === "edge" ? parsed.width : defaultReaderPrefs.width,
      zoom: typeof parsed.zoom === "number" ? normalizeReaderZoom(parsed.zoom) : defaultReaderPrefs.zoom,
      gap: parsed.gap === "compact" ? "compact" : defaultReaderPrefs.gap,
      conserveImages: typeof parsed.conserveImages === "boolean"
        ? parsed.conserveImages
        : defaultReaderPrefs.conserveImages,
      ocrBoxes,
      ocrLang,
      translateMode: parsed.translateMode === true && ocrBoxes && ocrLang === "ja",
      fit: parsed.fit === "page" || parsed.fit === "spread" ? parsed.fit : defaultReaderPrefs.fit,
    };
  } catch {
    return { ...defaultReaderPrefs };
  }
}

const readerPrefs = loadReaderPrefs();

const categories: Category[] = [
  { label: "更新", path: "/albums-index-page-{page}.html" },
  { label: "同人志 汉化", path: "/albums-index-page-{page}-cate-1.html" },
  { label: "同人志 生肉", path: "/albums-index-page-{page}-cate-12.html" },
  { label: "单行本 汉化", path: "/albums-index-page-{page}-cate-9.html" },
  { label: "单行本 生肉", path: "/albums-index-page-{page}-cate-13.html" },
  { label: "短篇 汉化", path: "/albums-index-page-{page}-cate-10.html" },
  { label: "短篇 生肉", path: "/albums-index-page-{page}-cate-14.html" },
  { label: "韩漫 汉化", path: "/albums-index-page-{page}-cate-20.html" },
];

const state = {
  view: "list" as "list" | "reader",
  mode: "category" as "category" | "search" | BrowseKind,
  category: categories[0],
  query: "",
  linkPath: "",
  page: 1,
  albums: [] as Album[],
  listSnapshots: {} as Record<string, ListSnapshot>,
  listLoading: false,
  loadingMore: false,
  allLoaded: false,
  loadMoreError: "",
  currentAlbum: null as { aid: string; title: string } | null,
  photos: [] as PhotoEntry[],
  tags: [] as Tag[],
  albumCategories: [] as Tag[],
  author: null as Tag | null,
  preloadedUrls: {} as Record<number, string>, // index -> full image URL
  listToken: 0,
  readerToken: 0,
  preloadFailures: {} as Record<number, number>,
  fullscreen: false,
  readerWidth: readerPrefs.width,
  readerZoom: readerPrefs.zoom,
  readerGestureStartZoom: readerPrefs.zoom,
  readerGap: readerPrefs.gap,
  readerFit: readerPrefs.fit,
  conserveImages: readerPrefs.conserveImages,
  ocrEnabled: readerPrefs.ocrBoxes,
  ocrLang: readerPrefs.ocrLang,
  translateEnabled: readerPrefs.translateMode,
  ocrRegions: {} as Record<number, OcrRegion[]>,
  ocrFailed: {} as Record<number, string>,
  translateTexts: {} as Record<number, string[]>,
  translateFailed: {} as Record<number, string>,
  imageUrls: {} as Record<number, string>,
};

// Every consumer shares the same full-image request for a page. This avoids the
// reader and translation prefetch downloading the same image in parallel.
const preloadInFlight = new Map<number, Promise<PreloadResult>>();
const ocrByteCacheUrls = new Set<string>();

type OcrRegion = {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

type OcrPageResult = {
  index: number;
  regions: OcrRegion[];
  error: string | null;
};

// ---- icons (inline SVG, lucide-style, 24x24 viewBox, stroke 1.75) ----

const ICON_PATHS: Record<string, string> = {
  settings:
    'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  refresh: 'M3 12a9 9 0 0 1 15.5-6.36L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15.5 6.36L3 16 M3 21v-5h5',
  maximize: 'M3 9V3h6 M21 9V3h-6 M3 15v6h6 M21 15v6h-6',
  minimize: 'M9 3v6H3 M15 3v6h6 M9 21v-6H3 M15 21v-6h6',
  x: 'M18 6 6 18 M6 6l12 12',
  arrowLeft: 'M19 12H5 M12 19l-7-7 7-7',
  chevronLeft: 'm15 18-6-6 6-6',
  chevronRight: 'm9 18 6-6-6-6',
  chevronUp: 'm6 15 6-6 6 6',
  chevronsLeft: 'm11 17-5-5 5-5 M18 17l-5-5 5-5',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
};

function icon(name: keyof typeof ICON_PATHS, size = 16): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICON_PATHS[name]);
  svg.append(path);
  return svg;
}

function setIconWithLabel(button: HTMLButtonElement, iconName: keyof typeof ICON_PATHS, label?: string) {
  button.replaceChildren(icon(iconName));
  if (label) {
    const span = document.createElement("span");
    span.textContent = label;
    button.append(span);
  }
}

// DOM refs
const shell = document.querySelector<HTMLElement>(".shell")!;
const sidebar = document.querySelector<HTMLElement>(".sidebar")!;
const workspace = document.querySelector<HTMLElement>(".workspace")!;
const categoryList = document.querySelector<HTMLElement>("#category-list")!;
const resultGrid = document.querySelector<HTMLElement>("#result-grid")!;
const searchForm = document.querySelector<HTMLFormElement>("#search-form")!;
const searchInput = document.querySelector<HTMLInputElement>("#search-input")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh")!;
setIconWithLabel(refreshButton, "refresh", "刷新");
refreshButton.title = "刷新";
refreshButton.setAttribute("aria-label", "刷新");
const viewTitle = document.querySelector<HTMLElement>("#view-title")!;
const statusLabel = document.querySelector<HTMLElement>("#status-label")!;
const backButton = document.querySelector<HTMLButtonElement>("#back-to-list")!;
setIconWithLabel(backButton, "arrowLeft", "返回");
const toolbarLeft = document.querySelector<HTMLElement>(".toolbar-left")!;
const pagerControls = document.querySelector<HTMLElement>("#pager-controls")!;

const translateStatus = document.createElement("span");
translateStatus.id = "translate-status";
translateStatus.className = "translate-status";
translateStatus.hidden = true;
translateStatus.addEventListener("click", () => {
  const index = visibleReaderIndices().find((visibleIndex) => translationFailure(visibleIndex));
  if (index !== undefined) {
    delete state.translateFailed[index];
    delete state.ocrFailed[index];
    ocrTextDone.delete(index);
    translateDone.delete(index);
    queueOcrText(index);
    queueTranslate(index);
    refreshTranslateStatus();
  }
});
pagerControls.append(translateStatus);

const readerPageControls = document.createElement("div");
readerPageControls.className = "reader-page-controls";
readerPageControls.hidden = true;
readerPageControls.setAttribute("role", "group");
readerPageControls.setAttribute("aria-label", "阅读翻页");

const readerPagePrevButton = document.createElement("button");
readerPagePrevButton.type = "button";
readerPagePrevButton.title = "上一页 (←)";
readerPagePrevButton.setAttribute("aria-label", "上一页");
readerPagePrevButton.append(icon("chevronLeft", 15));
readerPagePrevButton.addEventListener("click", () => turnReaderPage(-1));

const readerPageLabel = document.createElement("span");
readerPageLabel.className = "reader-page-label";
readerPageLabel.textContent = "1 / 1";
readerPageLabel.setAttribute("aria-live", "polite");

const readerPageNextButton = document.createElement("button");
readerPageNextButton.type = "button";
readerPageNextButton.title = "下一页 (→)";
readerPageNextButton.setAttribute("aria-label", "下一页");
readerPageNextButton.append(icon("chevronRight", 15));
readerPageNextButton.addEventListener("click", () => turnReaderPage(1));

readerPageControls.append(readerPagePrevButton, readerPageLabel, readerPageNextButton);
pagerControls.append(readerPageControls);

const readerZoomControls = document.createElement("div");
readerZoomControls.className = "reader-zoom-controls";
readerZoomControls.hidden = true;
readerZoomControls.setAttribute("role", "group");
readerZoomControls.setAttribute("aria-label", "阅读缩放");

const readerZoomOutButton = document.createElement("button");
readerZoomOutButton.type = "button";
readerZoomOutButton.className = "reader-zoom-step";
readerZoomOutButton.title = "缩小 (−)";
readerZoomOutButton.setAttribute("aria-label", "缩小阅读页面");
readerZoomOutButton.append(icon("minus", 14));
readerZoomOutButton.addEventListener("click", () => adjustReaderZoom(-READER_ZOOM_STEP));

const readerZoomResetButton = document.createElement("button");
readerZoomResetButton.type = "button";
readerZoomResetButton.className = "reader-zoom-value";
readerZoomResetButton.title = "触摸板双指捏合缩放 · 点击恢复 100%";
readerZoomResetButton.setAttribute("aria-label", "当前阅读缩放 100%，点击恢复");
readerZoomResetButton.textContent = "100%";
readerZoomResetButton.addEventListener("click", () => setReaderZoom(1));

const readerZoomInButton = document.createElement("button");
readerZoomInButton.type = "button";
readerZoomInButton.className = "reader-zoom-step";
readerZoomInButton.title = "放大 (+)";
readerZoomInButton.setAttribute("aria-label", "放大阅读页面");
readerZoomInButton.append(icon("plus", 14));
readerZoomInButton.addEventListener("click", () => adjustReaderZoom(READER_ZOOM_STEP));

readerZoomControls.append(readerZoomOutButton, readerZoomResetButton, readerZoomInButton);
pagerControls.append(readerZoomControls);

const fullscreenButton = document.createElement("button");
fullscreenButton.type = "button";
fullscreenButton.className = "fullscreen-button";
fullscreenButton.title = "全屏 (F11)";
fullscreenButton.hidden = true;
fullscreenButton.addEventListener("click", () => toggleFullscreen());
pagerControls.append(fullscreenButton);

const readerInfo = document.createElement("div");
readerInfo.className = "reader-info";
readerInfo.hidden = true;

const readerInfoButton = document.createElement("button");
readerInfoButton.type = "button";
readerInfoButton.className = "reader-setting-button reader-info-trigger";
readerInfoButton.textContent = "作品信息";
readerInfoButton.setAttribute("aria-haspopup", "true");
readerInfoButton.setAttribute("aria-expanded", "false");

const readerInfoPanel = document.createElement("div");
readerInfoPanel.className = "reader-info-panel";
readerInfoPanel.hidden = true;
readerInfoPanel.setAttribute("role", "dialog");
readerInfoPanel.setAttribute("aria-label", "作品信息");
readerInfoPanel.addEventListener("click", (event) => event.stopPropagation());

readerInfo.append(readerInfoButton, readerInfoPanel);
pagerControls.append(readerInfo);

const readerSettings = document.createElement("div");
readerSettings.className = "reader-settings";
readerSettings.hidden = true;

const readerSettingsButton = document.createElement("button");
readerSettingsButton.type = "button";
readerSettingsButton.className = "reader-setting-button reader-settings-trigger";
readerSettingsButton.title = "阅读设置";
readerSettingsButton.setAttribute("aria-label", "阅读设置");
readerSettingsButton.setAttribute("aria-haspopup", "true");
readerSettingsButton.setAttribute("aria-expanded", "false");
setIconWithLabel(readerSettingsButton, "settings", "设置");
readerSettingsButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleReaderSettingsPanel();
});

const readerSettingsPanel = document.createElement("div");
readerSettingsPanel.className = "reader-settings-panel";
readerSettingsPanel.hidden = true;
readerSettingsPanel.setAttribute("role", "dialog");
readerSettingsPanel.setAttribute("aria-label", "阅读设置");
readerSettingsPanel.addEventListener("click", (event) => event.stopPropagation());

readerSettings.append(readerSettingsButton, readerSettingsPanel);

pagerControls.append(readerSettings);

const APP_RELEASES_URL = "https://github.com/yuxino/wnacg/releases";
const appUpdater = createAppUpdaterController();
let appUpdateSnapshot = appUpdater.getSnapshot();
let applyingRemoteAppUpdate = false;
let appUpdateEventsReady = false;

const appUpdateErrorPhases = new Set([
  "check-error",
  "download-error",
  "install-error",
  "relaunch-error",
]);

function versionLabel(value: string) {
  const normalized = value.trim().replace(/^[vV]/, "");
  return normalized ? `v${normalized}` : "v—";
}

function formatUpdateBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function isAppUpdateError(snapshot: AppUpdateSnapshot) {
  return appUpdateErrorPhases.has(snapshot.phase);
}

function syncAppUpdateUi() {
  const snapshot = appUpdateSnapshot;
  const latestVersion = snapshot.latestVersion;
  const hasUpdate = snapshot.phase === "available" && Boolean(latestVersion);
  readerSettingsButton.classList.toggle("update-available", hasUpdate);
  const settingsLabel = hasUpdate
    ? `阅读设置，有新版本 ${versionLabel(latestVersion!)}`
    : "阅读设置";
  readerSettingsButton.title = settingsLabel;
  readerSettingsButton.setAttribute("aria-label", settingsLabel);

  const control = readerSettingsPanel.querySelector<HTMLElement>(".app-update-control");
  if (!control) return;
  const version = control.querySelector<HTMLElement>(".app-version");
  const status = control.querySelector<HTMLElement>(".app-update-status");
  const button = control.querySelector<HTMLButtonElement>(".app-update-primary");
  const postpone = control.querySelector<HTMLButtonElement>(".app-update-postpone");
  const recovery = control.querySelector<HTMLButtonElement>(".app-update-recovery");
  const progress = control.querySelector<HTMLProgressElement>(".app-update-progress");
  const notes = control.querySelector<HTMLElement>(".app-update-notes");
  if (!version || !status || !button || !postpone || !recovery || !progress || !notes) return;

  version.textContent = versionLabel(snapshot.currentVersion);
  const busy = isAppUpdateBusy(snapshot.phase);
  button.disabled = busy;
  button.classList.toggle("available", hasUpdate);
  button.setAttribute("aria-busy", String(busy));
  postpone.hidden = snapshot.phase !== "available";
  recovery.hidden = !isAppUpdateError(snapshot);

  progress.hidden = snapshot.phase !== "downloading" && snapshot.phase !== "installing";
  if (snapshot.percent === null) {
    progress.removeAttribute("value");
    progress.setAttribute("aria-valuetext", snapshot.downloadedBytes > 0
      ? `已下载 ${formatUpdateBytes(snapshot.downloadedBytes)}，总大小未知`
      : "正在等待下载大小");
  } else {
    progress.max = 100;
    progress.value = snapshot.percent;
    progress.setAttribute("aria-valuetext", `已下载 ${snapshot.percent}%`);
  }

  notes.hidden = !snapshot.latestVersion || !snapshot.notes;
  notes.textContent = snapshot.notes ? `更新说明：${snapshot.notes}` : "";

  switch (snapshot.phase) {
    case "checking":
      status.textContent = "正在安全检查更新";
      button.textContent = "检查中…";
      break;
    case "current":
      status.textContent = "当前已是最新版";
      button.textContent = "重新检查";
      break;
    case "available":
      status.textContent = `发现 ${versionLabel(latestVersion || "")}`;
      button.textContent = "下载更新";
      break;
    case "downloading":
      status.textContent = snapshot.percent === null
        ? `已下载 ${formatUpdateBytes(snapshot.downloadedBytes)} · 总大小未知`
        : `正在下载 ${snapshot.percent}%`;
      button.textContent = "下载中…";
      break;
    case "installing":
      status.textContent = /Windows/i.test(navigator.userAgent)
        ? "签名已校验，正在启动安装程序；应用将自动退出"
        : "签名已校验，正在安装更新";
      button.textContent = "正在安装…";
      break;
    case "restart-ready":
      status.textContent = "更新已安装，等待重新启动";
      button.textContent = "重启并完成更新";
      break;
    case "windows-installing":
      status.textContent = "安装程序已启动；完成后请重新打开应用";
      button.textContent = "安装程序处理中";
      button.disabled = true;
      break;
    case "check-error":
    case "download-error":
    case "install-error":
    case "relaunch-error":
      status.textContent = snapshot.errorMessage || "更新失败，当前版本未被替换";
      button.textContent = "重新检查";
      break;
    default:
      status.textContent = "可手动检查";
      button.textContent = "检查更新";
      break;
  }
  button.title = button.textContent || "检查更新";
  button.setAttribute("aria-label", button.title);
}

async function runPrimaryAppUpdateAction() {
  const phase = appUpdateSnapshot.phase;
  if (phase === "available") {
    await appUpdater.downloadAndInstall();
  } else if (phase === "restart-ready") {
    await appUpdater.relaunchAfterUpdate();
  } else if (!isAppUpdateBusy(phase) && phase !== "windows-installing") {
    await appUpdater.checkForUpdate();
  }

  const snapshot = appUpdateSnapshot;
  if (snapshot.phase === "current") {
    showToast(`当前 ${versionLabel(snapshot.currentVersion)} 已是最新版`, "success", 2800);
  } else if (snapshot.phase === "available") {
    showToast(`发现新版本 ${versionLabel(snapshot.latestVersion || "")}`, "info", 3600);
  } else if (isAppUpdateError(snapshot)) {
    showToast(snapshot.errorMessage || "更新失败，当前版本未被替换", "error", 4800);
  }
}

function renderAppUpdateControl() {
  const control = document.createElement("div");
  control.className = "app-update-control";

  const meta = document.createElement("div");
  meta.className = "app-update-meta";
  const version = document.createElement("span");
  version.className = "app-version";
  const status = document.createElement("span");
  status.className = "app-update-status";
  status.setAttribute("aria-live", "polite");
  meta.append(version, status);

  const progress = document.createElement("progress");
  progress.className = "app-update-progress";
  progress.setAttribute("aria-label", "更新下载进度");
  progress.hidden = true;

  const notes = document.createElement("p");
  notes.className = "app-update-notes";
  notes.hidden = true;

  const actions = document.createElement("div");
  actions.className = "app-update-actions";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "app-update-button app-update-primary";
  button.addEventListener("click", () => void runPrimaryAppUpdateAction());

  const postpone = document.createElement("button");
  postpone.type = "button";
  postpone.className = "app-update-button app-update-postpone";
  postpone.textContent = "稍后";
  postpone.addEventListener("click", () => void appUpdater.dismissAvailableUpdate());

  const recovery = document.createElement("button");
  recovery.type = "button";
  recovery.className = "app-update-button app-update-recovery";
  recovery.textContent = "打开发布页";
  recovery.addEventListener("click", () => {
    openUrl(APP_RELEASES_URL).catch(() => {
      showToast("无法打开发布页", "error", 3200);
    });
  });

  actions.append(postpone, recovery, button);
  control.append(meta, progress, notes, actions);
  window.requestAnimationFrame(syncAppUpdateUi);
  return control;
}

appUpdater.subscribe((snapshot) => {
  appUpdateSnapshot = snapshot;
  syncAppUpdateUi();
  if (appUpdateEventsReady && !applyingRemoteAppUpdate) {
    emit("app-update-state", snapshot).catch(() => {});
  }
});

type DeepseekKeySource = "keychain" | "keychain-with-legacy" | "environment" | "legacy-config" | "missing";
let deepseekKeySource: DeepseekKeySource | null = null;

function hasUsableDeepseekKey() {
  return deepseekKeySource !== null && deepseekKeySource !== "missing";
}

function syncDeepseekKeyControl() {
  const status = readerSettingsPanel.querySelector<HTMLElement>(".api-key-status");
  const input = readerSettingsPanel.querySelector<HTMLInputElement>(".api-key-input");
  if (status) {
    status.textContent = deepseekKeySource === null ? "检查中" : {
      keychain: "已安全保存",
      "keychain-with-legacy": "安全存储可用；旧配置仍含密钥",
      environment: "使用环境变量（未持久保存）",
      "legacy-config": "使用旧配置（未安全迁移）",
      missing: "尚未配置",
    }[deepseekKeySource];
    status.classList.toggle("configured", hasUsableDeepseekKey());
  }
  if (input) {
    input.placeholder = hasUsableDeepseekKey() ? "输入新密钥可替换" : "粘贴 API Key";
  }
}

async function refreshDeepseekKeyStatus() {
  try {
    const source = await invokeTauri<string>("translate_engine_status");
    deepseekKeySource = source === "keychain" || source === "keychain-with-legacy" || source === "environment" || source === "legacy-config"
      ? source
      : "missing";
  } catch {
    deepseekKeySource = "missing";
  }
  syncDeepseekKeyControl();
}

async function ensureDeepseekKeyForTranslation() {
  if (!hasUsableDeepseekKey()) {
    await refreshDeepseekKeyStatus();
  }
  if (hasUsableDeepseekKey()) return true;

  setReaderSettingsOpen(true);
  showToast("翻译需要 DeepSeek API Key，请先在下方保存", "info", 4800);
  window.requestAnimationFrame(() => {
    readerSettingsPanel.querySelector<HTMLInputElement>(".api-key-input")?.focus();
  });
  return false;
}

function renderDeepseekKeyControl() {
  const form = document.createElement("form");
  form.className = "api-key-control";

  const input = document.createElement("input");
  input.type = "password";
  input.className = "api-key-input";
  input.autocomplete = "new-password";
  input.spellcheck = false;
  input.setAttribute("aria-label", "DeepSeek API Key");

  const save = document.createElement("button");
  save.type = "submit";
  save.className = "api-key-save";
  save.textContent = "保存";

  const status = document.createElement("span");
  status.className = "api-key-status";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const apiKey = input.value.trim();
    if (!apiKey) {
      input.focus();
      return;
    }
    input.disabled = true;
    save.disabled = true;
    save.textContent = "保存中";
    try {
      await invokeTauri<void>("set_deepseek_api_key", { apiKey });
      deepseekKeySource = "keychain";
      input.value = "";
      titleTranslateFailed.clear();
      state.translateFailed = {};
      translateDone.clear();
      if (state.translateEnabled && state.view === "reader") {
        queueOcrWindow(currentStreamIndex());
      }
      translateVisibleTitles();
      refreshTranslateStatus();
      showToast("DeepSeek 密钥已安全保存", "success", 3200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast(`密钥保存失败：${message}`, "error", 4200);
    } finally {
      input.disabled = false;
      save.disabled = false;
      save.textContent = "保存";
      syncDeepseekKeyControl();
    }
  });

  form.append(input, save, status);
  window.requestAnimationFrame(syncDeepseekKeyControl);
  return form;
}

const jumpTopButton = document.createElement("button");
jumpTopButton.type = "button";
jumpTopButton.className = "jump-top";
jumpTopButton.append(icon("chevronUp", 16));
jumpTopButton.title = "回到顶部";
jumpTopButton.setAttribute("aria-label", "回到顶部");
jumpTopButton.hidden = true;
workspace.append(jumpTopButton);

const pagerBar = document.createElement("div");
pagerBar.className = "pager-bar";
pagerBar.hidden = true;

const pagerBarFirst = document.createElement("button");
pagerBarFirst.type = "button";
pagerBarFirst.className = "pager-bar-btn";
pagerBarFirst.title = "第一页";
pagerBarFirst.setAttribute("aria-label", "第一页");
pagerBarFirst.append(icon("chevronsLeft", 14));
pagerBarFirst.addEventListener("click", () => jumpToPage(1));

const pagerBarPrev = document.createElement("button");
pagerBarPrev.type = "button";
pagerBarPrev.className = "pager-bar-btn";
pagerBarPrev.title = "上一页";
pagerBarPrev.setAttribute("aria-label", "上一页");
pagerBarPrev.append(icon("chevronLeft", 14));
pagerBarPrev.addEventListener("click", () => jumpToPage(state.page - 1));

const pagerBarLabel = document.createElement("span");
pagerBarLabel.className = "pager-bar-label";

const pagerBarInput = document.createElement("input");
pagerBarInput.type = "number";
pagerBarInput.min = "1";
pagerBarInput.step = "1";
pagerBarInput.inputMode = "numeric";
pagerBarInput.className = "pager-bar-input";
pagerBarInput.setAttribute("aria-label", "跳转到指定页");
pagerBarInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    const target = parseInt(pagerBarInput.value, 10);
    if (Number.isFinite(target) && target >= 1) jumpToPage(target);
    pagerBarInput.blur();
  } else if (event.key === "Escape") {
    pagerBarInput.value = String(state.page);
    pagerBarInput.blur();
  }
});
pagerBarInput.addEventListener("blur", () => {
  pagerBarInput.value = String(state.page);
});

const pagerBarNext = document.createElement("button");
pagerBarNext.type = "button";
pagerBarNext.className = "pager-bar-btn";
pagerBarNext.title = "下一页";
pagerBarNext.setAttribute("aria-label", "下一页");
pagerBarNext.append(icon("chevronRight", 14));
pagerBarNext.addEventListener("click", () => jumpToPage(state.page + 1));

pagerBar.append(pagerBarFirst, pagerBarPrev, pagerBarLabel, pagerBarInput, pagerBarNext);
workspace.append(pagerBar);

function syncPagerBar() {
  const visible = state.view === "list";
  pagerBar.hidden = !visible;
  if (!visible) return;
  pagerBarLabel.textContent = "第";
  if (document.activeElement !== pagerBarInput) {
    pagerBarInput.value = String(state.page);
  }
}

const readerProgress = document.createElement("div");
readerProgress.className = "reader-progress";
readerProgress.hidden = true;
const readerProgressFill = document.createElement("span");
readerProgressFill.className = "reader-progress-fill";
readerProgress.append(readerProgressFill);
readerProgress.addEventListener("click", (event) => {
  if (state.view !== "reader") return;
  const rect = readerProgress.getBoundingClientRect();
  if (rect.width <= 0) return;
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  if (state.photos.length > 0) {
    const target = Math.round(ratio * (state.photos.length - 1));
    scrollToStreamIndex(target, "smooth");
  } else {
    const maxScroll = Math.max(0, resultGrid.scrollHeight - resultGrid.clientHeight);
    resultGrid.scrollTo({ top: maxScroll * ratio, behavior: "smooth" });
  }
});
workspace.append(readerProgress);

function buildReaderSettingsPanel() {
  type Segment<V> = { label: string; value: V; hint?: string };

  const groups: Array<{ title: string; render: () => HTMLElement; className?: string }> = [
    {
      title: "阅读宽度",
      render: () => renderSegmented<ReaderWidth>(
        [
          { label: "适中", value: "comfort" },
          { label: "宽屏", value: "wide" },
          { label: "贴边", value: "edge", hint: "W" },
        ],
        state.readerWidth,
        (v) => updateReaderPrefs({ width: v, zoom: 1 }),
      ),
    },
    {
      title: "图片间距",
      render: () => renderSegmented<ReaderGap>(
        [
          { label: "留白", value: "relaxed" },
          { label: "紧凑", value: "compact", hint: "G" },
        ],
        state.readerGap,
        (v) => updateReaderPrefs({ gap: v }),
      ),
    },
    {
      title: "阅读方式",
      render: () => renderSegmented<ReaderFit>(
        [
          { label: "连续", value: "width" },
          { label: "单页", value: "page" },
          { label: "双页", value: "spread", hint: "V" },
        ],
        state.readerFit,
        (v) => updateReaderPrefs({ fit: v, zoom: v === "width" ? state.readerZoom : 1 }),
      ),
    },
    {
      title: "图片策略",
      render: () => renderSegmented<boolean>(
        [
          { label: "省流", value: true },
          { label: "预载", value: false, hint: "P" },
        ],
        state.conserveImages,
        (v) => updateReaderPrefs({ conserveImages: v }),
      ),
    },
    {
      title: "OCR 语言",
      render: () => renderSegmented<ReaderOcrLang>(
        ocrCapabilities.vision
          ? [
              { label: "中文优先", value: "zh" },
              { label: "日文优先", value: "ja" },
            ]
          : [{ label: "日文优先", value: "ja" }],
        state.ocrLang,
        (v) => updateReaderPrefs({ ocrLang: v }),
      ),
    },
    {
      title: "翻译字幕",
      render: () => {
        const control = renderSegmented<boolean>(
          [
            { label: translateInitializing ? "取消" : "关闭", value: false },
            { label: translateInitializing ? "准备中…" : "开启", value: true, hint: "R" },
          ],
          translateInitializing || state.translateEnabled,
          (v) => toggleReaderTranslate(v),
        );
        control.setAttribute("aria-busy", String(translateInitializing));
        return control;
      },
    },
    {
      title: "生肉标题翻译",
      render: () => renderSegmented<boolean>(
        [
          { label: "关闭", value: false },
          { label: "开启", value: true },
        ],
        titleTranslateEnabled,
        (v) => {
          if (v === titleTranslateEnabled) return;
          void setTitleTranslateWithFeedback(v);
        },
      ),
    },
    {
      title: "DeepSeek",
      render: renderDeepseekKeyControl,
    },
    {
      title: "版本",
      render: renderAppUpdateControl,
      className: "settings-row-version",
    },
  ];

  function renderSegmented<V>(
    segments: Array<Segment<V>>,
    current: V,
    onSelect: (value: V) => void,
  ) {
    const wrap = document.createElement("div");
    wrap.className = "segmented";
    for (const seg of segments) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = seg.value === current ? "segmented-item active" : "segmented-item";
      btn.setAttribute("aria-pressed", String(seg.value === current));
      btn.textContent = seg.label;
      if (seg.hint) {
        const hint = document.createElement("span");
        hint.className = "kbd-hint";
        hint.textContent = seg.hint;
        btn.append(hint);
      }
      btn.addEventListener("click", () => {
        onSelect(seg.value);
      });
      wrap.append(btn);
    }
    return wrap;
  }

  readerSettingsPanel.replaceChildren(
    ...groups.map((group) => {
      const row = document.createElement("div");
      row.className = "settings-row";
      if (group.className) row.classList.add(group.className);
      const label = document.createElement("span");
      label.className = "settings-label";
      label.textContent = group.title;
      row.append(label, group.render());
      return row;
    }),
  );
}

let readerSettingsOpen = false;
let readerInfoOpen = false;

function setReaderInfoOpen(open: boolean) {
  if (open && readerSettingsOpen) setReaderSettingsOpen(false);
  readerInfoOpen = open && !readerInfoButton.disabled;
  readerInfoPanel.hidden = !readerInfoOpen;
  readerInfoButton.classList.toggle("active", readerInfoOpen);
  readerInfoButton.setAttribute("aria-expanded", String(readerInfoOpen));
  if (readerInfoOpen) {
    readerInfoPanel.replaceChildren(buildAlbumMetadata("reader-info-metadata"));
  }
}

function syncReaderInfo() {
  const hasMetadata = state.albumCategories.length > 0 || Boolean(state.author) || state.tags.length > 0;
  readerInfo.hidden = state.view !== "reader";
  readerInfoButton.disabled = !hasMetadata;
  readerInfoButton.title = hasMetadata ? "查看分类、作者与标签" : "正在获取作品信息";
  if (!hasMetadata || state.view !== "reader") setReaderInfoOpen(false);
}

readerInfoButton.addEventListener("click", (event) => {
  event.stopPropagation();
  setReaderInfoOpen(!readerInfoOpen);
});

function setReaderSettingsOpen(open: boolean) {
  if (open && readerInfoOpen) setReaderInfoOpen(false);
  readerSettingsOpen = open;
  readerSettingsPanel.hidden = !open;
  readerSettingsButton.classList.toggle("active", open);
  readerSettingsButton.setAttribute("aria-expanded", String(open));
  if (open) {
    buildReaderSettingsPanel();
    void refreshDeepseekKeyStatus();
  }
}

function toggleReaderSettingsPanel() {
  setReaderSettingsOpen(!readerSettingsOpen);
}

document.addEventListener("click", (event) => {
  if (readerInfoOpen) {
    const target = event.target as Node;
    if (!readerInfo.contains(target)) setReaderInfoOpen(false);
  }
  if (!readerSettingsOpen) return;
  const target = event.target as Node;
  if (readerSettings.contains(target)) return;
  setReaderSettingsOpen(false);
});


// ---- helpers ----

const toastContainer = document.createElement("div");
toastContainer.className = "toast-container";
toastContainer.setAttribute("role", "status");
toastContainer.setAttribute("aria-live", "polite");
document.body.append(toastContainer);

type ToastTone = "info" | "success" | "error";

type ToastController = (() => void) & {
  update: (message: string) => void;
  setProgress: (percent: number | null) => void;
};

function showToast(message: string, tone: ToastTone = "info", durationMs = 2400): ToastController {
  const toast = document.createElement("div");
  toast.className = `toast toast-${tone}`;
  const content = document.createElement("div");
  content.className = "toast-content";
  const text = document.createElement("span");
  text.textContent = message;
  content.append(text);
  toast.append(content);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "关闭");
  close.textContent = "×";
  close.addEventListener("click", () => dismiss());
  toast.append(close);
  toastContainer.append(toast);
  let dismissed = false;
  let progress: HTMLDivElement | null = null;
  let progressFill: HTMLSpanElement | null = null;
  const dismiss = (() => {
    if (dismissed) return;
    dismissed = true;
    toast.classList.add("toast-leaving");
    window.setTimeout(() => toast.remove(), 220);
  }) as ToastController;
  dismiss.update = (nextMessage: string) => {
    if (!dismissed) text.textContent = nextMessage;
  };
  dismiss.setProgress = (percent: number | null) => {
    if (dismissed) return;
    if (!progress || !progressFill) {
      progress = document.createElement("div");
      progress.className = "toast-progress";
      progressFill = document.createElement("span");
      progress.append(progressFill);
      content.append(progress);
    }
    progressFill.classList.toggle("indeterminate", percent === null);
    progressFill.style.width = percent === null
      ? "42%"
      : `${Math.max(0, Math.min(100, percent))}%`;
  };
  if (durationMs > 0) window.setTimeout(dismiss, durationMs);
  return dismiss;
}

function setStatus(message: string) {
  statusLabel.textContent = message;
}

function currentReaderPrefs(): ReaderPrefs {
  return {
    width: state.readerWidth,
    zoom: state.readerZoom,
    gap: state.readerGap,
    fit: state.readerFit,
    conserveImages: state.conserveImages,
    ocrBoxes: state.ocrEnabled,
    ocrLang: state.ocrLang,
    translateMode: state.translateEnabled,
  };
}

function saveReaderPrefs() {
  localStorage.setItem(readerPrefKey, JSON.stringify(currentReaderPrefs()));
}

function broadcastReaderPrefs() {
  emit("reader-prefs-changed", currentReaderPrefs()).catch(() => {});
}

function applyReaderPrefs() {
  shell.dataset.readerWidth = state.readerWidth;
  shell.dataset.readerGap = state.readerGap;
  shell.dataset.readerFit = state.readerFit;
  shell.classList.toggle("reader-low-data", state.conserveImages);
  applyReaderZoomLayout();
}

function syncReaderControls() {
  readerSettings.hidden = false;
  if (readerSettingsOpen) buildReaderSettingsPanel();
}

function updateReaderPrefs(next: Partial<ReaderPrefs>) {
  const previousWidth = state.readerWidth;
  const previousZoom = state.readerZoom;
  const previousConserve = state.conserveImages;
  const previousFit = state.readerFit;
  const previousOcr = state.ocrEnabled;
  const previousOcrLang = state.ocrLang;
  const previousTranslate = state.translateEnabled;
  const currentIndexBeforeLayout = state.view === "reader" ? currentStreamIndex() : -1;
  // 显式关闭翻译时一并停掉 OCR，避免后台空转。
  if (previousTranslate && next.translateMode === false) {
    next.ocrBoxes = false;
  }
  // 翻译只能运行在“日文 OCR 已开启”的有效组合中。语言或 OCR 被切走时，
  // 立即关闭翻译，避免界面显示开启但管线永远不会工作的中间状态。
  const nextTranslate = next.translateMode ?? previousTranslate;
  const nextOcr = next.ocrBoxes ?? state.ocrEnabled;
  const nextOcrLang = next.ocrLang ?? state.ocrLang;
  if (nextTranslate && (!nextOcr || nextOcrLang !== "ja")) {
    next.translateMode = false;
  }
  const readerAnchor = state.view === "reader"
    && next.fit === undefined
    && (next.width !== undefined || next.zoom !== undefined || next.gap !== undefined)
    ? captureReaderAnchor()
    : null;
  Object.assign(state, {
    readerWidth: next.width ?? state.readerWidth,
    readerZoom: next.zoom === undefined ? state.readerZoom : normalizeReaderZoom(next.zoom),
    readerGap: next.gap ?? state.readerGap,
    readerFit: next.fit ?? state.readerFit,
    conserveImages: next.conserveImages ?? state.conserveImages,
    ocrEnabled: next.ocrBoxes ?? state.ocrEnabled,
    ocrLang: next.ocrLang ?? state.ocrLang,
    translateEnabled: next.translateMode ?? state.translateEnabled,
  });
  saveReaderPrefs();
  applyReaderPrefs();
  syncReaderControls();
  syncReaderPageControls();
  if (previousFit === state.readerFit) restoreReaderAnchor(readerAnchor);
  // 广播给其它窗口同步阅读布局
  broadcastReaderPrefs();

  if (state.view === "reader" && previousFit !== state.readerFit) {
    window.requestAnimationFrame(() => {
      scrollToStreamIndex(Math.max(0, currentIndexBeforeLayout), "auto");
      setupStreamObserver();
      updateReaderProgress();
      redrawReaderOverlays();
    });
  } else if (
    state.view === "reader"
    && (previousWidth !== state.readerWidth || previousZoom !== state.readerZoom)
  ) {
    window.requestAnimationFrame(redrawReaderOverlays);
  }
  if (state.view === "reader" && previousConserve !== state.conserveImages) {
    setupStreamObserver();
  }
  if (previousOcr !== state.ocrEnabled) {
    ocrEnableToken++; // OCR 开关变了,作废还在初始化中的“开启”请求
    resetReaderPipelines();
    if (state.ocrEnabled) {
      ocrPrefetchLoadedPages();
    } else {
      removeAllOcrOverlays();
      removeAllTranslateOverlays();
      state.translateTexts = {};
      state.translateFailed = {};
    }
  }
  if (previousOcrLang !== state.ocrLang) {
    // 识别语言变了,清掉旧结果重新识别
    resetReaderPipelines();
    state.ocrRegions = {};
    state.ocrFailed = {};
    removeAllOcrOverlays();
    removeAllTranslateOverlays();
    state.translateTexts = {};
    state.translateFailed = {};
    if (state.ocrEnabled) ocrPrefetchLoadedPages();
  }
  if (previousTranslate !== state.translateEnabled) {
    if (state.translateEnabled) {
      if (state.ocrLang !== "ja") {
        showToast("翻译字幕需要日文识别，请将 OCR 语言切到「日文优先」", "info", 3600);
        updateReaderPrefs({ ocrLang: "ja" });
        return;
      }
      if (!state.ocrEnabled) {
        void toggleReaderOcr(true);
      }
      removeAllOcrOverlays(); // 翻译开启时隐藏红框,只看译文
      queueTranslate(currentStreamIndex());
      updateTranslateBadges();
    } else {
      removeAllTranslateOverlays();
      translatePending.clear();
      updateTranslateBadges();
      if (state.ocrEnabled) {
        const index = currentStreamIndex();
        renderStreamOcrOverlay(index);
      }
    }
  }
}

function cycleReaderWidth() {
  const order: ReaderWidth[] = ["comfort", "wide", "edge"];
  const next = order[(order.indexOf(state.readerWidth) + 1) % order.length];
  updateReaderPrefs({ width: next, zoom: 1 });
}

function toggleReaderGap() {
  updateReaderPrefs({ gap: state.readerGap === "relaxed" ? "compact" : "relaxed" });
}

function toggleReaderFit() {
  const order: ReaderFit[] = ["width", "page", "spread"];
  const next = order[(order.indexOf(state.readerFit) + 1) % order.length];
  updateReaderPrefs({ fit: next, zoom: next === "width" ? state.readerZoom : 1 });
}

function toggleReaderPreload() {
  updateReaderPrefs({ conserveImages: !state.conserveImages });
}

type ReaderAnchor = {
  index: number;
  ratioX: number;
  ratioY: number;
  clientX: number;
  clientY: number;
};

let readerAnchorFrame = 0;
let readerPendingAnchor: ReaderAnchor | null = null;
let readerZoomCommitTimer = 0;

function readerBaseWidth() {
  const viewport = resultGrid.clientWidth || workspace.clientWidth || window.innerWidth;
  if (state.readerWidth === "edge") return viewport;
  return Math.min(viewport, state.readerWidth === "wide" ? 1120 : 960);
}

function syncReaderZoomControls() {
  const percent = Math.round(state.readerZoom * 100);
  readerZoomResetButton.textContent = `${percent}%`;
  readerZoomResetButton.classList.toggle("active", Math.abs(state.readerZoom - 1) > 0.01);
  readerZoomResetButton.setAttribute(
    "aria-label",
    `当前阅读缩放 ${percent}%，点击恢复 100%`,
  );
  readerZoomOutButton.disabled = state.readerZoom <= READER_ZOOM_MIN + 0.001;
  readerZoomInButton.disabled = state.readerZoom >= READER_ZOOM_MAX - 0.001;
}

function applyReaderZoomLayout() {
  const baseWidth = readerBaseWidth();
  if (baseWidth > 0) {
    shell.style.setProperty("--reader-page-width", `${Math.round(baseWidth * state.readerZoom)}px`);
  }
  syncReaderZoomControls();
}

function captureReaderAnchor(clientX?: number, clientY?: number): ReaderAnchor | null {
  if (state.view !== "reader") return null;
  const gridRect = resultGrid.getBoundingClientRect();
  if (gridRect.width < 1 || gridRect.height < 1) return null;

  const fallbackX = gridRect.left + gridRect.width / 2;
  const fallbackY = gridRect.top + gridRect.height * 0.42;
  const pointX = Math.max(gridRect.left + 1, Math.min(gridRect.right - 1, clientX ?? fallbackX));
  const pointY = Math.max(gridRect.top + 1, Math.min(gridRect.bottom - 1, clientY ?? fallbackY));
  const hit = document.elementFromPoint(pointX, pointY);
  let photo = hit instanceof Element ? hit.closest<HTMLElement>(".stream-photo") : null;
  if (!photo || !resultGrid.contains(photo)) {
    const current = currentStreamIndex();
    photo = document.querySelector<HTMLElement>(`.stream-photo[data-index="${Math.max(0, current)}"]`);
  }
  if (!photo) return null;

  const rect = photo.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const ratioX = Math.max(0, Math.min(1, (pointX - rect.left) / rect.width));
  const ratioY = Math.max(0, Math.min(1, (pointY - rect.top) / rect.height));
  return {
    index: Number(photo.dataset.index) || 0,
    ratioX,
    ratioY,
    clientX: pointX,
    clientY: pointY,
  };
}

function restoreReaderAnchor(anchor: ReaderAnchor | null) {
  if (!anchor) return;
  // Multiple gesture events can arrive before the next paint. Keep the first
  // visual anchor for that frame and apply it once to the latest page width.
  readerPendingAnchor ??= anchor;
  if (readerAnchorFrame) window.cancelAnimationFrame(readerAnchorFrame);
  readerAnchorFrame = window.requestAnimationFrame(() => {
    readerAnchorFrame = 0;
    const pending = readerPendingAnchor;
    readerPendingAnchor = null;
    if (!pending) return;
    if (state.view !== "reader") return;
    const photo = document.querySelector<HTMLElement>(`.stream-photo[data-index="${pending.index}"]`);
    if (!photo) return;
    const rect = photo.getBoundingClientRect();
    const nextX = rect.left + rect.width * pending.ratioX;
    const nextY = rect.top + rect.height * pending.ratioY;
    resultGrid.scrollBy({
      left: nextX - pending.clientX,
      top: nextY - pending.clientY,
      behavior: "auto",
    });
  });
}

function commitReaderZoom() {
  if (readerZoomCommitTimer) {
    window.clearTimeout(readerZoomCommitTimer);
    readerZoomCommitTimer = 0;
  }
  resultGrid.classList.remove("reader-zooming");
  saveReaderPrefs();
  broadcastReaderPrefs();
  if (readerSettingsOpen) buildReaderSettingsPanel();
  window.requestAnimationFrame(redrawReaderOverlays);
}

function scheduleReaderZoomCommit() {
  if (readerZoomCommitTimer) window.clearTimeout(readerZoomCommitTimer);
  readerZoomCommitTimer = window.setTimeout(commitReaderZoom, 160);
}

function setReaderZoom(value: number, clientX?: number, clientY?: number) {
  if (state.view !== "reader") return;
  const next = normalizeReaderZoom(value);
  if (Math.abs(next - state.readerZoom) < 0.001) return;
  const leavingPagedFit = state.readerFit !== "width";
  const currentIndex = currentStreamIndex();

  const anchor = leavingPagedFit ? null : captureReaderAnchor(clientX, clientY);
  if (leavingPagedFit) {
    state.readerFit = "width";
    shell.dataset.readerFit = "width";
    showToast("已切换到连续阅读，可自由缩放", "info", 2200);
  }
  state.readerZoom = next;
  resultGrid.classList.add("reader-zooming");
  applyReaderZoomLayout();
  syncReaderPageControls();
  if (leavingPagedFit) {
    window.requestAnimationFrame(() => {
      scrollToStreamIndex(Math.max(0, currentIndex), "auto");
      setupStreamObserver();
    });
  } else {
    restoreReaderAnchor(anchor);
  }
  scheduleReaderZoomCommit();
}

function adjustReaderZoom(delta: number) {
  const next = Math.round((state.readerZoom + delta) * 10) / 10;
  setReaderZoom(next);
}

// ---- 本地 OCR (文字区域框选) ----

const OCR_BATCH = 4;
const ocrPendingIndices = new Set<number>();
let ocrBatchRunning = false;
let readerPipelineEpoch = 0;
// OCR 开关竞态令牌:引擎初始化期间开关被再次切换时,用来取消过期的“开启”请求
let ocrEnableToken = 0;
// 文字框红框仅调试用，默认不画；保留已有本地调试设置。
const ocrBoxDebug = (() => {
  try {
    return localStorage.getItem("wnacg.debugOcrBoxes.v1") === "1";
  } catch {
    return false;
  }
})();
const ocrTextPending = new Set<number>();
const ocrTextInFlight = new Set<number>();
const ocrTextDone = new Set<number>();
let ocrTextWorkers = 0;
const OCR_TEXT_CONCURRENCY = 2;
let ocrCapabilities: OcrCapabilities = {
  vision: !/Windows/i.test(navigator.userAgent),
  manga: true,
};

function enforceOcrCapabilities(capabilities: OcrCapabilities) {
  ocrCapabilities = capabilities;
  if (!capabilities.vision && state.ocrLang === "zh") {
    state.ocrLang = "ja";
    state.translateEnabled = false;
    saveReaderPrefs();
    applyReaderPrefs();
    syncReaderControls();
    broadcastReaderPrefs();
  }
  if (readerSettingsOpen) buildReaderSettingsPanel();
}

async function refreshOcrCapabilities() {
  try {
    const capabilities = await invokeTauri<OcrCapabilities>("ocr_capabilities");
    if (typeof capabilities?.vision !== "boolean" || typeof capabilities?.manga !== "boolean") {
      return;
    }
    enforceOcrCapabilities(capabilities);
  } catch (error) {
    console.error("ocr_capabilities failed:", error);
  }
}

function ocrLanguages(): string[] {
  return state.ocrLang === "zh"
    ? ["zh-Hans", "zh-Hant", "ja-JP", "en-US"]
    : ["ja-JP", "zh-Hans", "zh-Hant", "en-US"];
}

function normalizeOcrLanguage(value: unknown): "zh" | "ja" | null {
  if (value === "ja") return "ja";
  if (value === "zh") return ocrCapabilities.vision ? "zh" : "ja";
  return null;
}

function ocrEngine(): string {
  // 日文优先:漫画专用本地引擎(竖排日文);中文优先:Apple Vision(横排中文)
  return state.ocrLang === "ja" || !ocrCapabilities.vision ? "manga" : "vision";
}

function ocrModelProgressMessage(progress: OcrModelProgress) {
  const file = progress.fileIndex > 0 && progress.fileCount > 0
    ? `（${progress.fileIndex}/${progress.fileCount}）`
    : "";
  switch (progress.phase) {
    case "migrating":
      return "正在迁移已有 OCR 模型…";
    case "downloading":
      return `正在下载 OCR 模型 ${progress.percent}%${file} · ${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`;
    case "verifying":
      return `正在校验 OCR 模型${file}…`;
    case "ready":
      return "OCR 模型已就绪，正在启动引擎…";
    default:
      return `正在检查本地 OCR 模型${file}…`;
  }
}

const ocrEngineInitializations = new Map<string, Promise<void>>();

async function runOcrEngineInitialization(engine: string) {
  const toast = showToast(
    engine === "manga" ? "正在检查本地 OCR 模型…" : "正在初始化本地 OCR 引擎…",
    "info",
    0,
  );
  toast.setProgress(null);
  const requestId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `ocr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let unlistenProgress: (() => void) | null = null;
  try {
    unlistenProgress = await listen<OcrModelProgress>("ocr-model-progress", (event) => {
      const progress = event.payload;
      // Model installation is shared across app windows. Accept the active
      // installer's events so a second reader window waiting on the lock also
      // gains real progress instead of remaining indeterminate.
      if (engine !== "manga") return;
      toast.update(ocrModelProgressMessage(progress));
      toast.setProgress(progress.phase === "downloading" || progress.phase === "ready"
        ? progress.percent
        : null);
    });
    await invokeTauri<string>("ocr_engine_status", { engine, requestId });
  } finally {
    unlistenProgress?.();
    toast();
  }
}

function ensureOcrEngineInitialized(engine = ocrEngine()) {
  const existing = ocrEngineInitializations.get(engine);
  if (existing) return existing;
  let initialization: Promise<void>;
  initialization = runOcrEngineInitialization(engine).catch((error) => {
    if (ocrEngineInitializations.get(engine) === initialization) {
      ocrEngineInitializations.delete(engine);
    }
    throw error;
  });
  ocrEngineInitializations.set(engine, initialization);
  return initialization;
}

function isVisiblePage(index: number): boolean {
  const current = currentStreamIndex();
  return index === current || (state.readerFit === "spread" && index === current + 1);
}

function isNearPage(index: number): boolean {
  // 翻译预取窗口:当前页前 1 后 3,提前识别+翻译,滚动过去时基本已就绪
  if (index < 0 || index >= state.photos.length) return false;
  const current = currentStreamIndex();
  return index >= current - 1 && index <= current + 3;
}

function ocrWindowOrder(index: number): number[] {
  // Perceived speed matters most: current page first, then what the reader is
  // about to see. The previous page is only a low-priority safety net.
  return [index, index + 1, index + 2, index + 3, index - 1]
    .filter((page, offset, pages) => (
      page >= 0 && page < state.photos.length && pages.indexOf(page) === offset
    ));
}

function queueOcrWindow(index: number) {
  // 翻译开启:当前页前后窗口全部预识别+预翻译;关闭:只补当前页文字
  for (const i of ocrWindowOrder(index)) {
    if (state.translateEnabled) {
      queueOcrText(i);
      queueTranslate(i);
    } else if (i === index) {
      queueOcrText(i);
    }
  }
  if (state.translateEnabled) {
    // 预取前方图片,让 OCR/翻译提前跑起来(翻译开启时不受省流限制)
    for (const offset of [1, 2]) {
      const ahead = index + offset;
      if (ahead >= 0 && ahead < state.photos.length && !state.preloadedUrls[ahead]) {
        void preloadFullImage(ahead);
      }
    }
  }
  updateTranslateBadges();
}

async function toggleReaderOcr(force?: boolean) {
  const next = force ?? !state.ocrEnabled;
  if (next === state.ocrEnabled) return;
  const token = ++ocrEnableToken;
  if (!next) {
    updateReaderPrefs({ ocrBoxes: false });
    return;
  }

  const engine = ocrEngine();
  try {
    await ensureOcrEngineInitialized(engine);
    if (token !== ocrEnableToken) {
      // 等待引擎期间开关又被切换(比如 R 关了联动把 O 关掉),放弃本次开启
      return;
    }
    updateReaderPrefs({ ocrBoxes: true });
    showToast("本地 OCR 已开启", "success", 2600);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`本地 OCR 不可用：${message}`, "error", 4800);
  }
}

function getDisplayDataUrl(index: number): string | null {
  const preloaded = state.preloadedUrls[index];
  if (preloaded && preloaded.startsWith("data:")) return preloaded;

  const container = document.querySelector<HTMLElement>(`.stream-photo[data-index="${index}"]`);
  const streamImg = container?.querySelector<HTMLImageElement>(".stream-img");
  if (streamImg?.src && streamImg.src.startsWith("data:")) return streamImg.src;
  return null;
}

function getOcrSources(index: number): { imageUrl: string | null; dataUrl: string | null } | null {
  const imageUrl = state.imageUrls[index] || null;
  const dataUrl = getDisplayDataUrl(index);
  if (!imageUrl && !dataUrl) return null;
  return { imageUrl, dataUrl };
}

function queueOcr(index: number) {
  if (!state.ocrEnabled) return;
  if (index < 0 || index >= state.photos.length) return;
  if (state.translateEnabled && state.ocrLang === "ja") {
    // Translation needs recognized text, so a detection-only pass would be
    // thrown away immediately. Go straight to the full single pass.
    queueOcrText(index);
    return;
  }
  if (state.ocrRegions[index] !== undefined || state.ocrFailed[index]) return;
  if (ocrPendingIndices.has(index)) return;
  if (!getOcrSources(index)) return; // 图片还没就绪,等加载后再触发
  ocrPendingIndices.add(index);
  pumpOcrQueue();
}

async function pumpOcrQueue() {
  if (ocrBatchRunning || !state.ocrEnabled) return;

  const items: Array<{ index: number; imageUrl: string | null; dataUrl: string | null }> = [];
  for (const index of ocrPendingIndices) {
    const sources = getOcrSources(index);
    if (!sources) continue;
    items.push({ index, imageUrl: sources.imageUrl, dataUrl: sources.dataUrl });
    if (items.length >= OCR_BATCH) break;
  }
  if (items.length === 0) {
    ocrPendingIndices.clear();
    return;
  }

  ocrBatchRunning = true;
  const token = state.readerToken;
  const aid = state.currentAlbum?.aid;
  const epoch = readerPipelineEpoch;
  const engine = ocrEngine();
  try {
    await ensureOcrEngineInitialized(engine);
    if (token !== state.readerToken || aid !== state.currentAlbum?.aid || epoch !== readerPipelineEpoch || state.view !== "reader") return;
    const results = await invokeTauri<OcrPageResult[]>("ocr_pages", {
      pages: items.map((item) => ({
        index: item.index,
        imageUrl: item.imageUrl,
        dataUrl: item.imageUrl && ocrByteCacheUrls.has(item.imageUrl) ? null : item.dataUrl,
        languages: ocrLanguages(),
        engine,
        withText: false,
      })),
    });
    if (token !== state.readerToken || aid !== state.currentAlbum?.aid || epoch !== readerPipelineEpoch || state.view !== "reader") return;
    for (const result of results) {
      ocrPendingIndices.delete(result.index);
      if (result.error) {
        if (result.error.includes("等待")) {
          // Rust's byte cache is bounded and may evict a page while the reader
          // still owns its data URL. Forget the optimistic marker and retry
          // once through IPC with the bytes we already have locally.
          const item = items.find((candidate) => candidate.index === result.index);
          if (item?.imageUrl) ocrByteCacheUrls.delete(item.imageUrl);
          if (item?.dataUrl) ocrPendingIndices.add(result.index);
        } else {
          state.ocrFailed[result.index] = result.error;
        }
      } else {
        state.ocrRegions[result.index] = result.regions;
      }
    }
    if (token === state.readerToken && state.view === "reader") {
      for (const result of results) {
        renderStreamOcrOverlay(result.index);
        if (state.translateEnabled) {
          renderTranslateBadge(result.index);
        }
        if (
          !result.error
          && state.ocrLang === "ja"
          && (isVisiblePage(result.index) || (state.translateEnabled && isNearPage(result.index)))
        ) {
          queueOcrText(result.index);
        }
      }
    }
  } catch (error) {
    if (token !== state.readerToken || aid !== state.currentAlbum?.aid || epoch !== readerPipelineEpoch || state.view !== "reader") return;
    const message = error instanceof Error ? error.message : String(error);
    for (const item of items) {
      ocrPendingIndices.delete(item.index);
      state.ocrFailed[item.index] = message;
      renderTranslateBadge(item.index);
    }
    showToast(`OCR 失败：${message}`, "error", 4200);
  } finally {
    if (token !== state.readerToken || aid !== state.currentAlbum?.aid || epoch !== readerPipelineEpoch) return;
    ocrBatchRunning = false;
    if (state.ocrEnabled && state.view === "reader") {
      window.setTimeout(() => pumpOcrQueue(), 0);
    }
  }
}

// 文字识别补跑:漫画引擎先出框(快),再对当前可见页补识别文字(慢),不阻塞浏览
function queueOcrText(index: number) {
  if (!state.ocrEnabled || state.ocrLang !== "ja") return;
  if (index < 0 || index >= state.photos.length) return;
  if (!state.translateEnabled && state.ocrRegions[index] === undefined) return;
  if (state.ocrFailed[index]) return;
  if (ocrTextDone.has(index) || ocrTextPending.has(index) || ocrTextInFlight.has(index)) return;
  if (!getOcrSources(index)) return;
  ocrTextPending.add(index);
  pumpOcrTextQueue();
}

function nextOcrTextIndex(): number | null {
  const center = currentStreamIndex();
  const preferred = center >= 0 ? ocrWindowOrder(center) : [];
  for (const index of preferred) {
    if (ocrTextPending.has(index) && getOcrSources(index)) return index;
  }
  for (const index of ocrTextPending) {
    if (getOcrSources(index)) return index;
  }
  return null;
}

function pumpOcrTextQueue() {
  if (!state.ocrEnabled || state.ocrLang !== "ja") return;
  while (ocrTextWorkers < OCR_TEXT_CONCURRENCY) {
    const index = nextOcrTextIndex();
    if (index === null) return;
    const sources = getOcrSources(index);
    if (!sources) {
      ocrTextPending.delete(index);
      continue;
    }
    ocrTextPending.delete(index);
    ocrTextInFlight.add(index);
    ocrTextWorkers++;
    const token = state.readerToken;
    const aid = state.currentAlbum?.aid;
    const epoch = readerPipelineEpoch;
    void ensureOcrEngineInitialized("manga").then(() => invokeTauri<OcrPageResult[]>("ocr_pages", {
      pages: [{
        index,
        imageUrl: sources.imageUrl,
        // Rust uses its byte cache whenever imageUrl is present. Avoid sending
        // the multi-megabyte data URL through IPC in that common path.
        dataUrl: sources.imageUrl && ocrByteCacheUrls.has(sources.imageUrl) ? null : sources.dataUrl,
        languages: ocrLanguages(),
        engine: "manga",
        withText: true,
      }],
    })).then((results) => {
      if (token !== state.readerToken || aid !== state.currentAlbum?.aid || epoch !== readerPipelineEpoch || state.view !== "reader") return;
      const result = results[0];
      if (!result) throw new Error("OCR 返回为空");
      if (result.error) {
        if (result.error.includes("等待")) {
          if (sources.imageUrl) ocrByteCacheUrls.delete(sources.imageUrl);
          if (sources.dataUrl) ocrTextPending.add(index);
        } else {
          state.ocrFailed[index] = result.error;
          renderTranslateBadge(index);
        }
        return;
      }
      state.ocrRegions[index] = result.regions;
      ocrTextDone.add(index);
      renderStreamOcrOverlay(index);
      if (state.translateEnabled) {
        renderTranslateBadge(index);
        queueTranslate(index);
      }
    }).catch((error) => {
      if (token !== state.readerToken || aid !== state.currentAlbum?.aid || epoch !== readerPipelineEpoch || state.view !== "reader") return;
      const message = error instanceof Error ? error.message : String(error);
      state.ocrFailed[index] = message;
      renderTranslateBadge(index);
      showToast(`文字识别失败：${message}`, "error", 4200);
    }).finally(() => {
      if (token === state.readerToken && aid === state.currentAlbum?.aid && epoch === readerPipelineEpoch) {
        ocrTextInFlight.delete(index);
        ocrTextWorkers = Math.max(0, ocrTextWorkers - 1);
        if (state.ocrEnabled && state.ocrLang === "ja") pumpOcrTextQueue();
      }
    });
  }
}

// ---- 翻译字幕:遮住原文 + DeepSeek 翻译 ----

const translatePending = new Set<number>();
const translateInFlight = new Set<number>();
const translateDone = new Set<number>();
let translateWorkers = 0;
const TRANSLATE_CONCURRENCY = 3;
let translateInitializing = false;
let translateEnableToken = 0;

function resetReaderPipelines(clearPreloads = false) {
  readerPipelineEpoch++;
  ocrPendingIndices.clear();
  ocrBatchRunning = false;
  ocrTextPending.clear();
  ocrTextInFlight.clear();
  ocrTextDone.clear();
  ocrTextWorkers = 0;
  translatePending.clear();
  translateInFlight.clear();
  translateDone.clear();
  translateWorkers = 0;
  if (clearPreloads) {
    preloadInFlight.clear();
    ocrByteCacheUrls.clear();
    clearPreloadPool();
  }
}

async function toggleReaderTranslate(force?: boolean) {
  const next = force ?? !(state.translateEnabled || translateInitializing);
  if (!next) {
    if (!state.translateEnabled && !translateInitializing) return;
    translateEnableToken++;
    translateInitializing = false;
    ocrEnableToken++;
    if (state.translateEnabled) updateReaderPrefs({ translateMode: false });
    else syncReaderControls();
    return;
  }
  if (state.translateEnabled || translateInitializing) return;
  if (!(await ensureDeepseekKeyForTranslation())) return;

  const token = ++translateEnableToken;
  translateInitializing = true;
  syncReaderControls();
  try {
    if (state.ocrLang !== "ja") {
      updateReaderPrefs({ ocrLang: "ja" });
    }
    if (!state.ocrEnabled) {
      await toggleReaderOcr(true);
    }
    if (token !== translateEnableToken || !translateInitializing || !state.ocrEnabled) return;
    updateReaderPrefs({ translateMode: true });
    queueOcrWindow(currentStreamIndex());
    showToast("翻译已开启，正在识别当前页…", "info", 3200);
  } finally {
    if (token === translateEnableToken) {
      translateInitializing = false;
      syncReaderControls();
    }
  }
}

function queueTranslate(index: number) {
  if (!state.translateEnabled || state.ocrLang !== "ja") return;
  if (index < 0 || index >= state.photos.length) return;
  const regions = state.ocrRegions[index];
  if (!regions) return;
  if (regions.length === 0) {
    if (ocrTextDone.has(index)) {
      translateDone.add(index);
      renderTranslateBadge(index);
    }
    return;
  }
  if (state.translateTexts[index]) {
    // 已缓存过译文的页面,重新开启翻译时直接重画
    translateDone.add(index);
    renderTranslateOverlay(index);
    return;
  }
  if (translateDone.has(index) || translatePending.has(index) || translateInFlight.has(index)) return;
  if (!ocrTextDone.has(index)) {
    // 文字识别还没补跑完,先补文字,完成后会再次触发翻译
    queueOcrText(index);
    return;
  }
  if (!regions.some((r) => r.text.trim())) {
    translateDone.add(index); // 没有可翻译的文字,直接标记完成,避免徽标卡住
    renderTranslateBadge(index);
    return;
  }
  translatePending.add(index);
  renderTranslateBadge(index);
  pumpTranslateQueue();
}

function nextTranslateIndex(): number | null {
  const center = currentStreamIndex();
  const preferred = center >= 0 ? ocrWindowOrder(center) : [];
  for (const index of preferred) {
    if (translatePending.has(index)) return index;
  }
  return translatePending.values().next().value ?? null;
}

function pumpTranslateQueue() {
  if (!state.translateEnabled || state.ocrLang !== "ja") return;
  while (translateWorkers < TRANSLATE_CONCURRENCY) {
    const index = nextTranslateIndex();
    if (index === null) return;
    translatePending.delete(index);
    const regions = state.ocrRegions[index];
    if (state.ocrFailed[index] || !regions || regions.length === 0) continue;
    if (!ocrTextDone.has(index)) {
      queueOcrText(index);
      continue;
    }
    const texts = regions.map((region) => region.text);
    const token = state.readerToken;
    const aid = state.currentAlbum?.aid;
    const epoch = readerPipelineEpoch;
    translateInFlight.add(index);
    translateWorkers++;
    void invokeTauri<string[]>("translate_dialogue", { texts }).then((translated) => {
      if (token !== state.readerToken || aid !== state.currentAlbum?.aid || epoch !== readerPipelineEpoch || state.view !== "reader") return;
      translateDone.add(index);
      if (translated.length === texts.length) state.translateTexts[index] = translated;
      renderTranslateOverlay(index);
      renderTranslateBadge(index);
    }).catch((error) => {
      if (token !== state.readerToken || aid !== state.currentAlbum?.aid || epoch !== readerPipelineEpoch || state.view !== "reader") return;
      const message = error instanceof Error ? error.message : String(error);
      state.translateFailed[index] = message;
      renderTranslateBadge(index);
      showToast(`翻译失败：${message}`, "error", 4800);
    }).finally(() => {
      if (token === state.readerToken && aid === state.currentAlbum?.aid && epoch === readerPipelineEpoch) {
        translateInFlight.delete(index);
        translateWorkers = Math.max(0, translateWorkers - 1);
        pumpTranslateQueue();
      }
    });
  }
}

function renderTranslateOverlay(index: number) {
  const container = document.querySelector<HTMLElement>(`.stream-photo[data-index="${index}"]`);
  if (!container) return;
  const img = container.querySelector<HTMLImageElement>(".stream-img");
  if (!img || !img.complete || img.naturalWidth === 0) return;
  container.querySelector(".stream-translate-overlay")?.remove();
  if (!state.translateEnabled) return;

  const regions = state.ocrRegions[index];
  const texts = state.translateTexts[index];
  if (!regions || !texts) return;

  const canvas = document.createElement("canvas");
  canvas.className = "stream-translate-overlay";
  // Keep the backing bitmap near the 100% memory budget as pages grow. The
  // canvas is still displayed at the exact layout size, but extreme reader
  // zoom cannot multiply every nearby translation overlay's memory by 6.25x.
  const dpr = Math.max(
    0.6,
    Math.min(1.5, window.devicePixelRatio || 1, 1.5 / Math.max(1, state.readerZoom)),
  );
  const w = img.offsetWidth;
  const h = img.offsetHeight;
  if (w < 4 || h < 4) return;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.left = `${img.offsetLeft}px`;
  canvas.style.top = `${img.offsetTop}px`;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const sampler = ensureSampleCanvas(img);
  ctx.scale(dpr, dpr);
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    const translated = texts[i]?.trim();
    if (!translated) continue;
    const x = region.x * w;
    const y = region.y * h;
    const rw = region.w * w;
    const rh = region.h * h;
    if (rw < 4 || rh < 4) continue;
    drawCoverAndText(ctx, sampler, x, y, rw, rh, translated);
  }
  container.append(canvas);
  attachTranslateTooltip(canvas, regions);
  renderTranslateBadge(index);
}

function drawCoverAndText(
  ctx: CanvasRenderingContext2D,
  sampler: ImageSampler,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
) {
  text = normalizeCjkText(text);
  const fill = sampleBoxColor(sampler, x, y, w, h);
  const [fr, fg, fb] = parseRgb(fill);
  const fillLuminance = 0.299 * fr + 0.587 * fg + 0.114 * fb;
  const textColor = resolveTextColor(sampler, x, y, w, h, fillLuminance);
  ctx.save();
  ctx.fillStyle = fill;
  ctx.beginPath();
  const radius = Math.min(12, w * 0.1, h * 0.1);
  roundRect(ctx, x, y, w, h, radius);
  ctx.fill();
  // 边缘柔化:两层同色低透明度描边,向外过渡更自然
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = Math.min(4, Math.max(2, w * 0.015));
  ctx.strokeStyle = fill;
  roundRect(ctx, x, y, w, h, radius);
  ctx.stroke();
  ctx.globalAlpha = 0.15;
  ctx.lineWidth = Math.min(9, Math.max(4, w * 0.03));
  ctx.stroke();
  ctx.globalAlpha = 1;

  const darkText = textColor.luminance > fillLuminance;
  ctx.fillStyle = textColor.color;
  ctx.textBaseline = "middle";
  if (!darkText) {
    // 浅色文字(白/亮字)加一点阴影,保证可读
    ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
    ctx.shadowBlur = 2;
    ctx.shadowOffsetY = 1;
  }
  const vertical = h > w * 1.15 && h > 40;
  if (vertical) {
    drawVerticalText(ctx, text, x, y, w, h);
  } else {
    drawHorizontalText(ctx, text, x, y, w, h);
  }
  ctx.restore();
}

function resolveTextColor(
  sampler: ImageSampler,
  x: number,
  y: number,
  w: number,
  h: number,
  fillLuminance: number,
): { color: string; luminance: number } {
  const sampled = sampleTextColor(sampler, x, y, w, h, fillLuminance);
  const base = sampled ?? (fillLuminance > 150 ? "#1c1c1c" : "#ffffff");
  const [tr, tg, tb] = parseRgb(base);
  let luminance = 0.299 * tr + 0.587 * tg + 0.114 * tb;
  let color = base;
  // 对比度兜底:文字色和底色太接近时,按底色明暗强制黑/白,保证可读
  if (Math.abs(luminance - fillLuminance) < 70) {
    color = fillLuminance > 150 ? "#1c1c1c" : "#ffffff";
    luminance = fillLuminance > 150 ? 20 : 255;
  }
  return { color, luminance };
}

function parseRgb(color: string): [number, number, number] {
  const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [255, 255, 255];
}

function normalizeCjkText(text: string): string {
  // 半角省略号/波浪线/感叹问号统一为全角,竖排时才不会出现散落的小圆点
  return text
    .replace(/\.\.\.+/g, "…")
    .replace(/~/g, "～")
    .replace(/!/g, "！")
    .replace(/\?/g, "？")
    .replace(/\./g, "。");
}

const MANGA_FONT_FAMILY =
  `"圆体-简", "Yuanti SC", "Hiragino Maru Gothic ProN", ` +
  `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;

// 单张复用取色画布,限制分辨率避免大图占内存
const SAMPLE_MAX_DIM = 1200;
let sampleCanvas: HTMLCanvasElement | null = null;

type ImageSampler = {
  sample: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  scaleX: number;
  scaleY: number;
};

function sampleBoxColor(sampler: ImageSampler, x: number, y: number, w: number, h: number): string {
  const { sample, ctx, scaleX, scaleY } = sampler;
  if (!ctx) return "#ffffff";
  // 采样点放在框外一圈:取最亮(色值最大)的采样点,白色气泡就得到纯白
  const pad = Math.max(3, Math.min(10, w * 0.08, h * 0.08));
  const points: Array<[number, number]> = [
    [x - pad, y - pad], [x + w / 2, y - pad], [x + w + pad, y - pad],
    [x - pad, y + h / 2], [x + w + pad, y + h / 2],
    [x - pad, y + h + pad], [x + w / 2, y + h + pad], [x + w + pad, y + h + pad],
  ];
  let best: [number, number, number] | null = null;
  let bestLum = -1;
  for (const [px, py] of points) {
    const sx = Math.round(px * scaleX);
    const sy = Math.round(py * scaleY);
    if (sx < 0 || sy < 0 || sx >= sample.width || sy >= sample.height) continue;
    const data = ctx.getImageData(sx, sy, 1, 1).data;
    if (data[3] === 0) continue;
    const lum = 0.299 * data[0] + 0.587 * data[1] + 0.114 * data[2];
    if (lum > bestLum) {
      bestLum = lum;
      best = [data[0], data[1], data[2]];
    }
  }
  if (!best) return "#ffffff";
  return `rgb(${Math.round(best[0])},${Math.round(best[1])},${Math.round(best[2])})`;
}

// 在原图区域内统计"笔墨"颜色(与底色差异大的像素),取多数一方的平均色
function sampleTextColor(
  sampler: ImageSampler,
  x: number,
  y: number,
  w: number,
  h: number,
  fillLuminance: number,
): string | null {
  const { sample, ctx, scaleX, scaleY } = sampler;
  if (!ctx) return null;
  const sx0 = Math.max(0, Math.round(x * scaleX));
  const sy0 = Math.max(0, Math.round(y * scaleY));
  const sw = Math.max(1, Math.round(w * scaleX));
  const sh = Math.max(1, Math.round(h * scaleY));
  if (sx0 >= sample.width || sy0 >= sample.height) return null;
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(sx0, sy0, Math.min(sw, sample.width - sx0), Math.min(sh, sample.height - sy0)).data;
  } catch {
    return null;
  }
  type ColorBin = { count: number; r: number; g: number; b: number };
  const bins: ColorBin[] = Array.from({ length: 16 }, () => ({ count: 0, r: 0, g: 0, b: 0 }));
  const regionWidth = Math.min(sw, sample.width - sx0);
  const regionHeight = Math.min(sh, sample.height - sy0);
  // Cap work per region. Manga balloons have broad flat areas, so a sparse
  // regular sample is both faster and more stable than sorting every pixel.
  const step = Math.max(1, Math.floor(Math.sqrt((regionWidth * regionHeight) / 2400)));
  let darkCount = 0;
  let lightCount = 0;
  for (let py = 0; py < regionHeight; py += step) {
    for (let px = 0; px < regionWidth; px += step) {
      const i = (py * regionWidth + px) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (Math.abs(lum - fillLuminance) < 30) continue;
      const bin = bins[Math.min(15, Math.floor(lum / 16))];
      bin.count++;
      bin.r += r;
      bin.g += g;
      bin.b += b;
      if (lum < fillLuminance) darkCount++;
      else lightCount++;
    }
  }
  const total = darkCount + lightCount;
  if (total < 12) return null;
  const averageExtreme = (takeDarkest: boolean, population: number) => {
    const target = Math.max(4, Math.ceil(population * 0.12));
    let count = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let offset = 0; offset < bins.length && count < target; offset++) {
      const bin = bins[takeDarkest ? offset : bins.length - 1 - offset];
      if (bin.count === 0) continue;
      count += bin.count;
      r += bin.r;
      g += bin.g;
      b += bin.b;
    }
    if (count === 0) return null;
    return `rgb(${Math.round(r / count)},${Math.round(g / count)},${Math.round(b / count)})`;
  };
  if (darkCount >= lightCount && darkCount >= total * 0.3) {
    return averageExtreme(true, darkCount); // 取最暗一簇,贴近真实墨色
  }
  if (lightCount > darkCount && lightCount >= total * 0.3) {
    return averageExtreme(false, lightCount); // 取最亮一簇(白字/亮字)
  }
  return null;
}

function ensureSampleCanvas(img: HTMLImageElement): ImageSampler {
  if (!sampleCanvas) {
    sampleCanvas = document.createElement("canvas");
  }
  const sample = sampleCanvas;
  const scale = Math.min(1, SAMPLE_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
  sample.width = Math.max(1, Math.round(img.naturalWidth * scale));
  sample.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = sample.getContext("2d", { willReadFrequently: true });
  ctx?.drawImage(img, 0, 0, sample.width, sample.height);
  const scaleX = sample.width / (img.offsetWidth || img.naturalWidth);
  const scaleY = sample.height / (img.offsetHeight || img.naturalHeight);
  return { sample, ctx, scaleX, scaleY };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawHorizontalText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const fontFamily = MANGA_FONT_FAMILY;
  const padding = Math.max(2, w * 0.04);
  const innerW = w - padding * 2;
  const innerH = h - padding * 2;
  // 漫画嵌字常用轻微字距,Chrome 的 measureText 会一并计入
  ctx.letterSpacing = "0.05em";
  let fontSize = Math.max(9, Math.min(h * 0.48, innerW / 2.0));
  const fit = () => {
    while (fontSize > 7) {
      ctx.font = `700 ${fontSize}px ${fontFamily}`;
      const lines = wrapText(ctx, text, innerW);
      if (lines.length * fontSize * 1.32 <= innerH) {
        return lines;
      }
      fontSize -= 1;
    }
    ctx.font = `700 ${fontSize}px ${fontFamily}`;
    return wrapText(ctx, text, innerW);
  };
  const lines = fit();
  const lineHeight = fontSize * 1.32;
  const totalH = lines.length * lineHeight;
  let ty = y + (h - totalH) / 2 + lineHeight / 2;
  for (const line of lines) {
    const tw = ctx.measureText(line).width;
    ctx.fillText(line, x + (w - tw) / 2, ty);
    ty += lineHeight;
  }
}

// 行首禁则:这些标点不放在行首,漫画嵌字排版规范
const LINE_START_BAN = new Set([
  "，", "。", "、", "！", "？", "；", "：", "”", "』", "」", "）", "〉", "》",
  "]", ")", "!", "?", ".", ",", "…", "—", "～",
]);

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    const test = line + ch;
    if (line && ctx.measureText(test).width > maxWidth) {
      if (LINE_START_BAN.has(ch)) {
        lines.push(line + ch);
        line = "";
      } else {
        lines.push(line);
        line = ch;
      }
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [text];
}

function drawVerticalText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const fontFamily = MANGA_FONT_FAMILY;
  const padding = Math.max(2, w * 0.06);
  const innerW = w - padding * 2;
  const innerH = h - padding * 2;
  ctx.letterSpacing = "0em";
  let fontSize = Math.max(9, Math.min(innerW * 0.95, innerH / 4.2));
  const fit = () => {
    while (fontSize > 7) {
      ctx.font = `700 ${fontSize}px ${fontFamily}`;
      const columns = Math.ceil(text.length * fontSize / innerH);
      if (columns * fontSize <= innerW) return columns;
      fontSize -= 1;
    }
    ctx.font = `700 ${fontSize}px ${fontFamily}`;
    return Math.ceil(text.length * fontSize / innerH);
  };
  const columns = fit();
  const perColumn = Math.floor(innerH / fontSize);
  // 文字块整体居中于气泡:最右列中心 = 气泡中心 + 块宽一半 - 半字宽
  const startX = x + w / 2 + (fontSize * columns - fontSize) / 2;
  const step = fontSize * 1.05; // 竖排字间留一丝空气,避免过挤
  ctx.textAlign = "center";
  let cx = startX;
  for (let i = 0; i < text.length; i += perColumn) {
    const slice = Array.from(text.slice(i, i + perColumn));
    let cy = y + padding + fontSize / 2;
    for (const ch of slice) {
      if (VERT_ROTATE.has(ch)) {
        // 竖排标点与字母数字转 90°,符合中文/日文竖排习惯
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Math.PI / 2);
        ctx.fillText(ch, 0, 0);
        ctx.restore();
      } else {
        ctx.fillText(ch, cx, cy);
      }
      cy += step;
    }
    cx -= fontSize;
  }
  ctx.textAlign = "start";
}

const VERT_ROTATE = new Set([
  "，", "。", "、", "！", "？", "；", "：", "…", "～", "—", "ー",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
  "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
  "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
]);

function removeAllTranslateOverlays() {
  document.querySelectorAll<HTMLCanvasElement>(".stream-translate-overlay").forEach((canvas) => {
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
  });
  hideTranslateTooltip();
}

function pruneTranslateOverlays(center: number) {
  document.querySelectorAll<HTMLCanvasElement>(".stream-translate-overlay").forEach((canvas) => {
    const page = Number(canvas.closest<HTMLElement>(".stream-photo")?.dataset.index);
    if (Number.isFinite(page) && Math.abs(page - center) <= 2) return;
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
  });
}

// ---- 翻译状态徽标:让用户感知识别与翻译阶段 ----

type TranslatePhase = "idle" | "recognizing" | "translating" | "done" | "failed";

function translationFailure(index: number): string | undefined {
  return state.translateFailed[index] || state.ocrFailed[index];
}

function translatePhase(index: number): TranslatePhase {
  if (!state.translateEnabled || index < 0 || index >= state.photos.length) return "idle";
  if (translationFailure(index)) return "failed";
  if (translateDone.has(index)) return "done";
  if (!ocrTextDone.has(index)) return "recognizing";
  if (translatePending.has(index) || translateInFlight.has(index)) return "translating";
  return "translating";
}

function renderTranslateBadge(index: number) {
  refreshTranslateStatus();
  const container = document.querySelector<HTMLElement>(`.stream-photo[data-index="${index}"]`);
  if (!container) return;
  container.querySelector(".stream-translate-badge")?.remove();
  if (!state.translateEnabled) return;
  const failed = translationFailure(index);
  const phase = translatePhase(index);
  if (!failed && phase !== "recognizing" && phase !== "translating") return;

  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = failed ? "translate-badge stream-translate-badge failed" : "translate-badge stream-translate-badge";
  badge.textContent = failed
    ? "翻译失败 · 点击重试"
    : phase === "recognizing" ? "识别中…" : "翻译中…";
  badge.addEventListener("click", (event) => {
    event.stopPropagation();
    if (failed) {
      delete state.translateFailed[index];
      delete state.ocrFailed[index];
      ocrTextDone.delete(index);
      translateDone.delete(index);
      queueOcrText(index);
      queueTranslate(index);
      renderTranslateBadge(index);
    }
  });
  container.append(badge);
}

function updateTranslateBadges() {
  const indices: number[] = [];
  const current = currentStreamIndex();
  for (let i = current - 1; i <= current + 3; i++) {
    if (i >= 0 && i < state.photos.length) indices.push(i);
  }
  for (const index of indices) renderTranslateBadge(index);
  refreshTranslateStatus();
}

// ---- 悬停原文提示:翻译后鼠标移到译文字块上,可查看原文 ----

let translateTooltip: HTMLElement | null = null;

function showTranslateTooltip(text: string, clientX: number, clientY: number) {
  if (!translateTooltip) {
    translateTooltip = document.createElement("div");
    translateTooltip.className = "translate-tooltip";
    translateTooltip.setAttribute("aria-hidden", "true");
    document.body.append(translateTooltip);
  }
  translateTooltip.textContent = text;
  translateTooltip.style.left = `${Math.min(clientX + 14, window.innerWidth - 280)}px`;
  translateTooltip.style.top = `${Math.min(clientY + 14, window.innerHeight - 90)}px`;
  translateTooltip.hidden = false;
}

function hideTranslateTooltip() {
  if (translateTooltip) translateTooltip.hidden = true;
}

function attachTranslateTooltip(
  canvas: HTMLCanvasElement,
  regions: Array<{ text: string; x: number; y: number; w: number; h: number }> | undefined,
) {
  canvas.addEventListener("mousemove", (event) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const nx = (event.clientX - rect.left) / rect.width;
    const ny = (event.clientY - rect.top) / rect.height;
    for (const region of regions ?? []) {
      if (nx >= region.x && nx <= region.x + region.w && ny >= region.y && ny <= region.y + region.h) {
        const ja = region.text.trim();
        if (ja) {
          showTranslateTooltip(ja, event.clientX, event.clientY);
          return;
        }
      }
    }
    hideTranslateTooltip();
  });
  canvas.addEventListener("mouseleave", hideTranslateTooltip);
}

function ocrPrefetchLoadedPages() {
  if (!state.ocrEnabled) return;
  if (state.translateEnabled && state.ocrLang === "ja") {
    const current = currentStreamIndex();
    if (current >= 0) queueOcrWindow(current);
    return;
  }
  document.querySelectorAll<HTMLElement>(".stream-photo[data-state='loaded']").forEach((el) => {
    const index = parseInt(el.dataset.index || "", 10);
    if (!Number.isNaN(index)) queueOcr(index);
  });
}

function renderStreamOcrOverlay(index: number) {
  if (state.translateEnabled || !ocrBoxDebug) return; // 翻译模式/非调试不画红框
  const container = document.querySelector<HTMLElement>(`.stream-photo[data-index="${index}"]`);
  if (!container) return;
  const img = container.querySelector<HTMLImageElement>(".stream-img");
  if (!img) return; // 图片还没就位,加载完成后会重画
  container.querySelector(".stream-ocr-overlay")?.remove();
  const regions = state.ocrRegions[index];
  if (!regions || regions.length === 0) return;

  const overlay = document.createElement("div");
  overlay.className = "stream-ocr-overlay";
  overlay.setAttribute("aria-hidden", "true");
  // 框线对齐实际显示的图片(整页模式下图片可能居中缩放)
  overlay.style.left = `${img.offsetLeft}px`;
  overlay.style.top = `${img.offsetTop}px`;
  overlay.style.width = `${img.offsetWidth}px`;
  overlay.style.height = `${img.offsetHeight}px`;
  for (const region of regions) {
    const box = document.createElement("div");
    box.className = "ocr-box";
    box.style.left = `${region.x * 100}%`;
    box.style.top = `${region.y * 100}%`;
    box.style.width = `${region.w * 100}%`;
    box.style.height = `${region.h * 100}%`;
    if (region.text) box.title = region.text;
    overlay.append(box);
  }
  container.append(overlay);
}

function removeAllOcrOverlays() {
  document.querySelectorAll<HTMLElement>(".stream-ocr-overlay").forEach((el) => {
    el.remove();
  });
}

// 重画当前已加载页面的译文/调试红框(整页模式切换、窗口尺寸变化时对齐会变)
function redrawReaderOverlays() {
  const center = currentStreamIndex();
  document.querySelectorAll<HTMLElement>(".stream-photo[data-state='loaded']").forEach((el) => {
    const index = parseInt(el.dataset.index || "", 10);
    if (Number.isNaN(index)) return;
    if (center >= 0 && Math.abs(index - center) > 2) {
      const canvas = el.querySelector<HTMLCanvasElement>(".stream-translate-overlay");
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();
      }
      return;
    }
    if (state.translateEnabled && state.translateTexts[index]) {
      renderTranslateOverlay(index);
    }
    renderStreamOcrOverlay(index); // 调试红框,内部自行判断是否该画
  });
}

function visibleReaderIndices() {
  const current = currentStreamIndex();
  if (current < 0 || current >= state.photos.length) return [];
  if (state.readerFit === "spread" && current + 1 < state.photos.length) return [current, current + 1];
  return [current];
}

function readerPageStep() {
  return state.readerFit === "spread" ? 2 : 1;
}

function readerRangeLabel(index: number) {
  const total = state.photos.length;
  if (total === 0) return "0 / 0";
  const start = Math.max(0, Math.min(total - 1, index));
  if (state.readerFit !== "spread") return `${start + 1} / ${total}`;
  return `${start + 1}–${Math.min(start + 2, total)} / ${total}`;
}

function syncReaderPageControls() {
  const paged = state.view === "reader" && state.readerFit !== "width" && state.photos.length > 0;
  readerPageControls.hidden = !paged;
  readerZoomControls.hidden = state.view !== "reader" || state.readerFit !== "width";
  if (!paged) return;

  const current = Math.max(0, currentStreamIndex());
  const start = state.readerFit === "spread" ? Math.floor(current / 2) * 2 : current;
  readerPageLabel.textContent = readerRangeLabel(start);
  readerPagePrevButton.disabled = start <= 0;
  readerPageNextButton.disabled = start + readerPageStep() >= state.photos.length;
}

function turnReaderPage(direction: -1 | 1) {
  if (state.view !== "reader" || state.photos.length === 0) return;
  const current = Math.max(0, currentStreamIndex());
  scrollToStreamIndex(current + direction * readerPageStep(), "auto");
}

function updateReaderProgress() {
  const active = state.view === "reader";
  readerProgress.hidden = !active;
  if (!active) {
    readerProgressFill.style.transform = "scaleX(0)";
    readerProgress.removeAttribute("title");
    lastReportedStreamIndex = -1;
    return;
  }
  const horizontal = state.readerFit === "spread";
  const maxScroll = Math.max(
    1,
    horizontal
      ? resultGrid.scrollWidth - resultGrid.clientWidth
      : resultGrid.scrollHeight - resultGrid.clientHeight,
  );
  const currentScroll = horizontal ? resultGrid.scrollLeft : resultGrid.scrollTop;
  const percent = Math.max(0, Math.min(100, (currentScroll / maxScroll) * 100));
  readerProgressFill.style.transform = `scaleX(${percent / 100})`;

  const total = state.photos.length;
  if (total > 0) {
    const current = currentStreamIndex();
    if (current >= 0) {
      const range = readerRangeLabel(current);
      readerProgress.title = `${range} · 点击跳转`;
      if (current !== lastReportedStreamIndex) {
        lastReportedStreamIndex = current;
        setSoftStatus(`正在阅读 ${range}`);
        queueOcrWindow(current);
        pruneTranslateOverlays(current);
      }
    }
  } else {
    readerProgress.removeAttribute("title");
    lastReportedStreamIndex = -1;
  }
  syncReaderPageControls();
}

let lastReportedStreamIndex = -1;
let streamIndexHint = 0;

function currentStreamIndex() {
  const photos = document.querySelectorAll<HTMLElement>(".stream-photo");
  if (photos.length === 0) return -1;
  if (state.readerFit === "spread") {
    const spreads = document.querySelectorAll<HTMLElement>(".reader-spread");
    if (spreads.length === 0) return 0;
    const probe = resultGrid.scrollLeft + resultGrid.clientWidth * 0.5;
    let spreadIndex = Math.max(0, Math.min(spreads.length - 1, Math.floor(streamIndexHint / 2)));
    while (
      spreadIndex < spreads.length - 1
      && spreads[spreadIndex].offsetLeft + spreads[spreadIndex].offsetWidth <= probe
    ) spreadIndex++;
    while (spreadIndex > 0 && spreads[spreadIndex].offsetLeft > probe) spreadIndex--;
    const index = Number(spreads[spreadIndex].dataset.startIndex) || 0;
    streamIndexHint = index;
    return index;
  }
  // Both resultGrid and the photos currently share .workspace as offsetParent.
  // Anchor to the scroller itself so wrapping metadata before the first page
  // cannot shift page detection.
  const probe = resultGrid.offsetTop + resultGrid.scrollTop + resultGrid.clientHeight * 0.35;
  let index = Math.max(0, Math.min(photos.length - 1, streamIndexHint));
  while (index < photos.length - 1 && photos[index].offsetTop + photos[index].offsetHeight < probe) index++;
  while (index > 0 && photos[index - 1].offsetTop + photos[index - 1].offsetHeight >= probe) index--;
  streamIndexHint = index;
  return index;
}

function scrollToStreamIndex(index: number, behavior: ScrollBehavior = "smooth") {
  const photos = document.querySelectorAll<HTMLElement>(".stream-photo");
  if (photos.length === 0) return;
  const clamped = Math.max(0, Math.min(photos.length - 1, index));
  streamIndexHint = clamped;
  if (state.readerFit === "spread") {
    const start = Math.floor(clamped / 2) * 2;
    const target = document.querySelector<HTMLElement>(`.reader-spread[data-start-index="${start}"]`);
    if (!target) return;
    streamIndexHint = start;
    resultGrid.scrollTo({ left: target.offsetLeft, top: 0, behavior });
    return;
  }
  const target = photos[clamped];
  const offset = target.getBoundingClientRect().top - resultGrid.getBoundingClientRect().top;
  resultGrid.scrollTo({ top: resultGrid.scrollTop + offset - 8, behavior });
}

function setFullscreenState(value: boolean) {
  const pagedIndex = state.view === "reader" && state.readerFit !== "width"
    ? Math.max(0, streamIndexHint)
    : -1;
  state.fullscreen = value;
  shell.classList.toggle("fullscreen-mode", value);
  fullscreenButton.classList.toggle("active", value);
  setIconWithLabel(fullscreenButton, value ? "minimize" : "maximize", value ? "退出全屏" : "全屏");
  fullscreenButton.title = value ? "退出全屏 (F11)" : "全屏 (F11)";
  if (state.view === "reader") {
    window.requestAnimationFrame(() => {
      applyReaderZoomLayout();
      if (pagedIndex >= 0) scrollToStreamIndex(pagedIndex, "auto");
      redrawReaderOverlays();
    });
  }
}

async function syncFullscreenState() {
  try {
    setFullscreenState(await invokeTauri<boolean>("is_window_fullscreen"));
  } catch {
    setFullscreenState(Boolean(document.fullscreenElement));
  }
}

async function toggleFullscreen() {
  try {
    const next = await invokeTauri<boolean>("toggle_window_fullscreen");
    setFullscreenState(next);
  } catch {
    const next = !document.fullscreenElement;
    if (next && document.fullscreenEnabled) {
      await document.documentElement.requestFullscreen();
    } else if (!next && document.exitFullscreen) {
      await document.exitFullscreen();
    }
    setFullscreenState(next);
  }
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>) {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("Cannot read properties of undefined")
      || message.includes("__TAURI_INTERNALS__")
      || message.includes("is not a function")
    ) {
      throw new Error("当前页面没有连接到 Tauri 后端，请从桌面应用打开，或使用 npm run tauri dev 调试。");
    }
    throw error;
  }
}

function pagePath(path: string, page = state.page) {
  return path.replace("{page}", String(page));
}

function linkedPagePath(path: string, page: number) {
  if (page <= 1) return path;

  const albumIndexPath = /(\/albums-index-)(?:page-\d+-)?((?:tag-.+?|cate-\d+))(?=\.html(?:[?#]|$))/;
  if (albumIndexPath.test(path)) {
    return path.replace(albumIndexPath, `$1page-${page}-$2`);
  }

  const authorPath = /(\/albums-user-)(?:page-\d+-)?(uid-\d+)(?=\.html(?:[?#]|$))/;
  if (authorPath.test(path)) {
    return path.replace(authorPath, `$1page-${page}-$2`);
  }

  throw new Error("当前列表地址暂不支持继续翻页");
}

function isLinkedMode(mode = state.mode): mode is BrowseKind {
  return mode === "tag" || mode === "author" || mode === "classification";
}

function listContextKey() {
  return [state.mode, state.query, state.category.path, state.linkPath].join("\n");
}

function updateListControls() {
  const busy = state.listLoading || state.loadingMore;
  const isList = state.view === "list";
  refreshButton.disabled = !isList || busy;
  searchForm.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input").forEach((control) => {
    control.disabled = busy;
  });
  categoryList.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = busy;
  });
  if (pagerBar) {
    pagerBarPrev.disabled = !isList || busy || state.page <= 1;
    pagerBarFirst.disabled = !isList || busy || state.page <= 1;
    pagerBarNext.disabled = !isList || busy || state.allLoaded;
    pagerBarInput.disabled = !isList || busy;
  }
}

function updateJumpTopButton() {
  jumpTopButton.hidden = state.readerFit === "spread" || resultGrid.scrollTop < 520;
}

async function fetchAlbums(page: number, contextKey = listContextKey()) {
  const [mode, query, categoryPath, linkPath] = contextKey.split("\n") as [typeof state.mode, string, string, string];
  if (isLinkedMode(mode)) {
    if (linkPath) return invokeTauri<Album[]>("fetch_albums", { path: linkedPagePath(linkPath, page) });
    throw new Error("缺少对应的列表链接");
  }
  if (mode === "search") return invokeTauri<Album[]>("search_albums", { query, page });
  return invokeTauri<Album[]>("fetch_albums", { path: pagePath(categoryPath, page) });
}

function hydrateImage(img: HTMLImageElement, url: string, _referer?: string | null) {
  const token = `${url}|${_referer ?? ""}`;
  img.dataset.imageToken = token;
  img.classList.remove("image-error");
  img.classList.add("image-loading");
  img.decoding = "async";
  if (!isAllowedRemoteImageUrl(url)) {
    img.classList.remove("image-loading");
    img.classList.add("image-error");
    img.alt = "封面地址不受信任";
    return;
  }
  const onLoad = () => {
    if (img.dataset.imageToken !== token) return;
    img.classList.remove("image-loading");
  };
  const onError = () => {
    if (img.dataset.imageToken !== token) return;
    img.classList.remove("image-loading");
    img.classList.add("image-error");
  };
  img.addEventListener("load", onLoad, { once: true });
  img.addEventListener("error", onError, { once: true });
  img.src = url;
}

async function resolvePhotoImageUrl(index: number) {
  const photo = state.photos[index];
  const albumUrl = state.currentAlbum
    ? `https://wnacg.com/photos-index-aid-${state.currentAlbum.aid}.html`
    : null;
  const image = await invokeTauri<PhotoImage>("fetch_photo_image", { pageUrl: photo.url, albumUrl });
  return image.url;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function progressText(progress: ProgressState | null) {
  if (!progress) return "正在解析图片";
  if (typeof progress.percent === "number") {
    const size = progress.total ? ` · ${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}` : "";
    return `下载中 ${progress.percent}%${size}`;
  }
  return `下载中 ${formatBytes(progress.loaded)}`;
}

function createProgressIndicator(progress: ProgressState | null, compact = false, message?: string) {
  const wrap = document.createElement("div");
  wrap.className = compact ? "image-progress compact" : "image-progress";

  const bar = document.createElement("div");
  bar.className = "image-progress-bar";
  const fill = document.createElement("span");
  const percent = progress?.percent;
  if (typeof percent === "number") {
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  } else {
    fill.classList.add("indeterminate");
  }
  bar.append(fill);

  const label = document.createElement("p");
  label.textContent = message ?? progressText(progress);
  wrap.append(bar, label);
  return wrap;
}

function setSoftStatus(message: string) {
  if (state.view === "reader") setStatus(message);
}

async function fetchImageDataUrlWithProgress(
  url: string,
  referer: string | null | undefined,
  requestId: string,
  onProgress: (progress: ProgressState) => void,
) {
  const unlisten = await listen<ImageDownloadProgress>("image-download-progress", (event) => {
    if (event.payload.requestId !== requestId) return;
    onProgress({
      loaded: event.payload.loaded,
      total: event.payload.total ?? null,
      percent: event.payload.percent ?? null,
    });
  });

  try {
    const image = await invokeTauri<ImageData>("fetch_image_data_url_progress", {
      url,
      referer: referer ?? null,
      requestId,
    });
    return image.dataUrl;
  } finally {
    unlisten();
  }
}

async function loadDisplayImageDataUrl(
  index: number,
  requestId: string,
  onProgress: (progress: ProgressState) => void,
): Promise<DisplayImageResult> {
  const imageUrl = await resolvePhotoImageUrlWithRetry(index, 2);
  if (!isAllowedRemoteImageUrl(imageUrl)) {
    throw new Error("图片地址不受信任，已阻止直接加载");
  }
  state.imageUrls[index] = imageUrl;
  const referer = state.photos[index]?.url;
  return {
    url: await fetchImageDataUrlWithProgress(imageUrl, referer, requestId, onProgress).then((dataUrl) => {
      ocrByteCacheUrls.add(imageUrl);
      return dataUrl;
    }),
    imageUrl,
  };
}

async function resolvePhotoImageUrlWithRetry(index: number, retries = 2) {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await resolvePhotoImageUrl(index);
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await sleep(1500 * (attempt + 1));
    }
  }

  throw lastError;
}

async function preloadFullImage(index: number, readerToken = state.readerToken): Promise<PreloadResult> {
  if (index < 0 || index >= state.photos.length) return "failed";
  if (state.preloadedUrls[index]) return "cached";
  const existing = preloadInFlight.get(index);
  if (existing) return existing;

  let task!: Promise<PreloadResult>;
  task = (async () => {
    try {
      const imageUrl = state.imageUrls[index] ?? await resolvePhotoImageUrlWithRetry(index, 2);
      if (readerToken !== state.readerToken || state.view !== "reader") return "failed";
      state.imageUrls[index] = imageUrl;
      const image = await invokeTauri<ImageData>("fetch_image_data_url", {
        url: imageUrl,
        referer: state.photos[index]?.url ?? null,
      });
      if (readerToken !== state.readerToken || state.view !== "reader") return "failed";
      ocrByteCacheUrls.add(imageUrl);
      state.preloadedUrls[index] = image.dataUrl;
      delete state.preloadFailures[index];
      preloadImage(image.dataUrl);
      if (state.translateEnabled && isNearPage(index)) {
        queueOcrText(index); // 直接做带文字的单遍 OCR，避免先找框再重复检测
      }
      return "loaded";
    } catch {
      if (readerToken !== state.readerToken || state.view !== "reader") return "failed";
      state.preloadFailures[index] = (state.preloadFailures[index] ?? 0) + 1;
      if (state.preloadFailures[index] > 3) return "failed";
      const nextDelay = Math.min(30_000, state.preloadFailures[index] * 5_000);
      window.setTimeout(() => {
        if (readerToken === state.readerToken && state.view === "reader" && !state.preloadedUrls[index]) {
          void preloadFullImage(index, readerToken);
        }
      }, nextDelay);
      return "failed";
    } finally {
      if (preloadInFlight.get(index) === task) preloadInFlight.delete(index);
    }
  })();
  preloadInFlight.set(index, task);
  return task;
}

function albumSubtitle(album: Album) {
  const meta = album.meta.replace(/\s+/g, " ").trim();
  if (!meta) return `AID ${album.aid}`;

  const count = meta.match(/(\d+)\s*張照片|(\d+)\s*P/i);
  const date = meta.match(/(\d{4}-\d{2}-\d{2})/);
  const parts = [
    count?.[1] ? `${count[1]}P` : count?.[2] ? `${count[2]}P` : "",
    date?.[1] ?? "",
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : meta;
}

function displayTitle(album: Album) {
  const title = cleanTitle(album.title);
  const translated = titleTranslateEnabled ? titleTranslationCache.get(title) : undefined;

  return translated || title || `AID ${album.aid}`;
}

// ---- 生肉标题翻译 ----

const TITLE_TRANSLATE_KEY = "wnacg.titleTranslations.v1";
const TITLE_TRANSLATE_ENABLED_KEY = "wnacg.titleTranslate.v1";
const titleTranslationCache = new Map<string, string>();
const titleTranslatePending = new Set<string>();
const titleTranslateFailed = new Set<string>();
let titleTranslateEnabled = false;

function cleanTitle(title: string): string {
  return String(title ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function loadTitleTranslateState() {
  try {
    titleTranslateEnabled = localStorage.getItem(TITLE_TRANSLATE_ENABLED_KEY) === "1";
    const raw = localStorage.getItem(TITLE_TRANSLATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const [key, value] of Object.entries(parsed)) {
        if (key && value && value !== key) titleTranslationCache.set(key, value);
      }
    }
  } catch {
    // 本地缓存损坏时忽略
  }
}

function saveTitleTranslationCache() {
  try {
    localStorage.setItem(
      TITLE_TRANSLATE_KEY,
      JSON.stringify(Object.fromEntries(titleTranslationCache)),
    );
  } catch {
    // 存储满时忽略
  }
}

function syncTitleTranslateToggle() {
  const toggle = document.querySelector<HTMLInputElement>("#title-translate-toggle");
  if (toggle) toggle.checked = titleTranslateEnabled;
}

function looksJapanese(title: string): boolean {
  // 含平假名/片假名即视为生肉日文标题
  return /[\u3040-\u30ff]/.test(title);
}

async function translateVisibleTitles() {
  if (!titleTranslateEnabled || state.view !== "list") return;
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const album of state.albums) {
    const title = cleanTitle(album.title);
    if (!title || !looksJapanese(title)) continue;
    if (titleTranslationCache.has(title) || titleTranslatePending.has(title) || titleTranslateFailed.has(title)) {
      continue;
    }
    if (seen.has(title)) continue;
    seen.add(title);
    titles.push(title);
  }
  if (titles.length === 0) return;

  for (const title of titles) titleTranslatePending.add(title);
  try {
    const results = await invokeTauri<string[]>("translate_titles", { titles });
    for (let i = 0; i < titles.length; i++) {
      const title = titles[i];
      titleTranslatePending.delete(title);
      const translated = results[i]?.trim();
      if (translated && translated !== title) {
        titleTranslationCache.set(title, translated);
        titleTranslateFailed.delete(title);
      } else {
        titleTranslateFailed.add(title);
      }
    }
    saveTitleTranslationCache();
    applyTitleTranslations();
  } catch (error) {
    for (const title of titles) {
      titleTranslatePending.delete(title);
      titleTranslateFailed.add(title);
    }
    const message = error instanceof Error ? error.message : String(error);
    showToast(`标题翻译失败：${message}`, "error", 4800);
  }
}

function applyTitleTranslations() {
  document.querySelectorAll<HTMLElement>(".album-card").forEach((card) => {
    const original = card.dataset.originalTitle;
    if (!original) return;
    const translated = titleTranslateEnabled ? titleTranslationCache.get(original) : undefined;
    const visible = translated || original;
    const titleEl = card.querySelector<HTMLElement>(".card-title");
    if (titleEl) titleEl.textContent = visible;
    const cover = card.querySelector<HTMLElement>(".cover");
    if (cover) cover.dataset.title = visible;
    card.dataset.title = visible;
    card.setAttribute("aria-label", `打开《${visible}》`);
    card.title =
      translated && translated !== original
        ? `${visible}\n原文：${original}\n点击在新窗口打开`
        : `${visible}\n点击在新窗口打开`;
  });
}

function setTitleTranslate(enabled: boolean) {
  if (enabled && !titleTranslateEnabled) titleTranslateFailed.clear();
  titleTranslateEnabled = enabled;
  localStorage.setItem(TITLE_TRANSLATE_ENABLED_KEY, enabled ? "1" : "0");
  syncTitleTranslateToggle();
  applyTitleTranslations();
  if (titleTranslateEnabled) {
    translateVisibleTitles();
    if (state.view === "reader" && state.currentAlbum?.title) {
      void applyAlbumTitle(state.currentAlbum.title); // 阅读器内标题同步翻译
    }
  }
}

async function setTitleTranslateWithFeedback(enabled: boolean) {
  if (enabled && !(await ensureDeepseekKeyForTranslation())) {
    syncTitleTranslateToggle();
    return;
  }
  setTitleTranslate(enabled);
  showToast(
    enabled
      ? "生肉标题翻译已开启，列表与详情标题将显示中文"
      : "生肉标题翻译已关闭，恢复原标题",
    "success",
    2600,
  );
}

function toggleTitleTranslate() {
  void setTitleTranslateWithFeedback(!titleTranslateEnabled);
}

async function translatedAlbumTitle(title: string): Promise<string> {
  if (!titleTranslateEnabled || !looksJapanese(title)) return title;
  const cached = titleTranslationCache.get(title);
  if (cached) return cached;
  if (titleTranslatePending.has(title) || titleTranslateFailed.has(title)) return title;
  titleTranslatePending.add(title);
  try {
    const results = await invokeTauri<string[]>("translate_titles", { titles: [title] });
    const translated = results[0]?.trim();
    if (translated && translated !== title) {
      titleTranslationCache.set(title, translated);
      titleTranslateFailed.delete(title);
      saveTitleTranslationCache();
      return translated;
    }
    titleTranslateFailed.add(title);
    return title;
  } catch {
    titleTranslateFailed.add(title);
    return title;
  } finally {
    titleTranslatePending.delete(title);
  }
}

function saveListSnapshot() {
  if (state.view !== "list" || state.albums.length === 0) return;
  state.listSnapshots[listContextKey()] = {
    albums: [...state.albums],
    page: state.page,
    allLoaded: state.allLoaded,
    scrollTop: resultGrid.scrollTop,
    status: statusLabel.textContent ?? "",
  };
}

function restoreListSnapshot() {
  const snapshot = state.listSnapshots[listContextKey()];
  if (!snapshot || snapshot.albums.length === 0) return false;

  teardownInfiniteScroll();
  removeLoadMoreRow();
  state.albums = [...snapshot.albums];
  state.page = snapshot.page;
  state.allLoaded = snapshot.allLoaded;
  state.listLoading = false;
  state.loadingMore = false;
  state.loadMoreError = "";
  renderCategories();
  syncToolbar();
  renderAlbums(state.albums);
  translateVisibleTitles();
  setStatus(snapshot.status || `已恢复 ${state.albums.length} 项 · 第 ${state.page} 页`);
  requestAnimationFrame(() => {
    resultGrid.scrollTop = snapshot.scrollTop;
    updateJumpTopButton();
  });
  return true;
}

// ---- toolbar sync ----

function syncToolbar() {
  applyReaderPrefs();
  shell.classList.toggle("fullscreen-mode", state.fullscreen);
  setIconWithLabel(fullscreenButton, state.fullscreen ? "minimize" : "maximize", state.fullscreen ? "退出全屏" : "全屏");
  const standalone = shell.classList.contains("standalone-album");
  // standalone 模式:把关闭按钮挂到右侧 pager-controls,主模式回到 toolbar-left 开头
  if (standalone) {
    if (backButton.parentElement !== pagerControls) pagerControls.append(backButton);
  } else {
    if (backButton.parentElement !== toolbarLeft) toolbarLeft.prepend(backButton);
  }
  if (state.view === "reader") {
    backButton.hidden = false;
    setIconWithLabel(backButton, standalone ? "x" : "arrowLeft", standalone ? "关闭" : "返回");
    backButton.title = standalone ? "关闭窗口 (Esc/X)" : "返回 (Esc/X)";
    backButton.setAttribute("aria-label", standalone ? "关闭窗口" : "返回列表");
    pagerControls.hidden = false;
    refreshButton.hidden = true;
    fullscreenButton.hidden = false;
    readerZoomControls.hidden = state.readerFit !== "width";
    readerSettings.hidden = false;
    const albumTitle = state.currentAlbum?.title;
    viewTitle.textContent = (albumTitle && titleTranslationCache.get(albumTitle)) || albumTitle || "阅读";
    updateWindowTitle();
    refreshTranslateStatus();
    sidebar.classList.add("hidden");
    shell.classList.add("reader-mode");
  } else {
    backButton.hidden = true;
    pagerControls.hidden = false;
    refreshButton.hidden = false;
    fullscreenButton.hidden = true;
    readerPageControls.hidden = true;
    readerZoomControls.hidden = true;
    readerSettings.hidden = false;
    viewTitle.textContent =
      state.mode === "tag" ? `标签：${state.query}` :
      state.mode === "author" ? `作者：${state.query}` :
      state.mode === "classification" ? `分类：${state.query}` :
      state.mode === "search" ? `搜索：${state.query || "未输入"}` : state.category.label;
    sidebar.classList.remove("hidden");
    shell.classList.remove("reader-mode");
  }
  syncReaderControls();
  syncPagerBar();
  syncReaderInfo();
  updateReaderProgress();
  syncReaderPageControls();
  updateListControls();
  if (state.view === "reader") window.requestAnimationFrame(applyReaderZoomLayout);
}

// ---- category sidebar ----

function renderCategories() {
  categoryList.replaceChildren(
    ...categories.map((cat) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        cat.path === state.category.path && state.mode === "category" ? "nav-button active" : "nav-button";
      btn.textContent = cat.label;
      btn.addEventListener("click", () => {
        if (state.listLoading || state.loadingMore) return;
        state.mode = "category";
        state.category = cat;
        state.query = "";
        state.linkPath = "";
        searchInput.value = "";
        state.page = 1;
        state.allLoaded = false;
        state.loadMoreError = "";
        loadAlbums();
      });
      return btn;
    }),
  );
}

// ---- album list ----

async function openAlbumInNewWindow(aid: string, title: string) {
  try {
    await invokeTauri<void>("open_album_window", { aid, title });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`打开新窗口失败：${message}`, "error", 3000);
  }
}

async function closeStandaloneWindow() {
  try {
    await invokeTauri<void>("close_current_window");
  } catch (error) {
    console.error("close_current_window failed:", error);
    try {
      const tauri = await import("@tauri-apps/api/window");
      await tauri.getCurrentWindow().close();
    } catch (fallbackError) {
      console.error("getCurrentWindow().close() failed:", fallbackError);
    }
  }
}

async function triggerDetailBrowse(kind: BrowseKind, item: Tag) {
  const name = item.name.trim();
  const path = item.path.trim();
  if (!name || !path) return;
  if (shell.classList.contains("standalone-album")) {
    // 子窗口:通知主窗口打开对应列表,自己保留
    try {
      await invokeTauri<void>("browse_link_in_main", { kind, name, path });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast(`无法在主窗口打开列表：${message}`, "error", 3000);
    }
    return;
  }
  applyLinkedBrowse({ kind, name, path });
}

function applyLinkedBrowse(request: BrowseLinkRequest) {
  state.mode = request.kind;
  state.query = request.name.trim();
  state.linkPath = request.path.trim();
  state.page = 1;
  state.allLoaded = false;
  state.loadMoreError = "";
  searchInput.value = state.query;
  if (state.view === "reader") {
    backToList({ restore: false });
  } else {
    loadAlbums();
  }
}

const APP_TITLE = "wnacg · 桌面阅读器";
let windowTitleBase: string | null = null; // 当前专辑标题(已按需翻译),null=列表

async function applyAlbumTitle(title: string) {
  const trimmed = title.trim();
  if (!trimmed) return;
  const shown = await translatedAlbumTitle(trimmed);
  windowTitleBase = shown;
  // 同步刷新 view-title（如果当前在 reader 视图）
  if (state.view === "reader") {
    viewTitle.textContent = shown;
  }
  updateWindowTitle();
}

function resetWindowTitle() {
  windowTitleBase = null;
  updateWindowTitle();
}

// 窗口标题只显示专辑标题,翻译状态由工具栏的全屏按钮左侧徽标显示
function updateWindowTitle() {
  const title = windowTitleBase || "";
  const full = title ? `${title} · wnacg` : APP_TITLE;
  document.title = full;
  invokeTauri<void>("set_window_title", { title: full }).catch(() => {});
}

// 工具栏"翻译中…"徽标:显示在全屏按钮左侧,开着/进行中/失败三态
function refreshTranslateStatus() {
  const status = document.getElementById("translate-status");
  if (!status) return;
  if (state.view !== "reader" || !state.translateEnabled) {
    status.hidden = true;
    return;
  }
  let label = "翻译开";
  let className = "on";
  const visible = visibleReaderIndices();
  const phases = visible.map(translatePhase);
  if (phases.includes("failed")) {
    label = "翻译失败 · 点击重试";
    className = "failed";
  } else if (phases.includes("translating")) {
    label = "翻译中…";
    className = "working";
  } else if (phases.includes("recognizing")) {
    label = "识别中…";
    className = "working";
  }
  status.textContent = label;
  status.className = `translate-status ${className}`;
  status.hidden = false;
}

function renderAlbumCard(album: Album): HTMLElement {
  const card = document.createElement("article");
  card.className = "album-card";
  card.tabIndex = 0;
  card.setAttribute("role", "button");

  const titleText = displayTitle(album);
  const subtitleText = albumSubtitle(album);
  card.dataset.originalTitle = cleanTitle(album.title);
  card.dataset.title = titleText;
  card.dataset.subtitle = subtitleText;
  card.setAttribute("aria-label", `打开《${titleText}》`);
  card.title = `${titleText}\n点击在新窗口打开`;
  card.addEventListener("click", () => {
    openAlbumInNewWindow(album.aid, card.dataset.title || titleText);
  });
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openAlbumInNewWindow(album.aid, card.dataset.title || titleText);
    }
  });

  const cover = document.createElement("div");
  cover.className = "cover";
  cover.dataset.title = titleText;
  cover.dataset.subtitle = subtitleText;
  if (album.cover) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    hydrateImage(img, album.cover, album.url);
    cover.append(img);
  } else {
    cover.textContent = "No Cover";
  }

  const body = document.createElement("div");
  body.className = "card-body";

  const cardTitle = document.createElement("p");
  cardTitle.className = "card-title";
  cardTitle.textContent = titleText;

  const cardSub = document.createElement("p");
  cardSub.className = "card-sub";
  cardSub.textContent = subtitleText;

  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = album.meta || "";

  const aid = document.createElement("span");
  aid.className = "aid-badge";
  aid.textContent = `AID ${album.aid}`;

  body.append(cardTitle, cardSub, meta, aid);
  card.append(cover, body);
  return card;
}

function renderAlbums(albums: Album[]) {
  state.albums = [...albums];
  resultGrid.className = "result-grid";
  resultGrid.replaceChildren(...albums.map((album, i) => {
    const card = renderAlbumCard(album);
    card.style.setProperty("--card-order", String(i));
    return card;
  }));
  if (albums.length > 0 && !state.allLoaded) setupInfiniteScroll();
}

function insertBeforeSentinel(node: Node) {
  if (scrollSentinel?.parentNode === resultGrid) {
    resultGrid.insertBefore(node, scrollSentinel);
  } else {
    resultGrid.append(node);
  }
}

function removeLoadMoreRow() {
  document.getElementById("load-more")?.remove();
  document.getElementById("list-end")?.remove();
}

function showLoadMoreError(message: string) {
  removeLoadMoreRow();
  const row = document.createElement("div");
  row.id = "load-more";
  row.className = "state-card error load-more-error";

  const text = document.createElement("span");
  text.textContent = `加载失败：${message}`;

  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "重试";
  retry.addEventListener("click", () => {
    state.loadMoreError = "";
    row.remove();
    setupInfiniteScroll();
    loadNextPage();
  });

  row.append(text, retry);
  resultGrid.append(row);
}

function showListEnd() {
  document.getElementById("list-end")?.remove();
  const row = document.createElement("div");
  row.id = "list-end";
  row.className = "state-card list-end";
  row.textContent = "已经到底";
  resultGrid.append(row);
}

function showListLoading() {
  teardownInfiniteScroll();
  resultGrid.className = "result-grid loading-grid";
  const skeletons = Array.from({ length: 10 }, () => {
    const card = document.createElement("div");
    card.className = "album-card skeleton-card";
    card.innerHTML = '<div class="skeleton-cover"></div><div class="skeleton-lines"><span></span><span></span><span></span></div>';
    return card;
  });
  resultGrid.replaceChildren(...skeletons);
  setStatus("载入中...");
}

function showError(message: string, onRetry?: () => void) {
  teardownInfiniteScroll();
  const card = document.createElement("div");
  card.className = "state-card error empty-state";

  const icon = document.createElement("div");
  icon.className = "empty-state-icon";
  icon.textContent = "⚠";

  const title = document.createElement("h3");
  title.className = "empty-state-title";
  title.textContent = "加载没有完成";

  const sub = document.createElement("p");
  sub.className = "empty-state-sub";
  sub.textContent = message || "网络不太顺畅，可以稍后再试";

  card.append(icon, title, sub);

  if (onRetry) {
    const actions = document.createElement("div");
    actions.className = "empty-state-actions";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "primary-action";
    retry.textContent = "重试";
    retry.addEventListener("click", onRetry);
    actions.append(retry);
    card.append(actions);
  }

  resultGrid.className = "result-grid";
  resultGrid.replaceChildren(card);
}

function showEmpty(text: string) {
  teardownInfiniteScroll();
  resultGrid.className = "result-grid";
  const card = document.createElement("div");
  card.className = "state-card empty-state";
  const icon = document.createElement("div");
  icon.className = "empty-state-icon";
  icon.textContent = state.mode === "search" || isLinkedMode() ? "🔍" : "·";
  const title = document.createElement("h3");
  title.className = "empty-state-title";
  title.textContent = text;
  card.append(icon, title);
  resultGrid.replaceChildren(card);
}

function showStandaloneSkeleton(aid: string) {
  teardownInfiniteScroll();
  resultGrid.className = "result-grid standalone-loading";

  const wrap = document.createElement("div");
  wrap.className = "standalone-splash";

  const orb = document.createElement("div");
  orb.className = "standalone-splash-orb";

  const label = document.createElement("p");
  label.className = "standalone-splash-label";
  label.textContent = "正在打开作品…";

  const sub = document.createElement("p");
  sub.className = "standalone-splash-sub";
  sub.textContent = `AID ${aid}`;

  const skeleton = document.createElement("div");
  skeleton.className = "standalone-splash-skeleton";
  for (let i = 0; i < 3; i++) {
    const bar = document.createElement("span");
    skeleton.append(bar);
  }

  wrap.append(orb, label, sub, skeleton);
  resultGrid.replaceChildren(wrap);
}

async function loadAlbums() {
  const token = ++state.listToken;
  const contextKey = listContextKey();
  const page = state.page;
  teardownInfiniteScroll();
  removeLoadMoreRow();
  state.listLoading = true;
  state.loadingMore = false;
  state.allLoaded = false;
  state.loadMoreError = "";
  state.albums = [];
  renderCategories();
  syncToolbar();
  showListLoading();
  const cachedAlbums = readPersistentList(contextKey, page);
  const showingCache = Boolean(cachedAlbums?.length);
  if (cachedAlbums) {
    state.albums = cachedAlbums;
    renderAlbums(cachedAlbums);
    setStatus(`已立即显示 ${cachedAlbums.length} 项 · 正在刷新`);
  }

  try {
    const albums = await fetchAlbums(page, contextKey);

    if (token !== state.listToken || state.view !== "list" || contextKey !== listContextKey()) return;
    state.page = page;
    state.allLoaded = albums.length === 0;
    state.albums = albums;
    syncToolbar();
    if (albums.length === 0) {
      showEmpty(state.mode === "search" || isLinkedMode() ? "没有找到匹配结果" : "这一页没有内容");
    } else {
      renderAlbums(albums);
      translateVisibleTitles();
      resultGrid.scrollTop = 0;
      saveListSnapshot();
      writePersistentList(contextKey, page, albums);
    }
    setStatus(`第 ${state.page} 页 · 共 ${albums.length} 项`);
  } catch (error) {
    if (token !== state.listToken || state.view !== "list" || contextKey !== listContextKey()) return;
    const message = error instanceof Error ? error.message : String(error);
    if (showingCache) {
      setStatus(`已显示缓存 · 刷新失败`);
      showToast(`后台刷新失败：${message}`, "error", 3600);
      return;
    }
    showError(message, () => loadAlbums());
    setStatus("载入失败");
    showToast(`加载失败：${message}`, "error", 3600);
  } finally {
    if (token === state.listToken && contextKey === listContextKey()) {
      state.listLoading = false;
      syncToolbar();
    }
  }
}

function jumpToPage(targetPage: number) {
  const page = Math.max(1, Math.floor(targetPage));
  if (page === state.page && state.albums.length > 0) {
    resultGrid.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  state.page = page;
  state.allLoaded = false;
  state.loadMoreError = "";
  loadAlbums();
}

async function loadNextPage() {
  if (state.listLoading || state.loadingMore || state.allLoaded || state.loadMoreError || state.view !== "list") return;
  const token = state.listToken;
  const contextKey = listContextKey();
  const page = state.page + 1;
  state.loadingMore = true;
  updateListControls();
  removeLoadMoreRow();

  // Show loading indicator at bottom
  const indicator = document.createElement("div");
  indicator.className = "state-card";
  indicator.id = "load-more";
  indicator.textContent = "加载中...";
  insertBeforeSentinel(indicator);

  try {
    const albums = await fetchAlbums(page, contextKey);

    removeLoadMoreRow();
    if (token !== state.listToken || state.view !== "list" || contextKey !== listContextKey()) return;

    const seenAids = new Set(state.albums.map((album) => album.aid));
    const newAlbums = albums.filter((album) => {
      if (seenAids.has(album.aid)) return false;
      seenAids.add(album.aid);
      return true;
    });

    if (newAlbums.length === 0) {
      state.allLoaded = true;
      teardownInfiniteScroll();
      showListEnd();
      setStatus(`共 ${state.page} 页，已全部加载`);
      syncToolbar();
      saveListSnapshot();
      return;
    }

    state.page = page;
    state.albums = [...state.albums, ...newAlbums];
    // Insert albums before the sentinel (keep sentinel at bottom)
    for (let i = 0; i < newAlbums.length; i++) {
      const card = renderAlbumCard(newAlbums[i]);
      card.style.setProperty("--card-order", String(i));
      insertBeforeSentinel(card);
    }
    syncToolbar();
    setStatus(`第 ${state.page} 页 · 已加载 ${state.albums.length} 项`);
    saveListSnapshot();
    translateVisibleTitles();
  } catch (error) {
    if (token !== state.listToken || state.view !== "list" || contextKey !== listContextKey()) return;
    removeLoadMoreRow();
    const message = error instanceof Error ? error.message : String(error);
    state.loadMoreError = message;
    teardownInfiniteScroll();
    showLoadMoreError(message);
    setStatus("加载更多失败");
  } finally {
    if (token === state.listToken && contextKey === listContextKey()) {
      state.loadingMore = false;
      updateListControls();
    }
  }
}

// ---- reader ----

let readerObserver: IntersectionObserver | null = null;

function teardownReaderObserver() {
  readerObserver?.disconnect();
  readerObserver = null;
  streamQueue = [];
}

function buildAlbumMetadata(className = "album-metadata") {
  const metadata = document.createElement("section");
  metadata.className = className;
  metadata.setAttribute("aria-label", "作品信息");

  const appendRow = (labelText: string, items: Tag[], kind: BrowseKind, tagStyle = false) => {
    if (items.length === 0) return;
    const row = document.createElement("div");
    row.className = "metadata-row";
    const label = document.createElement("span");
    label.className = "metadata-label";
    label.textContent = labelText;
    const values = document.createElement("div");
    values.className = "metadata-values";
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = tagStyle ? "tag-btn" : "metadata-link";
      button.textContent = item.name;
      button.title = `查看${labelText}“${item.name}”的作品`;
      button.addEventListener("click", () => triggerDetailBrowse(kind, item));
      values.append(button);
    }
    row.append(label, values);
    metadata.append(row);
  };

  appendRow("分类", state.albumCategories, "classification");
  appendRow("作者", state.author ? [state.author] : [], "author");
  appendRow("标签", state.tags, "tag", true);
  return metadata;
}

function renderReaderGrid(
  tags = state.tags,
  albumCategories = state.albumCategories,
  author = state.author,
) {
  teardownReaderObserver();
  streamIndexHint = 0;
  lastReportedStreamIndex = -1;
  resultGrid.className = "reader-stream";
  resultGrid.scrollTop = 0;
  resultGrid.scrollLeft = 0;

  const frag = document.createDocumentFragment();

  if (albumCategories.length > 0 || author || tags.length > 0) {
    frag.append(buildAlbumMetadata());
  }

  for (let start = 0; start < state.photos.length; start += 2) {
    const spread = document.createElement("section");
    spread.className = start + 1 < state.photos.length ? "reader-spread" : "reader-spread is-single";
    spread.dataset.startIndex = String(start);

    for (let index = start; index < Math.min(start + 2, state.photos.length); index++) {
      const page = document.createElement("div");
      page.className = "reader-page";

      const container = document.createElement("div");
      container.className = "stream-photo";
      container.dataset.index = String(index);
      container.dataset.state = "";

      const label = document.createElement("div");
      label.className = "stream-label";
      label.textContent = `${index + 1} / ${state.photos.length}`;

      page.append(container, label);
      spread.append(page);
    }
    frag.append(spread);
  }

  resultGrid.replaceChildren(frag);

  applyReaderZoomLayout();
  setupStreamObserver();
  updateReaderProgress();
}

let streamQueue: HTMLElement[] = [];
let streamWorkers = 0;
const STREAM_CONCURRENCY = 2;

function setupStreamObserver() {
  teardownReaderObserver();
  streamQueue = [];
  const rootMargin = state.readerFit === "spread"
    ? (state.conserveImages ? "0px 110%" : "0px 220%")
    : (state.conserveImages ? "120px 0px" : "400px 0px");
  readerObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const container = entry.target as HTMLElement;
          if (container.dataset.state === "" && !streamQueue.includes(container)) {
            streamQueue.push(container);
          }
        }
      }
      pumpStreamQueue();
    },
    { root: resultGrid, rootMargin },
  );

  document.querySelectorAll<HTMLElement>(".stream-photo").forEach((el) => {
    readerObserver!.observe(el);
  });
  // kick off first few visible
  if (streamQueue.length === 0) {
    const current = Math.max(0, currentStreamIndex());
    const currentPage = document.querySelector<HTMLElement>(
      `.stream-photo[data-index="${current}"][data-state=""]`,
    );
    const fallback = currentPage
      ?? document.querySelector<HTMLElement>('.stream-photo[data-state=""]');
    if (fallback) streamQueue.push(fallback);
  }
  pumpStreamQueue();
}

function pumpStreamQueue() {
  while (streamWorkers < STREAM_CONCURRENCY && streamQueue.length > 0) {
    const container = streamQueue.shift()!;
    if (container.dataset.state !== "") continue;
    streamWorkers++;
    loadStreamImage(container).finally(() => {
      streamWorkers = Math.max(0, streamWorkers - 1);
      if (state.view === "reader") pumpStreamQueue();
    });
  }
}

async function loadStreamImage(container: HTMLElement) {
  const index = parseInt(container.dataset.index || "", 10);
  if (isNaN(index)) return;
  const token = state.readerToken;
  container.dataset.state = "loading";
  container.replaceChildren(createProgressIndicator(null, true));

  try {
    // Enter the same shared preload path used by translation/OCR. Whichever
    // consumer arrives first owns the single download; the rest await it.
    if (!state.preloadedUrls[index]) await preloadFullImage(index, token);
    // Multiple consumers can wake from the same failed preload. Re-check the
    // shared slot before creating a foreground load so only the first
    // continuation becomes the new owner.
    while (!state.preloadedUrls[index]) {
      const competingLoad = preloadInFlight.get(index);
      if (!competingLoad) break;
      await competingLoad;
      if (token !== state.readerToken || state.view !== "reader") return;
    }
    let image: DisplayImageResult;
    if (state.preloadedUrls[index]) {
      image = {
        url: state.preloadedUrls[index],
        imageUrl: state.imageUrls[index] ?? "",
      };
    } else {
      const requestId = `stream-${token}-${index}-${Date.now()}`;
      let loadedImage: DisplayImageResult | null = null;
      let loadError: unknown = null;
      let foregroundTask!: Promise<PreloadResult>;
      foregroundTask = (async () => {
        try {
          loadedImage = await loadDisplayImageDataUrl(index, requestId, (progress) => {
            if (token !== state.readerToken || container.dataset.state !== "loading") return;
            container.replaceChildren(createProgressIndicator(progress, true));
          });
          if (token !== state.readerToken || state.view !== "reader") return "failed";
          state.preloadedUrls[index] = loadedImage.url;
          if (loadedImage.imageUrl) state.imageUrls[index] = loadedImage.imageUrl;
          delete state.preloadFailures[index];
          return "loaded";
        } catch (error) {
          loadError = error;
          return "failed";
        } finally {
          if (preloadInFlight.get(index) === foregroundTask) preloadInFlight.delete(index);
        }
      })();
      // Register the visible load in the same map. Scheduled retries,
      // OCR prefetches now await this download instead of starting a second one
      // on slow connections.
      preloadInFlight.set(index, foregroundTask);
      await foregroundTask;
      if (loadError) throw loadError;
      if (!loadedImage) throw new Error("图片加载已取消");
      image = loadedImage;
    }
    if (token !== state.readerToken || container.dataset.state !== "loading") return;
    state.preloadedUrls[index] = image.url;
    if (image.imageUrl) state.imageUrls[index] = image.imageUrl;

    const img = document.createElement("img");
    img.className = "stream-img";
    img.alt = state.photos[index]?.title || `#${index + 1}`;
    img.decoding = "async";
    img.addEventListener("load", () => {
      if (token !== state.readerToken) return;
      container.dataset.state = "loaded";
      container.replaceChildren(img);
      setSoftStatus(`已加载 ${index + 1} / ${state.photos.length}`);
      if (state.ocrEnabled) {
        if (state.translateEnabled) queueOcrWindow(index);
        else {
          queueOcr(index);
          queueOcr(index - 1);
          queueOcr(index + 1);
        }
      }
      // Dimensions are stable on the next paint; fixed 450ms waits made cached
      // translations feel slow for no correctness benefit.
      window.requestAnimationFrame(() => {
        if (token !== state.readerToken || container.dataset.state !== "loaded") return;
        if (state.ocrRegions[index] !== undefined) renderStreamOcrOverlay(index);
        if (state.translateEnabled && state.translateTexts[index] !== undefined) renderTranslateOverlay(index);
        if (state.translateEnabled) renderTranslateBadge(index);
      });
    }, { once: true });
    img.addEventListener("error", () => {
      if (token !== state.readerToken) return;
      container.dataset.state = "error";
      renderStreamError(container, index, "这张图片暂时没有加载出来");
    }, { once: true });
    img.src = image.url;
    container.replaceChildren(img);
  } catch (error) {
    if (token !== state.readerToken || container.dataset.state !== "loading") return;
    container.dataset.state = "error";
    const message = error instanceof Error ? error.message : String(error);
    renderStreamError(container, index, message);
  }
}

function renderStreamError(container: HTMLElement, index: number, message: string) {
  const error = document.createElement("div");
  error.className = "stream-error";

  const title = document.createElement("strong");
  title.textContent = `第 ${index + 1} 张加载失败`;

  const text = document.createElement("span");
  text.textContent = message || "网络不稳定，稍后再试";

  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "重试";
  retry.addEventListener("click", (event) => {
    event.stopPropagation();
    container.dataset.state = "";
    loadStreamImage(container);
  });

  error.append(title, text, retry);
  container.replaceChildren(error);
}

async function loadAlbumReader(aid: string, title: string) {
  if (state.view === "list") saveListSnapshot();
  const token = ++state.readerToken;
  resetReaderPipelines(true);
  state.listToken++;
  state.view = "reader";
  const standalone = shell.classList.contains("standalone-album");
  const placeholderTitle = title || (standalone ? "正在打开作品…" : `作品 ${aid}`);
  state.currentAlbum = { aid, title: placeholderTitle };
  state.photos = [];
  state.tags = [];
  state.albumCategories = [];
  state.author = null;
  state.preloadedUrls = {};
  state.preloadFailures = {};
  state.ocrRegions = {};
  state.ocrFailed = {};
  state.translateTexts = {};
  state.translateFailed = {};
  state.imageUrls = {};
  syncToolbar();
  if (standalone) {
    showStandaloneSkeleton(aid);
    setStatus("正在抓取页面…");
  } else {
    showEmpty("正在打开作品...");
  }

  try {
    const detail = await invokeTauri<AlbumDetail>("fetch_album_photos", { aid });
    if (token !== state.readerToken || state.view !== "reader" || state.currentAlbum?.aid !== aid) return;
    state.photos = detail.photos;
    state.tags = detail.tags ?? [];
    state.albumCategories = detail.categories ?? [];
    state.author = detail.author ?? null;
    syncReaderInfo();
    const resolvedTitle = (detail.title || title || "").trim() || `作品 ${aid}`;
    state.currentAlbum = { aid, title: resolvedTitle };
    applyAlbumTitle(resolvedTitle);
    if (detail.photos.length === 0) {
      showEmpty("这本作品暂时没有图片");
      setStatus("暂无内容");
      return;
    }
    renderReaderGrid(state.tags, state.albumCategories, state.author);
    setStatus(`共 ${detail.photos.length} 张`);
  } catch (error) {
    if (token !== state.readerToken || state.view !== "reader" || state.currentAlbum?.aid !== aid) return;
    const message = error instanceof Error ? error.message : String(error);
    showError(message, () => loadAlbumReader(aid, title));
    setStatus("加载失败");
    showToast(`图集加载失败：${message}`, "error", 3600);
  }
}

function backToList(options: { restore?: boolean } = {}) {
  if (shell.classList.contains("standalone-album")) {
    // 独立窗口模式:不返回列表,关掉这个窗口
    closeStandaloneWindow();
    return;
  }
  const restore = options.restore ?? true;
  state.readerToken++;
  resetReaderPipelines(true);
  state.view = "list";
  state.currentAlbum = null;
  resetWindowTitle();
  state.photos = [];
  state.tags = [];
  state.albumCategories = [];
  state.author = null;
  state.preloadedUrls = {};
  state.preloadFailures = {};
  state.ocrRegions = {};
  state.ocrFailed = {};
  state.translateTexts = {};
  state.translateFailed = {};
  state.imageUrls = {};
  teardownReaderObserver();
  resultGrid.className = "result-grid";
  syncToolbar();
  if (restore && restoreListSnapshot()) return;
  loadAlbums();
}

// ---- image decode preload ----

const PRELOAD_POOL_MAX_IMAGES = 4;
const preloadPool = document.createElement("div");
preloadPool.className = "preload-pool";
document.body.append(preloadPool);

function clearPreloadPool() {
  preloadPool.replaceChildren();
}

function preloadImage(url: string) {
  const existing = Array.from(preloadPool.querySelectorAll<HTMLImageElement>("img")).some(
    (img) => img.dataset.src === url,
  );
  if (existing) return;
  const img = document.createElement("img");
  img.dataset.src = url;
  img.src = url;
  preloadPool.append(img);
  while (preloadPool.childElementCount > PRELOAD_POOL_MAX_IMAGES) {
    preloadPool.firstElementChild?.remove();
  }
}

// ---- keyboard ----

function isInteractiveShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "button, input, textarea, select, a[href], [contenteditable]:not([contenteditable='false']), [role='button'], [role='link']",
    ),
  );
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && readerSettingsOpen) {
    e.preventDefault();
    e.stopPropagation();
    setReaderSettingsOpen(false);
    readerSettingsButton.focus();
    return;
  }
  if (e.key === "Escape" && readerInfoOpen) {
    e.preventDefault();
    e.stopPropagation();
    setReaderInfoOpen(false);
    readerInfoButton.focus();
    return;
  }
  if (e.key === "F11") {
    e.preventDefault();
    toggleFullscreen();
    return;
  }

  const hasCommandModifier = e.ctrlKey || e.metaKey || e.altKey;
  if (state.view === "reader" && !hasCommandModifier && !isInteractiveShortcutTarget(e.target)) {
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      adjustReaderZoom(READER_ZOOM_STEP);
      return;
    }
    if (e.key === "-") {
      e.preventDefault();
      adjustReaderZoom(-READER_ZOOM_STEP);
      return;
    }
    if (e.key === "0") {
      e.preventDefault();
      setReaderZoom(1);
      return;
    }
    if (e.key.toLowerCase() === "w") {
      cycleReaderWidth();
      return;
    }
    if (e.key.toLowerCase() === "g") {
      toggleReaderGap();
      return;
    }
    if (e.key.toLowerCase() === "v") {
      toggleReaderFit();
      return;
    }
    if (e.key.toLowerCase() === "p") {
      toggleReaderPreload();
      return;
    }
    if (ocrBoxDebug && e.key.toLowerCase() === "o") {
      toggleReaderOcr();
      return;
    }
    if (e.key.toLowerCase() === "r") {
      toggleReaderTranslate();
      return;
    }
    if (state.photos.length > 0) {
      const key = e.key;
      const lower = key.toLowerCase();
      if (key === " ") {
        e.preventDefault();
        const direction = e.shiftKey ? -1 : 1;
        if (state.readerFit === "width") {
          resultGrid.scrollBy({
            top: direction * Math.max(240, resultGrid.clientHeight * 0.85),
            behavior: "smooth",
          });
        } else {
          turnReaderPage(direction);
        }
        return;
      }
      if (state.readerFit !== "width" && key === "ArrowRight") {
        e.preventDefault();
        turnReaderPage(1);
        return;
      }
      if (state.readerFit !== "width" && key === "ArrowLeft") {
        e.preventDefault();
        turnReaderPage(-1);
        return;
      }
      if (lower === "j" || key === "PageDown") {
        e.preventDefault();
        if (state.readerFit === "width") scrollToStreamIndex(currentStreamIndex() + 1);
        else turnReaderPage(1);
        return;
      }
      if (lower === "k" || key === "PageUp") {
        e.preventDefault();
        if (state.readerFit === "width") scrollToStreamIndex(currentStreamIndex() - 1);
        else turnReaderPage(-1);
        return;
      }
      if (key === "Home") {
        e.preventDefault();
        scrollToStreamIndex(0);
        return;
      }
      if (key === "End") {
        e.preventDefault();
        scrollToStreamIndex(state.photos.length - 1);
        return;
      }
    }
  }

  if (state.view === "reader" && e.key === "Escape") {
    if (state.fullscreen) {
      toggleFullscreen();
      return;
    }
    backToList();
  } else if (
    state.view === "reader"
    && !hasCommandModifier
    && e.key.toLowerCase() === "x"
    && !isInteractiveShortcutTarget(e.target)
  ) {
    if (state.fullscreen) {
      toggleFullscreen();
      return;
    }
    backToList();
  }
});

document.addEventListener("fullscreenchange", () => {
  setFullscreenState(Boolean(document.fullscreenElement));
});

// ---- events ----

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = searchInput.value.trim();
  if (!query) return;

  state.mode = "search";
  state.query = query;
  state.linkPath = "";
  searchInput.value = query;
  state.page = 1;
  state.allLoaded = false;
  loadAlbums();
});

refreshButton.addEventListener("click", () => loadAlbums());

backButton.addEventListener("click", () => backToList());

backButton.textContent = "←";
backButton.setAttribute("aria-label", "返回列表");
backButton.title = "返回 (Esc/X)";

jumpTopButton.addEventListener("click", () => {
  if (state.readerFit === "spread") scrollToStreamIndex(0);
  else resultGrid.scrollTo({ top: 0, behavior: "smooth" });
});

let readerNativeGestureActive = false;

resultGrid.addEventListener(
  "wheel",
  (event) => {
    if (state.view !== "reader" || readerNativeGestureActive) return;
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.004);
    setReaderZoom(state.readerZoom * factor, event.clientX, event.clientY);
  },
  { passive: false },
);

resultGrid.addEventListener("gesturestart", (event) => {
  if (state.view !== "reader") return;
  event.preventDefault();
  readerNativeGestureActive = true;
  state.readerGestureStartZoom = state.readerZoom;
  resultGrid.classList.add("reader-zooming");
});

resultGrid.addEventListener("gesturechange", (event) => {
  if (state.view !== "reader" || !readerNativeGestureActive) return;
  event.preventDefault();
  const gesture = event as GestureEventLike;
  setReaderZoom(
    state.readerGestureStartZoom * (gesture.scale ?? 1),
    gesture.clientX,
    gesture.clientY,
  );
});

const finishReaderNativeGesture = (event: Event) => {
  if (!readerNativeGestureActive) return;
  event.preventDefault();
  readerNativeGestureActive = false;
  commitReaderZoom();
};

resultGrid.addEventListener("gestureend", finishReaderNativeGesture);
resultGrid.addEventListener("gesturecancel", finishReaderNativeGesture);

let resultScrollFrame = 0;
resultGrid.addEventListener(
  "scroll",
  () => {
    const snapshot = state.listSnapshots[listContextKey()];
    if (state.view === "list" && snapshot) {
      snapshot.scrollTop = resultGrid.scrollTop;
    }
    if (resultScrollFrame) return;
    resultScrollFrame = window.requestAnimationFrame(() => {
      resultScrollFrame = 0;
      updateJumpTopButton();
      updateReaderProgress();
    });
  },
  { passive: true },
);

// ---- infinite scroll ----

let scrollSentinel: HTMLElement | null = null;
let scrollObserver: IntersectionObserver | null = null;

function teardownInfiniteScroll() {
  scrollObserver?.disconnect();
  scrollObserver = null;
  scrollSentinel?.remove();
  scrollSentinel = null;
}

function setupInfiniteScroll() {
  teardownInfiniteScroll();
  if (state.view !== "list" || state.allLoaded || state.loadMoreError) return;

  scrollSentinel = document.createElement("div");
  scrollSentinel.className = "scroll-sentinel";
  scrollSentinel.style.height = "1px";
  resultGrid.append(scrollSentinel);

  scrollObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && state.view === "list") {
      loadNextPage();
    }
  }, { root: resultGrid, rootMargin: "400px" });

  scrollObserver.observe(scrollSentinel);
}

// ---- init ----

function getInitialAlbumFromHash(): string | null {
  const hash = window.location.hash;
  if (!hash) return null;
  const match = hash.match(/aid=([\w-]+)/);
  return match ? match[1] : null;
}

renderCategories();
syncFullscreenState();
enforceOcrCapabilities(ocrCapabilities);
void refreshOcrCapabilities();

loadTitleTranslateState();
syncTitleTranslateToggle();
document.querySelector<HTMLInputElement>("#title-translate-toggle")
  ?.addEventListener("change", toggleTitleTranslate);

// 跨窗口同步阅读偏好
listen<Partial<ReaderPrefs>>("reader-prefs-changed", (event) => {
  const payload = event.payload || {};
  const incomingZoom = typeof payload.zoom === "number" ? normalizeReaderZoom(payload.zoom) : state.readerZoom;
  const incomingFit = payload.fit === "page" || payload.fit === "spread" || payload.fit === "width"
    ? payload.fit
    : state.readerFit;
  const fitWillChange = incomingFit !== state.readerFit;
  const currentIndexBeforeLayout = state.view === "reader" ? currentStreamIndex() : -1;
  const readerAnchor = state.view === "reader"
    && !fitWillChange
    && (
      (payload.width !== undefined && payload.width !== state.readerWidth)
      || incomingZoom !== state.readerZoom
      || (payload.gap !== undefined && payload.gap !== state.readerGap)
    )
    ? captureReaderAnchor()
    : null;
  let dirty = false;
  let readerFitChanged = false;
  let conserveImagesChanged = false;
  let ocrLangChanged = false;
  let ocrBoxesChanged = false;
  let translateModeChanged = false;
  if (payload.width && payload.width !== state.readerWidth) {
    state.readerWidth = payload.width;
    dirty = true;
  }
  if (incomingZoom !== state.readerZoom) {
    state.readerZoom = incomingZoom;
    dirty = true;
  }
  if (payload.gap && payload.gap !== state.readerGap) {
    state.readerGap = payload.gap;
    dirty = true;
  }
  if (typeof payload.conserveImages === "boolean" && payload.conserveImages !== state.conserveImages) {
    state.conserveImages = payload.conserveImages;
    conserveImagesChanged = true;
    dirty = true;
  }
  if (typeof payload.ocrBoxes === "boolean" && payload.ocrBoxes !== state.ocrEnabled) {
    state.ocrEnabled = payload.ocrBoxes;
    ocrEnableToken++; // 其它窗口改了 OCR 开关,同样作废进行中的“开启”请求
    ocrBoxesChanged = true;
    dirty = true;
  }
  if (fitWillChange) {
    state.readerFit = incomingFit;
    readerFitChanged = true;
    dirty = true;
  }
  const incomingOcrLang = normalizeOcrLanguage(payload.ocrLang);
  if (incomingOcrLang !== null && incomingOcrLang !== state.ocrLang) {
    state.ocrLang = incomingOcrLang;
    ocrLangChanged = true;
    dirty = true;
  }
  if (typeof payload.translateMode === "boolean" && payload.translateMode !== state.translateEnabled) {
    state.translateEnabled = payload.translateMode;
    translateModeChanged = true;
    dirty = true;
  }
  if (state.translateEnabled && (!state.ocrEnabled || state.ocrLang !== "ja")) {
    state.translateEnabled = false;
    translateModeChanged = true;
    dirty = true;
  }
  if (dirty) {
    if (ocrBoxesChanged || ocrLangChanged || translateModeChanged) resetReaderPipelines();
    saveReaderPrefs();
    applyReaderPrefs();
    syncReaderControls();
    syncReaderPageControls();
    if (readerFitChanged) {
      if (state.view === "reader") {
        window.requestAnimationFrame(() => {
          scrollToStreamIndex(Math.max(0, currentIndexBeforeLayout), "auto");
          setupStreamObserver();
          updateReaderProgress();
          redrawReaderOverlays();
        });
      }
    } else {
      restoreReaderAnchor(readerAnchor);
      window.requestAnimationFrame(redrawReaderOverlays);
    }
    if (state.view === "reader" && conserveImagesChanged && !readerFitChanged) {
      setupStreamObserver();
    }
    if (state.ocrEnabled) {
      if (ocrLangChanged) {
        // 识别语言变了,清掉旧结果重新识别
        state.ocrRegions = {};
        state.ocrFailed = {};
        state.translateTexts = {};
        state.translateFailed = {};
        removeAllOcrOverlays();
        removeAllTranslateOverlays();
      }
      if (ocrBoxesChanged || ocrLangChanged) {
        ocrPrefetchLoadedPages();
      }
    } else {
      removeAllOcrOverlays();
      removeAllTranslateOverlays();
    }
    if (translateModeChanged) {
      if (state.translateEnabled && state.ocrEnabled && state.ocrLang === "ja") {
        removeAllOcrOverlays();
        queueOcrWindow(currentStreamIndex());
      } else {
        removeAllTranslateOverlays();
        translatePending.clear();
        if (state.ocrEnabled) renderStreamOcrOverlay(currentStreamIndex());
      }
      updateTranslateBadges();
    }
  }
}).catch((err) => console.error("listen(reader-prefs-changed) failed:", err));

window.addEventListener("resize", () => {
  const pagedIndex = state.view === "reader" && state.readerFit !== "width"
    ? Math.max(0, streamIndexHint)
    : -1;
  applyReaderZoomLayout();
  window.requestAnimationFrame(() => {
    if (pagedIndex >= 0) scrollToStreamIndex(pagedIndex, "auto");
    redrawReaderOverlays();
  });
});

const initialAid = getInitialAlbumFromHash();
void appUpdater.loadCurrentVersion();
listen<AppUpdateSnapshot>("app-update-state", (event) => {
  if (!isAppUpdateSnapshot(event.payload)) return;
  applyingRemoteAppUpdate = true;
  appUpdater.applyRemoteSnapshot(event.payload);
  applyingRemoteAppUpdate = false;
}).then(() => {
  appUpdateEventsReady = true;
  if (initialAid) emit("request-app-update-state").catch(() => {});
}).catch((err) => console.error("listen(app-update-state) failed:", err));
if (initialAid) {
  // 新窗口模式:隐藏 sidebar、跳过列表加载,直接进 reader
  shell.classList.add("standalone-album");
  loadAlbumReader(initialAid, "");
} else {
  loadAlbums();
  listen("request-app-update-state", () => {
    emit("app-update-state", appUpdateSnapshot).catch(() => {});
  }).catch((err) => console.error("listen(request-app-update-state) failed:", err));
  // 主窗口:监听子窗口发来的详情链接浏览请求
  listen<BrowseLinkRequest>("browse-link", (event) => {
    const request = event.payload;
    if (!request || !isLinkedMode(request.kind)) return;
    if (!request.name?.trim() || !request.path?.trim()) return;
    applyLinkedBrowse({
      kind: request.kind,
      name: request.name.trim(),
      path: request.path.trim(),
    });
  }).catch((err) => console.error("listen(browse-link) failed:", err));
}
