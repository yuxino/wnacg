import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

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
  thumbnail: string | null;
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

type ProgressState = {
  loaded: number;
  total: number | null;
  percent: number | null;
};

type DisplayImageResult = {
  url: string;
  viaFallback: boolean;
  imageUrl: string;
};

type Tag = {
  name: string;
  path: string;
};

type AlbumDetail = {
  photos: PhotoEntry[];
  tags: Tag[];
  title?: string | null;
};

type PreloadResult = "loaded" | "failed" | "cached";

type GestureEventLike = Event & {
  scale?: number;
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
type ReaderTheme = "warm" | "dark";
type ReaderFit = "width" | "page";
type ReaderOcrLang = "zh" | "ja";

type ReaderPrefs = {
  width: ReaderWidth;
  gap: ReaderGap;
  theme: ReaderTheme;
  fit: ReaderFit;
  conserveImages: boolean;
  ocrBoxes: boolean;
  ocrLang: ReaderOcrLang;
  translateMode: boolean;
};

const readerPrefKey = "wnacg.readerPrefs.v1";
const persistentListCacheKey = "wnacg.listCache.v1";
const persistentListMaxAge = 24 * 60 * 60 * 1000;

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
  gap: "relaxed",
  theme: "dark",
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
    return {
      width: parsed.width === "wide" || parsed.width === "edge" ? parsed.width : defaultReaderPrefs.width,
      gap: parsed.gap === "compact" ? "compact" : defaultReaderPrefs.gap,
      theme: parsed.theme === "warm" ? "warm" : defaultReaderPrefs.theme,
      conserveImages: typeof parsed.conserveImages === "boolean"
        ? parsed.conserveImages
        : defaultReaderPrefs.conserveImages,
      ocrBoxes: typeof parsed.ocrBoxes === "boolean"
        ? parsed.ocrBoxes
        : defaultReaderPrefs.ocrBoxes,
      ocrLang: parsed.ocrLang === "zh" || parsed.ocrLang === "ja"
        ? parsed.ocrLang
        : defaultReaderPrefs.ocrLang,
      translateMode: typeof parsed.translateMode === "boolean"
        ? parsed.translateMode
        : defaultReaderPrefs.translateMode,
      fit: parsed.fit === "page" ? "page" : defaultReaderPrefs.fit,
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
  mode: "category" as "category" | "search" | "tag",
  category: categories[0],
  query: "",
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
  lightboxIndex: -1,
  lightboxImageUrl: null as string | null,
  preloadedUrls: {} as Record<number, string>, // index -> full image URL
  listToken: 0,
  readerToken: 0,
  lightboxToken: 0,
  lightboxZoom: 1,
  lightboxPanX: 0,
  lightboxPanY: 0,
  lightboxPanning: false,
  lightboxPanStartX: 0,
  lightboxPanStartY: 0,
  lightboxPanBaseX: 0,
  lightboxPanBaseY: 0,
  gestureStartZoom: 1,
  preloadFailures: {} as Record<number, number>,
  retryNotice: "",
  lightboxProgress: null as ProgressState | null,
  fullscreen: false,
  readerWidth: readerPrefs.width,
  readerGap: readerPrefs.gap,
  readerTheme: readerPrefs.theme,
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
// reader, lightbox and translation prefetch downloading the same image in
// parallel.
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
  chevronDown: 'm6 9 6 6 6-6',
  chevronsLeft: 'm11 17-5-5 5-5 M18 17l-5-5 5-5',
  chevronsRight: 'm13 17 5-5-5-5 M6 17l5-5-5-5',
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z',
  scroll:
    'M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4 M19 17V5a2 2 0 0 0-2-2H4',
  home: 'm3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10',
  search: 'M11 11a7 7 0 1 0 7-7 7 7 0 0 0-7 7z M21 21l-4.35-4.35',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  resetZoom: 'M3 3h6v6 M21 21h-6v-6 M21 3l-7 7 M3 21l7-7',
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
  const index = state.lightboxIndex >= 0 ? state.lightboxIndex : currentStreamIndex();
  if (state.translateFailed[index]) {
    delete state.translateFailed[index];
    translateDone.delete(index);
    queueOcrText(index);
    queueTranslate(index);
    refreshTranslateStatus();
  }
});
pagerControls.append(translateStatus);

const fullscreenButton = document.createElement("button");
fullscreenButton.type = "button";
fullscreenButton.className = "fullscreen-button";
fullscreenButton.title = "全屏 (F11)";
fullscreenButton.hidden = true;
fullscreenButton.addEventListener("click", () => toggleFullscreen());
pagerControls.append(fullscreenButton);

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
readerSettingsPanel.addEventListener("click", (event) => event.stopPropagation());

readerSettings.append(readerSettingsButton, readerSettingsPanel);

pagerControls.append(readerSettings);

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
  const visible = state.view === "list" && state.mode !== "tag";
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

  const groups: Array<{ title: string; render: () => HTMLElement }> = [
    {
      title: "阅读宽度",
      render: () => renderSegmented<ReaderWidth>(
        [
          { label: "适中", value: "comfort" },
          { label: "宽屏", value: "wide" },
          { label: "贴边", value: "edge", hint: "W" },
        ],
        state.readerWidth,
        (v) => updateReaderPrefs({ width: v }),
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
      title: "阅读背景",
      render: () => renderSegmented<ReaderTheme>(
        [
          { label: "暗场", value: "dark" },
          { label: "暖色", value: "warm", hint: "T" },
        ],
        state.readerTheme,
        (v) => updateReaderPrefs({ theme: v }),
      ),
    },
    {
      title: "整页显示",
      render: () => renderSegmented<ReaderFit>(
        [
          { label: "关闭", value: "width" },
          { label: "开启", value: "page", hint: "V" },
        ],
        state.readerFit,
        (v) => updateReaderPrefs({ fit: v }),
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
        [
          { label: "中文优先", value: "zh" },
          { label: "日文优先", value: "ja" },
        ],
        state.ocrLang,
        (v) => updateReaderPrefs({ ocrLang: v }),
      ),
    },
    {
      title: "翻译字幕",
      render: () => renderSegmented<boolean>(
        [
          { label: "关闭", value: false },
          { label: "开启", value: true, hint: "R" },
        ],
        state.translateEnabled,
        (v) => toggleReaderTranslate(v),
      ),
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
          setTitleTranslate(v);
          showToast(
            v
              ? "生肉标题翻译已开启，列表与详情标题将显示中文"
              : "生肉标题翻译已关闭，恢复原标题",
            "success",
            2600,
          );
        },
      ),
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
      const label = document.createElement("span");
      label.className = "settings-label";
      label.textContent = group.title;
      row.append(label, group.render());
      return row;
    }),
  );
}

let readerSettingsOpen = false;

function setReaderSettingsOpen(open: boolean) {
  readerSettingsOpen = open;
  readerSettingsPanel.hidden = !open;
  readerSettingsButton.classList.toggle("active", open);
  readerSettingsButton.setAttribute("aria-expanded", String(open));
  if (open) buildReaderSettingsPanel();
}

function toggleReaderSettingsPanel() {
  setReaderSettingsOpen(!readerSettingsOpen);
}

document.addEventListener("click", (event) => {
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

function showToast(message: string, tone: ToastTone = "info", durationMs = 2400) {
  const toast = document.createElement("div");
  toast.className = `toast toast-${tone}`;
  const text = document.createElement("span");
  text.textContent = message;
  toast.append(text);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "关闭");
  close.textContent = "×";
  close.addEventListener("click", () => dismiss());
  toast.append(close);
  toastContainer.append(toast);
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    toast.classList.add("toast-leaving");
    window.setTimeout(() => toast.remove(), 220);
  };
  window.setTimeout(dismiss, durationMs);
  return dismiss;
}

function setStatus(message: string) {
  statusLabel.textContent = message;
}

function saveReaderPrefs() {
  const prefs: ReaderPrefs = {
    width: state.readerWidth,
    gap: state.readerGap,
    theme: state.readerTheme,
    fit: state.readerFit,
    conserveImages: state.conserveImages,
    ocrBoxes: state.ocrEnabled,
    ocrLang: state.ocrLang,
    translateMode: state.translateEnabled,
  };
  localStorage.setItem(readerPrefKey, JSON.stringify(prefs));
}

function applyReaderPrefs() {
  shell.dataset.readerWidth = state.readerWidth;
  shell.dataset.readerGap = state.readerGap;
  shell.dataset.readerTheme = state.readerTheme;
  shell.dataset.readerFit = state.readerFit;
  shell.classList.toggle("reader-low-data", state.conserveImages);
}

function syncReaderControls() {
  readerSettings.hidden = false;
  if (readerSettingsOpen) buildReaderSettingsPanel();
}

function updateReaderPrefs(next: Partial<ReaderPrefs>) {
  const previousConserve = state.conserveImages;
  const previousFit = state.readerFit;
  const previousOcr = state.ocrEnabled;
  const previousOcrLang = state.ocrLang;
  const previousTranslate = state.translateEnabled;
  // 联动：翻译字幕(R)关掉时，OCR 识别管线也跟着关，避免后台空转
  if (previousTranslate && next.translateMode === false) {
    next.ocrBoxes = false;
  }
  Object.assign(state, {
    readerWidth: next.width ?? state.readerWidth,
    readerGap: next.gap ?? state.readerGap,
    readerTheme: next.theme ?? state.readerTheme,
    readerFit: next.fit ?? state.readerFit,
    conserveImages: next.conserveImages ?? state.conserveImages,
    ocrEnabled: next.ocrBoxes ?? state.ocrEnabled,
    ocrLang: next.ocrLang ?? state.ocrLang,
    translateEnabled: next.translateMode ?? state.translateEnabled,
  });
  saveReaderPrefs();
  applyReaderPrefs();
  syncReaderControls();
  // 广播给其它窗口同步主题
  emit("reader-prefs-changed", {
    width: state.readerWidth,
    gap: state.readerGap,
    theme: state.readerTheme,
    fit: state.readerFit,
    conserveImages: state.conserveImages,
    ocrBoxes: state.ocrEnabled,
    ocrLang: state.ocrLang,
    translateMode: state.translateEnabled,
  }).catch(() => {});

  if (state.view === "reader" && previousFit !== state.readerFit) {
    redrawReaderOverlays();
  }
  if (state.view === "reader" && previousConserve !== state.conserveImages) {
    setupStreamObserver();
  }
  if (!state.conserveImages && state.lightboxIndex >= 0) {
    preloadNeighbors(state.lightboxIndex);
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
      queueTranslate(state.lightboxIndex >= 0 ? state.lightboxIndex : currentStreamIndex());
      updateTranslateBadges();
    } else {
      removeAllTranslateOverlays();
      translatePending.clear();
      updateTranslateBadges();
      if (state.ocrEnabled) {
        const index = state.lightboxIndex >= 0 ? state.lightboxIndex : currentStreamIndex();
        renderStreamOcrOverlay(index);
        renderLightboxOcrOverlay();
      }
    }
  }
}

function cycleReaderWidth() {
  const order: ReaderWidth[] = ["comfort", "wide", "edge"];
  const next = order[(order.indexOf(state.readerWidth) + 1) % order.length];
  updateReaderPrefs({ width: next });
}

function toggleReaderGap() {
  updateReaderPrefs({ gap: state.readerGap === "relaxed" ? "compact" : "relaxed" });
}

function toggleReaderTheme() {
  updateReaderPrefs({ theme: state.readerTheme === "dark" ? "warm" : "dark" });
}

function toggleReaderFit() {
  updateReaderPrefs({ fit: state.readerFit === "page" ? "width" : "page" });
}

function toggleReaderPreload() {
  updateReaderPrefs({ conserveImages: !state.conserveImages });
}

// ---- 本地 OCR (文字区域框选) ----

const OCR_BATCH = 4;
const ocrPendingIndices = new Set<number>();
let ocrBatchRunning = false;
let readerPipelineEpoch = 0;
// OCR 开关竞态令牌:引擎初始化期间开关被再次切换时,用来取消过期的“开启”请求
let ocrEnableToken = 0;
// 文字框红框仅调试用:默认不画,正常用户无感知;调试时实时开关并记忆
let ocrBoxDebug = (() => {
  try {
    return localStorage.getItem("wnacg.debugOcrBoxes.v1") === "1";
  } catch {
    return false;
  }
})();
function setOcrBoxDebug(value: boolean) {
  ocrBoxDebug = value;
  try {
    localStorage.setItem("wnacg.debugOcrBoxes.v1", value ? "1" : "0");
  } catch {
    // localStorage 不可用时只改内存,不影响本次会话
  }
  if (value) {
    const index = state.lightboxIndex >= 0 ? state.lightboxIndex : currentStreamIndex();
    renderStreamOcrOverlay(index);
    renderLightboxOcrOverlay();
  } else {
    removeAllOcrOverlays();
  }
}
const ocrTextPending = new Set<number>();
const ocrTextInFlight = new Set<number>();
const ocrTextDone = new Set<number>();
let ocrTextWorkers = 0;
const OCR_TEXT_CONCURRENCY = 2;
let ocrMangaInitTried = false;

function ocrLanguages(): string[] {
  return state.ocrLang === "zh"
    ? ["zh-Hans", "zh-Hant", "ja-JP", "en-US"]
    : ["ja-JP", "zh-Hans", "zh-Hant", "en-US"];
}

function ocrEngine(): string {
  // 日文优先:漫画专用本地引擎(竖排日文);中文优先:Apple Vision(横排中文)
  return state.ocrLang === "ja" ? "manga" : "vision";
}

function isVisiblePage(index: number): boolean {
  return index === state.lightboxIndex
    || (state.lightboxIndex < 0 && index === currentStreamIndex());
}

function isNearPage(index: number): boolean {
  // 翻译预取窗口:当前页前 1 后 3,提前识别+翻译,滚动过去时基本已就绪
  if (index < 0 || index >= state.photos.length) return false;
  if (state.lightboxIndex >= 0) {
    return index >= state.lightboxIndex - 1 && index <= state.lightboxIndex + 3;
  }
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

  const firstTime = ocrEngine() === "manga" && !ocrMangaInitTried;
  if (ocrEngine() === "manga") ocrMangaInitTried = true;
  const toast = showToast(
    firstTime
      ? "正在准备本地漫画 OCR（首次需下载约 230MB 模型，请稍候）…"
      : "正在初始化本地 OCR 引擎…",
    "info",
    240_000,
  );
  try {
    await invokeTauri<string>("ocr_engine_status", { engine: ocrEngine() });
    if (token !== ocrEnableToken) {
      // 等待引擎期间开关又被切换(比如 R 关了联动把 O 关掉),放弃本次开启
      toast();
      return;
    }
    toast();
    updateReaderPrefs({ ocrBoxes: true });
    showToast("本地 OCR 已开启", "success", 2600);
  } catch (error) {
    toast();
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

  if (index === state.lightboxIndex) {
    const lightboxImg = document.querySelector<HTMLImageElement>(".lightbox-image");
    if (lightboxImg?.src && lightboxImg.src.startsWith("data:")) return lightboxImg.src;
  }
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
  try {
    const results = await invokeTauri<OcrPageResult[]>("ocr_pages", {
      pages: items.map((item) => ({
        index: item.index,
        imageUrl: item.imageUrl,
        dataUrl: item.imageUrl && ocrByteCacheUrls.has(item.imageUrl) ? null : item.dataUrl,
        languages: ocrLanguages(),
        engine: ocrEngine(),
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
          if (result.index === state.lightboxIndex) renderLightboxTranslateBadge();
        }
        if (
          !result.error
          && state.ocrLang === "ja"
          && (isVisiblePage(result.index) || (state.translateEnabled && isNearPage(result.index)))
        ) {
          queueOcrText(result.index);
        }
      }
      if (results.some((result) => result.index === state.lightboxIndex)) {
        renderLightboxOcrOverlay();
      }
    }
  } catch (error) {
    if (token !== state.readerToken || aid !== state.currentAlbum?.aid || epoch !== readerPipelineEpoch || state.view !== "reader") return;
    const message = error instanceof Error ? error.message : String(error);
    for (const item of items) {
      ocrPendingIndices.delete(item.index);
      state.ocrFailed[item.index] = message;
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
  const center = state.lightboxIndex >= 0 ? state.lightboxIndex : currentStreamIndex();
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
    void invokeTauri<OcrPageResult[]>("ocr_pages", {
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
    }).then((results) => {
      if (token !== state.readerToken || aid !== state.currentAlbum?.aid || epoch !== readerPipelineEpoch || state.view !== "reader") return;
      const result = results[0];
      if (!result) throw new Error("OCR 返回为空");
      if (result.error) {
        if (result.error.includes("等待")) {
          if (sources.imageUrl) ocrByteCacheUrls.delete(sources.imageUrl);
          if (sources.dataUrl) ocrTextPending.add(index);
        } else {
          state.ocrFailed[index] = result.error;
        }
        return;
      }
      state.ocrRegions[index] = result.regions;
      ocrTextDone.add(index);
      renderStreamOcrOverlay(index);
      if (state.translateEnabled) {
        renderTranslateBadge(index);
        queueTranslate(index);
        if (index === state.lightboxIndex) {
          renderLightboxOcrOverlay();
          renderLightboxTranslateBadge();
        }
      }
    }).catch((error) => {
      if (token !== state.readerToken || aid !== state.currentAlbum?.aid || epoch !== readerPipelineEpoch || state.view !== "reader") return;
      const message = error instanceof Error ? error.message : String(error);
      state.ocrFailed[index] = message;
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
  }
}

async function toggleReaderTranslate(force?: boolean) {
  const next = force ?? !state.translateEnabled;
  if (next === state.translateEnabled) return;
  if (!next) {
    updateReaderPrefs({ translateMode: false });
    return;
  }
  if (state.ocrLang !== "ja") {
    updateReaderPrefs({ ocrLang: "ja" });
  }
  updateReaderPrefs({ translateMode: true });
  const target = state.lightboxIndex >= 0 ? state.lightboxIndex : currentStreamIndex();
  queueOcrWindow(target);
}

function queueTranslate(index: number) {
  if (!state.translateEnabled || state.ocrLang !== "ja") return;
  if (index < 0 || index >= state.photos.length) return;
  const regions = state.ocrRegions[index];
  if (!regions || regions.length === 0) return;
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
    if (index === state.lightboxIndex) renderLightboxTranslateBadge();
    return;
  }
  translatePending.add(index);
  renderTranslateBadge(index);
  if (index === state.lightboxIndex) renderLightboxTranslateBadge();
  pumpTranslateQueue();
}

function nextTranslateIndex(): number | null {
  const center = state.lightboxIndex >= 0 ? state.lightboxIndex : currentStreamIndex();
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
      if (index === state.lightboxIndex) renderLightboxTranslateOverlay();
      renderTranslateBadge(index);
      if (index === state.lightboxIndex) renderLightboxTranslateBadge();
    }).catch((error) => {
      if (token !== state.readerToken || aid !== state.currentAlbum?.aid || epoch !== readerPipelineEpoch || state.view !== "reader") return;
      const message = error instanceof Error ? error.message : String(error);
      state.translateFailed[index] = message;
      renderTranslateBadge(index);
      if (index === state.lightboxIndex) renderLightboxTranslateBadge();
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
  // Stream pages can keep several overlays alive; 1.5x is crisp on Retina
  // while using 44% less canvas memory than 2x.
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
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

function renderLightboxTranslateOverlay() {
  const wrap = document.querySelector<HTMLElement>(".lightbox-image-wrap");
  const img = document.querySelector<HTMLImageElement>(".lightbox-image");
  wrap?.querySelector(".lightbox-translate-overlay")?.remove();
  if (!wrap || !img || !img.complete || img.naturalWidth === 0) return;
  if (!state.translateEnabled) return;

  const regions = state.ocrRegions[state.lightboxIndex];
  const texts = state.translateTexts[state.lightboxIndex];
  if (!regions || !texts) return;

  const canvas = document.createElement("canvas");
  canvas.className = "lightbox-translate-overlay";
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(img.offsetWidth * dpr));
  canvas.height = Math.max(1, Math.round(img.offsetHeight * dpr));
  canvas.style.left = `${img.offsetLeft}px`;
  canvas.style.top = `${img.offsetTop}px`;
  canvas.style.width = `${img.offsetWidth}px`;
  canvas.style.height = `${img.offsetHeight}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const sampler = ensureSampleCanvas(img);
  ctx.scale(dpr, dpr);
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    const translated = texts[i]?.trim();
    if (!translated) continue;
    const x = region.x * img.offsetWidth;
    const y = region.y * img.offsetHeight;
    const w = region.w * img.offsetWidth;
    const h = region.h * img.offsetHeight;
    if (w < 4 || h < 4) continue;
    drawCoverAndText(ctx, sampler, x, y, w, h, translated);
  }
  wrap.append(canvas);
  attachTranslateTooltip(canvas, regions);
  renderLightboxTranslateBadge();
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
  document.querySelectorAll<HTMLCanvasElement>(
    ".stream-translate-overlay, .lightbox-translate-overlay",
  ).forEach((canvas) => {
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

// ---- 翻译状态徽标:让用户感知"正在翻译" ----

function translateBusy(index: number): boolean {
  if (index < 0 || index >= state.photos.length) return false;
  if (translateDone.has(index)) return false;
  if (state.translateFailed[index]) return false;
  const regions = state.ocrRegions[index];
  if (!regions || regions.length === 0) return false; // 还没框选出文字区域
  // 有文字区域但还没翻译完成:识别/翻译任意阶段都显示"翻译中…"
  return true;
}

function renderTranslateBadge(index: number) {
  refreshTranslateStatus();
  const container = document.querySelector<HTMLElement>(`.stream-photo[data-index="${index}"]`);
  if (!container) return;
  container.querySelector(".stream-translate-badge")?.remove();
  if (!state.translateEnabled) return;
  const failed = state.translateFailed[index];
  const busy = translateBusy(index);
  if (!failed && !busy) return;

  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = failed ? "translate-badge stream-translate-badge failed" : "translate-badge stream-translate-badge";
  badge.textContent = failed ? "翻译失败 · 点击重试" : "翻译中…";
  badge.addEventListener("click", (event) => {
    event.stopPropagation();
    if (failed) {
      delete state.translateFailed[index];
      translateDone.delete(index);
      queueOcrText(index);
      queueTranslate(index);
      renderTranslateBadge(index);
    }
  });
  container.append(badge);
}

function renderLightboxTranslateBadge() {
  const wrap = document.querySelector<HTMLElement>(".lightbox-image-wrap");
  wrap?.querySelector(".lightbox-translate-badge")?.remove();
  if (!wrap || !state.translateEnabled) return;
  const index = state.lightboxIndex;
  const failed = state.translateFailed[index];
  const busy = translateBusy(index);
  if (!failed && !busy) return;
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = failed ? "translate-badge lightbox-translate-badge failed" : "translate-badge lightbox-translate-badge";
  badge.textContent = failed ? "翻译失败 · 点击重试" : "翻译中…";
  badge.addEventListener("click", (event) => {
    event.stopPropagation();
    if (failed) {
      delete state.translateFailed[index];
      translateDone.delete(index);
      queueOcrText(index);
      queueTranslate(index);
      renderLightboxTranslateBadge();
    }
  });
  wrap.append(badge);
}

function updateTranslateBadges() {
  const indices: number[] = [];
  if (state.lightboxIndex >= 0) {
    for (let i = state.lightboxIndex - 1; i <= state.lightboxIndex + 3; i++) {
      if (i >= 0 && i < state.photos.length) indices.push(i);
    }
  } else {
    const current = currentStreamIndex();
    for (let i = current - 1; i <= current + 3; i++) {
      if (i >= 0 && i < state.photos.length) indices.push(i);
    }
  }
  for (const index of indices) renderTranslateBadge(index);
  if (state.lightboxIndex >= 0) renderLightboxTranslateBadge();
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
    const current = state.lightboxIndex >= 0 ? state.lightboxIndex : currentStreamIndex();
    if (current >= 0) queueOcrWindow(current);
    return;
  }
  document.querySelectorAll<HTMLElement>(".stream-photo[data-state='loaded']").forEach((el) => {
    const index = parseInt(el.dataset.index || "", 10);
    if (!Number.isNaN(index)) queueOcr(index);
  });
  if (state.lightboxIndex >= 0) queueOcr(state.lightboxIndex);
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

function renderLightboxOcrOverlay() {
  if (state.translateEnabled || !ocrBoxDebug) return; // 翻译模式/非调试不画红框
  const wrap = document.querySelector<HTMLElement>(".lightbox-image-wrap");
  const img = document.querySelector<HTMLImageElement>(".lightbox-image");
  wrap?.querySelector(".lightbox-ocr-overlay")?.remove();
  if (!wrap || !img || !img.complete || img.naturalWidth === 0) return;

  const regions = state.ocrRegions[state.lightboxIndex];
  if (!regions || regions.length === 0) return;

  const overlay = document.createElement("div");
  overlay.className = "lightbox-ocr-overlay";
  overlay.setAttribute("aria-hidden", "true");
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
  wrap.append(overlay);
}

function removeAllOcrOverlays() {
  document.querySelectorAll<HTMLElement>(".stream-ocr-overlay, .lightbox-ocr-overlay").forEach((el) => {
    el.remove();
  });
}

// 重画当前已加载页面的译文/调试红框(整页模式切换、窗口尺寸变化时对齐会变)
function redrawReaderOverlays() {
  const center = state.lightboxIndex >= 0 ? state.lightboxIndex : currentStreamIndex();
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
  if (state.lightboxIndex >= 0) {
    if (state.translateEnabled && state.translateTexts[state.lightboxIndex]) {
      renderLightboxTranslateOverlay();
    }
    renderLightboxOcrOverlay();
  }
}

function updateReaderProgress() {
  const active = state.view === "reader" && state.lightboxIndex < 0;
  readerProgress.hidden = !active;
  if (!active) {
    readerProgressFill.style.transform = "scaleX(0)";
    readerProgress.removeAttribute("title");
    lastReportedStreamIndex = -1;
    return;
  }
  const maxScroll = Math.max(1, resultGrid.scrollHeight - resultGrid.clientHeight);
  const percent = Math.max(0, Math.min(100, (resultGrid.scrollTop / maxScroll) * 100));
  readerProgressFill.style.transform = `scaleX(${percent / 100})`;

  const total = state.photos.length;
  if (total > 0) {
    const current = currentStreamIndex();
    if (current >= 0) {
      readerProgress.title = `${current + 1} / ${total} · 点击跳转`;
      if (current !== lastReportedStreamIndex) {
        lastReportedStreamIndex = current;
        setSoftStatus(`正在阅读 ${current + 1} / ${total}`);
        queueOcrWindow(current);
        pruneTranslateOverlays(current);
      }
    }
  } else {
    readerProgress.removeAttribute("title");
    lastReportedStreamIndex = -1;
  }
}

let lastReportedStreamIndex = -1;
let streamIndexHint = 0;

function currentStreamIndex() {
  const photos = document.querySelectorAll<HTMLElement>(".stream-photo");
  if (photos.length === 0) return -1;
  // Both resultGrid and the photos currently share .workspace as offsetParent.
  // Anchor to the scroller itself so a wrapping tag bar before the first page
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
  const target = photos[clamped];
  const offset = target.getBoundingClientRect().top - resultGrid.getBoundingClientRect().top;
  resultGrid.scrollTo({ top: resultGrid.scrollTop + offset - 8, behavior });
}

function setFullscreenState(value: boolean) {
  state.fullscreen = value;
  shell.classList.toggle("fullscreen-mode", value);
  fullscreenButton.classList.toggle("active", value);
  setIconWithLabel(fullscreenButton, value ? "minimize" : "maximize", value ? "退出全屏" : "全屏");
  fullscreenButton.title = value ? "退出全屏 (F11)" : "全屏 (F11)";
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

function listContextKey() {
  return [state.mode, state.query, state.category.path].join("\n");
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
  jumpTopButton.hidden = state.lightboxIndex >= 0 || resultGrid.scrollTop < 520;
}

async function fetchAlbums(page: number, contextKey = listContextKey()) {
  const [mode, query, categoryPath] = contextKey.split("\n") as [typeof state.mode, string, string];
  if (mode === "tag") return invokeTauri<Album[]>("search_tag", { tag: query });
  if (mode === "search") return invokeTauri<Album[]>("search_albums", { query, page });
  return invokeTauri<Album[]>("fetch_albums", { path: pagePath(categoryPath, page) });
}

function hydrateImage(img: HTMLImageElement, url: string, _referer?: string | null) {
  const token = `${url}|${_referer ?? ""}`;
  img.dataset.imageToken = token;
  img.classList.remove("image-error");
  img.classList.add("image-loading");
  img.decoding = "async";
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
  state.imageUrls[index] = imageUrl;
  const referer = state.photos[index]?.url;
  try {
    return {
      url: await fetchImageDataUrlWithProgress(imageUrl, referer, requestId, onProgress).then((dataUrl) => {
        ocrByteCacheUrls.add(imageUrl);
        return dataUrl;
      }),
      viaFallback: false,
      imageUrl,
    };
  } catch (error) {
    console.warn("Image proxy failed, falling back to direct URL", error);
    setSoftStatus("图片线路较慢，正在尝试备用显示");
    return { url: imageUrl, viaFallback: true, imageUrl };
  }
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

async function resolvePhotoImageUrlUntilSuccess(
  index: number,
  shouldContinue: () => boolean,
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void,
) {
  let attempt = 0;

  while (shouldContinue()) {
    try {
      return await resolvePhotoImageUrl(index);
    } catch (error) {
      attempt++;
      const delayMs = Math.min(30_000, 2000 * attempt);
      onRetry?.(attempt, error, delayMs);
      await sleep(delayMs);
    }
  }

  throw new Error("图片加载已取消");
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
  } catch {
    for (const title of titles) {
      titleTranslatePending.delete(title);
      titleTranslateFailed.add(title);
    }
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

function toggleTitleTranslate() {
  setTitleTranslate(!titleTranslateEnabled);
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
    readerSettings.hidden = false;
    viewTitle.textContent =
      state.mode === "tag" ? `标签：${state.query}` :
      state.mode === "search" ? `搜索：${state.query || "未输入"}` : state.category.label;
    sidebar.classList.remove("hidden");
    shell.classList.remove("reader-mode");
  }
  syncReaderControls();
  syncPagerBar();
  updateReaderProgress();
  updateListControls();
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

async function triggerTagSearch(tag: string) {
  const trimmed = tag.trim();
  if (!trimmed) return;
  if (shell.classList.contains("standalone-album")) {
    // 子窗口:通知主窗口去搜索,自己保留
    try {
      await invokeTauri<void>("search_tag_in_main", { tag: trimmed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast(`无法在主窗口搜索：${message}`, "error", 3000);
    }
    return;
  }
  // 主窗口:本地直接切到 tag 搜索
  applyTagSearch(trimmed);
}

function applyTagSearch(tag: string) {
  state.mode = "tag";
  state.query = tag;
  state.page = 1;
  searchInput.value = tag;
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
  const index = state.lightboxIndex >= 0 ? state.lightboxIndex : currentStreamIndex();
  if (index >= 0 && index < state.photos.length) {
    if (state.translateFailed[index]) {
      label = "翻译失败 · 点击重试";
      className = "failed";
    } else if (translateBusy(index)) {
      label = "翻译中…";
      className = "working";
    }
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
  if (albums.length > 0 && state.mode !== "tag" && !state.allLoaded) setupInfiniteScroll();
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
  icon.textContent = state.mode === "search" || state.mode === "tag" ? "🔍" : "·";
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
    state.allLoaded = albums.length === 0 || state.mode === "tag";
    state.albums = albums;
    syncToolbar();
    if (albums.length === 0) {
      showEmpty(state.mode === "search" || state.mode === "tag" ? "没有找到匹配结果" : "这一页没有内容");
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
  if (state.mode === "tag") {
    showToast("标签搜索为单页结果", "info");
    return;
  }
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
  if (state.mode === "tag") return; // tag search is single-page
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

    if (albums.length === 0) {
      state.allLoaded = true;
      teardownInfiniteScroll();
      showListEnd();
      setStatus(`共 ${state.page} 页，已全部加载`);
      syncToolbar();
      saveListSnapshot();
      return;
    }

    state.page = page;
    state.albums = [...state.albums, ...albums];
    // Insert albums before the sentinel (keep sentinel at bottom)
    for (let i = 0; i < albums.length; i++) {
      const card = renderAlbumCard(albums[i]);
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
  streamWorkers = 0;
}

function renderReaderGrid(tags = state.tags) {
  teardownReaderObserver();
  streamIndexHint = 0;
  lastReportedStreamIndex = -1;
  resultGrid.className = "reader-stream";
  resultGrid.scrollTop = 0;

  const frag = document.createDocumentFragment();

  if (tags && tags.length > 0) {
    const tagBar = document.createElement("div");
    tagBar.className = "tag-bar";
    for (const tag of tags) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tag-btn";
      btn.textContent = tag.name;
      btn.addEventListener("click", () => {
        triggerTagSearch(tag.name);
      });
      tagBar.append(btn);
    }
    frag.append(tagBar);
  }

  for (let i = 0; i < state.photos.length; i++) {
    const idx = i;

    const container = document.createElement("div");
    container.className = "stream-photo";
    container.dataset.index = String(i);
    container.dataset.state = "";
    container.addEventListener("click", () => openLightbox(idx));
    frag.append(container);

    const label = document.createElement("div");
    label.className = "stream-label";
    label.textContent = `${i + 1} / ${state.photos.length}`;
    frag.append(label);
  }

  resultGrid.replaceChildren(frag);

  setupStreamObserver();
  updateReaderProgress();
}

let streamQueue: HTMLElement[] = [];
let streamWorkers = 0;
const STREAM_CONCURRENCY = 2;

function setupStreamObserver() {
  teardownReaderObserver();
  streamQueue = [];
  streamWorkers = 0;
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
    { root: resultGrid, rootMargin: state.conserveImages ? "120px 0px" : "400px 0px" },
  );

  document.querySelectorAll<HTMLElement>(".stream-photo").forEach((el) => {
    readerObserver!.observe(el);
  });
  // kick off first few visible
  if (streamQueue.length === 0) {
    const first = document.querySelector<HTMLElement>('.stream-photo[data-state=""]');
    if (first) streamQueue.push(first);
  }
  pumpStreamQueue();
}

function pumpStreamQueue() {
  while (streamWorkers < STREAM_CONCURRENCY && streamQueue.length > 0) {
    const container = streamQueue.shift()!;
    if (container.dataset.state !== "") continue;
    streamWorkers++;
    const token = state.readerToken;
    loadStreamImage(container).finally(() => {
      streamWorkers--;
      if (token === state.readerToken && state.view === "reader") {
        pumpStreamQueue();
      }
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
    // shared slot before creating a foreground fallback so only the first
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
        viaFallback: !state.preloadedUrls[index].startsWith("data:"),
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
      // Register the visible fallback in the same map. Scheduled retries,
      // lightbox opens and OCR prefetches now await this download instead of
      // starting a second one on slow connections.
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
    if (image.viaFallback) {
      container.replaceChildren(createProgressIndicator(null, true, "备用线路加载中"));
    } else {
      container.replaceChildren(img);
    }
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
  state.lightboxIndex = -1;
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
    state.tags = detail.tags;
    const resolvedTitle = (detail.title || title || "").trim() || `作品 ${aid}`;
    state.currentAlbum = { aid, title: resolvedTitle };
    applyAlbumTitle(resolvedTitle);
    if (detail.photos.length === 0) {
      showEmpty("这本作品暂时没有图片");
      setStatus("暂无内容");
      return;
    }
    renderReaderGrid(detail.tags);
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
  state.lightboxToken++;
  state.view = "list";
  state.currentAlbum = null;
  resetWindowTitle();
  state.photos = [];
  state.tags = [];
  state.lightboxIndex = -1;
  state.lightboxImageUrl = null;
  state.lightboxZoom = 1;
  state.lightboxPanX = 0;
  state.lightboxPanY = 0;
  state.lightboxPanning = false;
  state.retryNotice = "";
  state.lightboxProgress = null;
  state.preloadedUrls = {};
  state.preloadFailures = {};
  state.ocrRegions = {};
  state.ocrFailed = {};
  state.translateTexts = {};
  state.translateFailed = {};
  state.imageUrls = {};
  document.querySelector(".lightbox")?.remove();
  teardownReaderObserver();
  resultGrid.className = "result-grid";
  syncToolbar();
  if (restore && restoreListSnapshot()) return;
  loadAlbums();
}

// ---- lightbox ----

const preloadPool = document.createElement("div");
preloadPool.className = "preload-pool";
document.body.append(preloadPool);

function preloadImage(url: string) {
  const existing = Array.from(preloadPool.querySelectorAll<HTMLImageElement>("img")).some(
    (img) => img.dataset.src === url,
  );
  if (existing) return;
  const img = document.createElement("img");
  img.dataset.src = url;
  img.src = url;
  preloadPool.append(img);
}

function clampZoom(value: number) {
  return Math.min(5, Math.max(0.1, value));
}

function setLightboxZoom(value: number, originX?: number, originY?: number) {
  const oldZoom = state.lightboxZoom;
  state.lightboxZoom = clampZoom(value);
  if (Math.abs(state.lightboxZoom - 1) < 0.02) {
    state.lightboxPanX = 0;
    state.lightboxPanY = 0;
  } else if (originX !== undefined && originY !== undefined) {
    const scale = state.lightboxZoom / oldZoom;
    state.lightboxPanX = originX - scale * (originX - state.lightboxPanX);
    state.lightboxPanY = originY - scale * (originY - state.lightboxPanY);
  }
  applyLightboxZoomAndPan();
}

function resetLightboxZoom() {
  state.lightboxPanX = 0;
  state.lightboxPanY = 0;
  setLightboxZoom(1);
}

function moveLightboxPan(deltaX: number, deltaY: number) {
  if (Math.abs(state.lightboxZoom - 1) < 0.02) return;
  state.lightboxPanX += deltaX;
  state.lightboxPanY += deltaY;
  applyLightboxZoomAndPan();
}

function clampPan(viewW: number, viewH: number, imgW: number, imgH: number) {
  const maxX = Math.max(0, (imgW * state.lightboxZoom - viewW) / 2);
  const maxY = Math.max(0, (imgH * state.lightboxZoom - viewH) / 2);
  state.lightboxPanX = Math.max(-maxX, Math.min(maxX, state.lightboxPanX));
  state.lightboxPanY = Math.max(-maxY, Math.min(maxY, state.lightboxPanY));
}

function applyLightboxZoomAndPan() {
  const wrap = document.querySelector<HTMLElement>(".lightbox-image-wrap");
  const img = document.querySelector<HTMLImageElement>(".lightbox-image");
  const zoomLabel = document.querySelector<HTMLElement>(".lightbox-zoom");
  if (!wrap || !img) {
    if (zoomLabel) zoomLabel.textContent = "";
    return;
  }

  const zoomed = Math.abs(state.lightboxZoom - 1) > 0.01;
  wrap.classList.toggle("zoomed", zoomed);

  if (zoomed) {
    if (state.lightboxPanning) wrap.classList.add("no-transition");
    else wrap.classList.remove("no-transition");
    const vw = wrap.clientWidth;
    const vh = wrap.clientHeight;
    const nw = img.naturalWidth || img.width || vw || 100;
    const nh = img.naturalHeight || img.height || vh || 100;
    clampPan(vw, vh, nw, nh);
    wrap.style.transform = `translate3d(${state.lightboxPanX}px, ${state.lightboxPanY}px, 0) scale(${state.lightboxZoom})`;
    wrap.style.cursor = state.lightboxZoom < 1 ? "zoom-in" : "grab";
  } else {
    wrap.classList.remove("no-transition");
    wrap.style.transform = "";
    wrap.style.cursor = "zoom-in";
  }
  if (zoomLabel) zoomLabel.textContent = zoomed ? `${Math.round(state.lightboxZoom * 100)}%` : "";
}

function bindLightboxZoomEvents(overlay: HTMLElement) {
  let lastPointerTime = 0;
  let tapMoved = false;
  let swipeNavCooldown = 0;
  overlay.addEventListener("click", (event) => {
    if (Math.abs(state.lightboxZoom - 1) > 0.01) return; // don't close while zoomed
    const target = event.target as HTMLElement;
    if (target.classList.contains("lightbox-image")) return;
    if (target.closest(".lightbox-toolbar") || target.closest(".lightbox-nav")) return;
    closeLightbox();
  });

  overlay.addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("lightbox-image")) return;
    event.preventDefault();
    if (Math.abs(state.lightboxZoom - 1) < 0.02) setLightboxZoom(2.4);
    else resetLightboxZoom();
  });

  overlay.addEventListener(
    "wheel",
    (event) => {
      if (!state.lightboxImageUrl || state.lightboxImageUrl === "__error__") return;
      const now = Date.now();

      // ctrl/meta+wheel → zoom (macOS trackpad pinch gesture)
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const factor = Math.exp(-event.deltaY * 0.005);
        const rect = overlay.getBoundingClientRect();
        const ox = event.clientX - rect.left - rect.width / 2;
        const oy = event.clientY - rect.top - rect.height / 2;
        setLightboxZoom(state.lightboxZoom * factor, ox, oy);
        return;
      }

      // When zoomed → pan
      if (Math.abs(state.lightboxZoom - 1) > 0.01) {
        event.preventDefault();
        moveLightboxPan(-event.deltaX, -event.deltaY);
        return;
      }

      // Normal zoom → navigate on horizontal swipe
      // Only trigger if clearly horizontal (trackpad two-finger swipe)
      const absX = Math.abs(event.deltaX);
      const absY = Math.abs(event.deltaY);
      if (absX > absY * 1.5 && absX > 20 && now > swipeNavCooldown) {
        event.preventDefault();
        navigateLightbox(event.deltaX > 0 ? 1 : -1);
        swipeNavCooldown = now + 600;
      }
    },
    { passive: false },
  );

  overlay.addEventListener("gesturestart", (event) => {
    if (!state.lightboxImageUrl || state.lightboxImageUrl === "__error__") return;
    event.preventDefault();
    state.gestureStartZoom = state.lightboxZoom;
  });

  overlay.addEventListener("gesturechange", (event) => {
    if (!state.lightboxImageUrl || state.lightboxImageUrl === "__error__") return;
    event.preventDefault();
    const scale = (event as GestureEventLike).scale ?? 1;
    setLightboxZoom(state.gestureStartZoom * scale);
  });

  overlay.addEventListener("pointerdown", (event) => {
    if (!state.lightboxImageUrl || state.lightboxImageUrl === "__error__") return;
    tapMoved = false;

    if (Math.abs(state.lightboxZoom - 1) > 0.01) {
      const target = event.target as HTMLElement;
      if (!target.classList.contains("lightbox-image")) return;

      event.preventDefault();
      state.lightboxPanning = true;
      state.lightboxPanStartX = event.clientX;
      state.lightboxPanStartY = event.clientY;
      state.lightboxPanBaseX = state.lightboxPanX;
      state.lightboxPanBaseY = state.lightboxPanY;
      overlay.setPointerCapture(event.pointerId);
      overlay.classList.add("panning");
      return;
    }

    // Track tap for zoom-toggle on the image
    state.lightboxPanStartX = event.clientX;
    state.lightboxPanStartY = event.clientY;
    lastPointerTime = Date.now();
  });

  overlay.addEventListener("pointermove", (event) => {
    if (state.lightboxPanning) {
      event.preventDefault();
      state.lightboxPanX = state.lightboxPanBaseX + event.clientX - state.lightboxPanStartX;
      state.lightboxPanY = state.lightboxPanBaseY + event.clientY - state.lightboxPanStartY;
      applyLightboxZoomAndPan();
      return;
    }
    const dx = Math.abs(event.clientX - state.lightboxPanStartX);
    const dy = Math.abs(event.clientY - state.lightboxPanStartY);
    if (dx > 8 || dy > 8) tapMoved = true;
  });

  const handlePointerUp = (event: PointerEvent) => {
    if (state.lightboxPanning) {
      state.lightboxPanning = false;
      if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
      overlay.classList.remove("panning");
      return;
    }

    // Tap on image at normal zoom → toggle zoom to 2x
    if (!tapMoved && Date.now() - lastPointerTime < 300) {
      const target = event.target as HTMLElement;
      if (target.classList.contains("lightbox-image")) {
        if (Math.abs(state.lightboxZoom - 1) < 0.02) {
          setLightboxZoom(2);
        } else {
          resetLightboxZoom();
        }
      }
    }
  };
  overlay.addEventListener("pointerup", handlePointerUp);
  overlay.addEventListener("pointercancel", handlePointerUp);
}

async function openLightbox(index: number) {
  if (index < 0 || index >= state.photos.length) return;
  const token = ++state.lightboxToken;
  state.lightboxIndex = index;
  state.lightboxImageUrl = null;
  state.lightboxProgress = null;
  state.retryNotice = "";
  renderLightbox();
  queueOcrWindow(index);
  updateTranslateBadges();

  const pendingPreload = preloadInFlight.get(index);
  if (!state.preloadedUrls[index] && pendingPreload) await pendingPreload;
  if (token !== state.lightboxToken || state.lightboxIndex !== index) return;
  // use preloaded URL if available
  if (state.preloadedUrls[index]) {
    state.lightboxImageUrl = state.preloadedUrls[index];
    state.lightboxProgress = null;
    renderLightbox();
    preloadNeighbors(index);
    return;
  }

  await loadCurrentPhoto(index, token);
}

async function loadCurrentPhoto(index: number, token = ++state.lightboxToken) {
  state.lightboxImageUrl = null;
  state.lightboxProgress = null;
  state.retryNotice = "";
  renderLightbox();

  // A stream fallback may have claimed the shared slot immediately after the
  // original preload failed. Await it before creating a lightbox fallback.
  while (!state.preloadedUrls[index]) {
    const competingLoad = preloadInFlight.get(index);
    if (!competingLoad) break;
    await competingLoad;
    if (token !== state.lightboxToken || state.lightboxIndex !== index) return;
  }
  const sharedUrl = state.preloadedUrls[index];
  if (sharedUrl) {
    state.lightboxImageUrl = sharedUrl;
    state.lightboxProgress = null;
    state.retryNotice = "";
    renderLightbox();
    preloadNeighbors(index);
    return;
  }

  let imageUrl: string | null = null;
  let loadFailed = false;
  let lightboxTask!: Promise<PreloadResult>;
  lightboxTask = (async () => {
    try {
      const rawImageUrl = await resolvePhotoImageUrlUntilSuccess(
        index,
        () => token === state.lightboxToken && state.lightboxIndex === index,
        (attempt, error, delayMs) => {
          if (token !== state.lightboxToken || state.lightboxIndex !== index) return;
          const message = error instanceof Error ? error.message : String(error);
          state.retryNotice = `加载失败，自动重试第 ${attempt} 次，${Math.ceil(delayMs / 1000)} 秒后继续`;
          renderLightbox();
          setStatus(`${state.retryNotice}: ${message}`);
        },
      );
      state.imageUrls[index] = rawImageUrl;
      if (token !== state.lightboxToken || state.lightboxIndex !== index) return "failed";
      const requestId = `lightbox-${token}-${index}-${Date.now()}`;
      try {
        imageUrl = await fetchImageDataUrlWithProgress(
          rawImageUrl,
          state.photos[index]?.url,
          requestId,
          (progress) => {
            if (token !== state.lightboxToken || state.lightboxIndex !== index) return;
            state.lightboxProgress = progress;
            renderLightbox();
          },
        );
        ocrByteCacheUrls.add(rawImageUrl);
      } catch (error) {
        console.warn("Image proxy failed, falling back to direct URL", error);
        setSoftStatus("图片线路较慢，正在尝试备用显示");
        imageUrl = rawImageUrl;
      }
      if (token !== state.lightboxToken || state.lightboxIndex !== index || !imageUrl) return "failed";
      state.preloadedUrls[index] = imageUrl;
      delete state.preloadFailures[index];
      return "loaded";
    } catch {
      loadFailed = true;
      return "failed";
    } finally {
      if (preloadInFlight.get(index) === lightboxTask) preloadInFlight.delete(index);
    }
  })();
  // The lightbox is a full-image consumer too. Register it so background
  // retries and the stream reader share this exact request on slow networks.
  preloadInFlight.set(index, lightboxTask);
  await lightboxTask;

  if (loadFailed || !imageUrl) {
    if (token === state.lightboxToken && state.lightboxIndex === index) {
      state.lightboxProgress = null;
      state.lightboxImageUrl = "__error__";
      renderLightbox();
      setStatus("图片加载失败");
    }
    return;
  }

  if (token !== state.lightboxToken || state.lightboxIndex !== index) return;
  state.lightboxImageUrl = imageUrl;
  state.retryNotice = "";
  state.lightboxProgress = null;
  if (!state.conserveImages) preloadImage(imageUrl);
  renderLightbox();
  preloadNeighbors(index);
  setStatus("");
}

function preloadNeighbors(index: number) {
  if (state.conserveImages) return;
  for (const offset of [-1, 1]) {
    const ni = index + offset;
    if (ni >= 0 && ni < state.photos.length && !state.preloadedUrls[ni]) {
      preloadFullImage(ni);
    }
  }
}

function closeLightbox() {
  if (lightboxIdleTimer !== null) {
    window.clearTimeout(lightboxIdleTimer);
    lightboxIdleTimer = null;
  }
  lightboxChromeForced = false;
  const overlay = document.querySelector(".lightbox");
  if (overlay) {
    overlay.classList.add("closing");
    // Immediately mark as closed so keyboard/other handlers don't act
    state.lightboxToken++;
    state.lightboxIndex = -1;
    state.lightboxImageUrl = null;
    state.lightboxZoom = 1;
    state.lightboxPanX = 0;
    state.lightboxPanY = 0;
    state.retryNotice = "";
    state.lightboxProgress = null;
    // Wait for close animation to finish, then remove from DOM
    overlay.addEventListener("animationend", (e: Event) => {
      if ((e as AnimationEvent).animationName === "lightboxClose") renderLightbox();
    }, { once: true });
    return;
  }
  state.lightboxToken++;
  state.lightboxIndex = -1;
  state.lightboxImageUrl = null;
  state.lightboxZoom = 1;
  state.lightboxPanX = 0;
  state.lightboxPanY = 0;
  state.retryNotice = "";
  state.lightboxProgress = null;
  renderLightbox();
}

function navigateLightbox(delta: number) {
  const newIndex = state.lightboxIndex + delta;
  if (newIndex >= 0 && newIndex < state.photos.length) {
    openLightbox(newIndex);
  }
}

function bindLightboxImageLoad(img: HTMLImageElement) {
  img.addEventListener("load", () => {
    const index = state.lightboxIndex;
    applyLightboxZoomAndPan();
    if (state.ocrEnabled) {
      if (state.translateEnabled) queueOcrWindow(index);
      else {
        queueOcr(index);
        queueOcr(index - 1);
        queueOcr(index + 1);
      }
    }
    if (state.translateEnabled) {
      queueTranslate(index);
    }
    window.requestAnimationFrame(() => {
      if (index !== state.lightboxIndex) return;
      renderLightboxOcrOverlay();
      if (state.translateEnabled && state.translateTexts[index]) renderLightboxTranslateOverlay();
    });
  }, { once: true });
}

function renderLightbox() {
  const existing = document.querySelector(".lightbox");
  if (state.lightboxIndex === -1) {
    existing?.remove();
    return;
  }

  const total = state.photos.length;
  const photo = state.photos[state.lightboxIndex];
  const label = photo?.title || `#${state.lightboxIndex + 1}`;
  const thumb = photo?.thumbnail || "";
  const isError = state.lightboxImageUrl === "__error__";
  if (existing) {
    const imgWrap = existing.querySelector(".lightbox-image-wrap")!;
    imgWrap.scrollTop = 0;
    const counter = existing.querySelector(".lightbox-counter")!;
    const titleEl = existing.querySelector(".lightbox-title")!;
    const prevBtn = existing.querySelector<HTMLButtonElement>(".lightbox-nav.prev");
    const nextBtn = existing.querySelector<HTMLButtonElement>(".lightbox-nav.next");
    counter.textContent = `${state.lightboxIndex + 1} / ${total}`;
    titleEl.textContent = label;
    if (prevBtn) prevBtn.disabled = state.lightboxIndex <= 0;
    if (nextBtn) nextBtn.disabled = state.lightboxIndex >= total - 1;

    if (isError) {
      imgWrap.innerHTML = `<div class="lightbox-error">
        <p>图片加载失败</p>
        <button class="lightbox-retry" type="button">重试</button>
      </div>`;
      imgWrap.querySelector(".lightbox-retry")!.addEventListener("click", () => loadCurrentPhoto(state.lightboxIndex));
    } else if (state.lightboxImageUrl) {
      const img = document.createElement("img");
      img.className = "lightbox-image";
      img.alt = label;
      img.src = state.lightboxImageUrl;
      img.draggable = false;
      bindLightboxImageLoad(img);
      img.addEventListener("error", () => {
        state.lightboxImageUrl = "__error__";
        renderLightbox();
      }, { once: true });
      imgWrap.replaceChildren(img);
    } else {
      // Show thumbnail as blur background while loading
      const loading = document.createElement("div");
      loading.className = "lightbox-loading";
      if (thumb) {
        const bg = document.createElement("img");
        bg.className = "lightbox-bg";
        bg.alt = "";
        bg.src = thumb;
        bg.draggable = false;
        loading.append(bg);
      }
      const spinner = document.createElement("div");
      spinner.className = "lightbox-spinner";
      loading.append(spinner);
      loading.append(createProgressIndicator(state.lightboxProgress));
      const text = document.createElement("p");
      text.textContent = state.retryNotice || "加载中";
      loading.append(text);
      imgWrap.replaceChildren(loading);
    }
    applyLightboxZoomAndPan();
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "lightbox";

  const imgWrap = document.createElement("div");
  imgWrap.className = "lightbox-image-wrap";
  if (isError) {
    imgWrap.innerHTML = `<div class="lightbox-error">
      <p>图片加载失败</p>
      <button class="lightbox-retry" type="button">重试</button>
    </div>`;
  } else if (state.lightboxImageUrl) {
    const img = document.createElement("img");
    img.className = "lightbox-image";
    img.alt = label;
    img.src = state.lightboxImageUrl;
    img.draggable = false;
    bindLightboxImageLoad(img);
    img.addEventListener("error", () => {
      state.lightboxImageUrl = "__error__";
      renderLightbox();
    }, { once: true });
    imgWrap.replaceChildren(img);
  } else {
    const loading = document.createElement("div");
    loading.className = "lightbox-loading";
    if (thumb) {
      const bg = document.createElement("img");
      bg.className = "lightbox-bg";
      bg.alt = "";
      bg.src = thumb;
      bg.draggable = false;
      loading.append(bg);
    }
    const spinner = document.createElement("div");
    spinner.className = "lightbox-spinner";
    loading.append(spinner);
    loading.append(createProgressIndicator(state.lightboxProgress));
    const text = document.createElement("p");
    text.textContent = state.retryNotice || "加载中";
    loading.append(text);
    imgWrap.replaceChildren(loading);
  }

  // bind retry button in initial render
  if (isError) {
    imgWrap.querySelector(".lightbox-retry")!.addEventListener("click", () => loadCurrentPhoto(state.lightboxIndex));
  }

  const toolbar = document.createElement("div");
  toolbar.className = "lightbox-toolbar";

  const titleEl = document.createElement("span");
  titleEl.className = "lightbox-title";
  titleEl.textContent = label;

  const counter = document.createElement("span");
  counter.className = "lightbox-counter";
  counter.textContent = `${state.lightboxIndex + 1} / ${total}`;

  const zoom = document.createElement("span");
  zoom.className = "lightbox-zoom";
  zoom.textContent = state.lightboxImageUrl && !isError ? `${Math.round(state.lightboxZoom * 100)}%` : "";

  const controls = document.createElement("div");
  controls.className = "lightbox-controls";
  const zoomOut = document.createElement("button");
  zoomOut.type = "button";
  zoomOut.append(icon("minus", 16));
  zoomOut.title = "缩小";
  zoomOut.setAttribute("aria-label", "缩小");
  zoomOut.addEventListener("click", (event) => {
    event.stopPropagation();
    setLightboxZoom(state.lightboxZoom / 1.2);
  });
  const zoomReset = document.createElement("button");
  zoomReset.type = "button";
  zoomReset.append(icon("resetZoom", 16));
  zoomReset.title = "重置缩放 (0)";
  zoomReset.setAttribute("aria-label", "重置缩放");
  zoomReset.addEventListener("click", (event) => {
    event.stopPropagation();
    resetLightboxZoom();
  });
  const zoomIn = document.createElement("button");
  zoomIn.type = "button";
  zoomIn.append(icon("plus", 16));
  zoomIn.title = "放大";
  zoomIn.setAttribute("aria-label", "放大");
  zoomIn.addEventListener("click", (event) => {
    event.stopPropagation();
    setLightboxZoom(state.lightboxZoom * 1.2);
  });
  controls.append(zoomOut, zoomReset, zoomIn);

  toolbar.append(titleEl, counter, controls, zoom);

  const closeBtn = document.createElement("button");
  closeBtn.className = "lightbox-close";
  closeBtn.append(icon("x", 18));
  closeBtn.title = "关闭 (Esc)";
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.addEventListener("click", closeLightbox);

  const prevBtn = document.createElement("button");
  prevBtn.className = "lightbox-nav prev";
  prevBtn.append(icon("chevronLeft", 22));
  prevBtn.title = "上一张";
  prevBtn.setAttribute("aria-label", "上一张");
  prevBtn.disabled = state.lightboxIndex <= 0;
  prevBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    navigateLightbox(-1);
  });

  const nextBtn = document.createElement("button");
  nextBtn.className = "lightbox-nav next";
  nextBtn.append(icon("chevronRight", 22));
  nextBtn.title = "下一张";
  nextBtn.setAttribute("aria-label", "下一张");
  nextBtn.disabled = state.lightboxIndex >= total - 1;
  nextBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    navigateLightbox(1);
  });

  bindLightboxZoomEvents(overlay);

  overlay.append(imgWrap, toolbar, closeBtn, prevBtn, nextBtn);
  document.body.append(overlay);
  applyLightboxZoomAndPan();
  bindLightboxIdleAutoHide(overlay);
  maybeShowLightboxHint(overlay);
}

let lightboxChromeForced = false;
let lightboxIdleTimer: number | null = null;

function wakeLightboxChrome() {
  const overlay = document.querySelector<HTMLElement>(".lightbox");
  if (!overlay) return;
  overlay.classList.remove("chrome-hidden");
  if (lightboxIdleTimer !== null) {
    window.clearTimeout(lightboxIdleTimer);
    lightboxIdleTimer = null;
  }
  if (lightboxChromeForced) return;
  lightboxIdleTimer = window.setTimeout(() => {
    overlay.classList.add("chrome-hidden");
    lightboxIdleTimer = null;
  }, 1800);
}

function bindLightboxIdleAutoHide(overlay: HTMLElement) {
  overlay.addEventListener("pointermove", wakeLightboxChrome);
  overlay.addEventListener("pointerdown", wakeLightboxChrome);
  overlay.addEventListener("wheel", wakeLightboxChrome, { passive: true });
  overlay.dataset.idleBound = "1";
  wakeLightboxChrome();
}

const lightboxHintKey = "wnacg.lightboxHintShown.v1";

function maybeShowLightboxHint(overlay: HTMLElement) {
  try {
    if (localStorage.getItem(lightboxHintKey)) return;
    localStorage.setItem(lightboxHintKey, "1");
  } catch {
    return;
  }
  const hint = document.createElement("div");
  hint.className = "lightbox-hint";
  hint.innerHTML =
    '<strong>快捷键</strong>' +
    '<span>← / → 翻页 · Home / End 首末 · 双击或 +/− 缩放 · 0 复位 · F 锁定工具栏 · Esc 关闭</span>';
  overlay.append(hint);
  window.setTimeout(() => hint.classList.add("fade-out"), 4200);
  window.setTimeout(() => hint.remove(), 4900);
}

// ---- keyboard ----

document.addEventListener("keydown", (e) => {
  if (e.key === "F11") {
    e.preventDefault();
    toggleFullscreen();
    return;
  }

  // 调试用隐藏快捷键:Cmd/Ctrl+Shift+O 实时开关 OCR 文字框,无需重启
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") {
    e.preventDefault();
    setOcrBoxDebug(!ocrBoxDebug);
    showToast(ocrBoxDebug ? "调试：显示 OCR 文字框" : "调试：隐藏 OCR 文字框", "info", 2200);
    return;
  }

  if (e.key === " " && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
    e.preventDefault();
    if (state.lightboxIndex >= 0) {
      if (e.shiftKey) navigateLightbox(-1);
      else navigateLightbox(1);
      return;
    }
    const scrollTarget = resultGrid;
    const delta = scrollTarget.clientHeight * 0.85;
    scrollTarget.scrollBy({ top: e.shiftKey ? -delta : delta, behavior: "smooth" });
    return;
  }

  if (state.lightboxIndex >= 0) {
    wakeLightboxChrome();
    if (e.key.toLowerCase() === "f") {
      e.preventDefault();
      lightboxChromeForced = !lightboxChromeForced;
      const overlay = document.querySelector(".lightbox");
      if (lightboxChromeForced) {
        overlay?.classList.remove("chrome-hidden");
        if (lightboxIdleTimer !== null) {
          window.clearTimeout(lightboxIdleTimer);
          lightboxIdleTimer = null;
        }
      } else {
        wakeLightboxChrome();
      }
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
    if (e.key === "Escape" || e.key.toLowerCase() === "x") {
      closeLightbox();
    } else if (e.key === "ArrowLeft") {
      navigateLightbox(-1);
    } else if (e.key === "ArrowRight") {
      navigateLightbox(1);
    } else if (e.key === "Home") {
      e.preventDefault();
      if (state.lightboxIndex !== 0) openLightbox(0);
    } else if (e.key === "End") {
      e.preventDefault();
      const last = state.photos.length - 1;
      if (last >= 0 && state.lightboxIndex !== last) openLightbox(last);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveLightboxPan(0, 80);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveLightboxPan(0, -80);
    } else if ((e.key === "+" || e.key === "=") && state.lightboxImageUrl && state.lightboxImageUrl !== "__error__") {
      setLightboxZoom(state.lightboxZoom * 1.2);
    } else if (e.key === "-" && state.lightboxImageUrl && state.lightboxImageUrl !== "__error__") {
      setLightboxZoom(state.lightboxZoom / 1.2);
    } else if (e.key === "0" && state.lightboxImageUrl && state.lightboxImageUrl !== "__error__") {
      resetLightboxZoom();
    }
    return;
  }

  if (state.view === "reader" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
    if (e.key.toLowerCase() === "w") {
      cycleReaderWidth();
      return;
    }
    if (e.key.toLowerCase() === "g") {
      toggleReaderGap();
      return;
    }
    if (e.key.toLowerCase() === "t") {
      toggleReaderTheme();
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
      if (lower === "j" || key === "PageDown") {
        e.preventDefault();
        scrollToStreamIndex(currentStreamIndex() + 1);
        return;
      }
      if (lower === "k" || key === "PageUp") {
        e.preventDefault();
        scrollToStreamIndex(currentStreamIndex() - 1);
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
    && e.key.toLowerCase() === "x"
    && !(e.target instanceof HTMLInputElement)
    && !(e.target instanceof HTMLTextAreaElement)
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
  resultGrid.scrollTo({ top: 0, behavior: "smooth" });
});

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
  if (state.view !== "list" || state.mode === "tag" || state.allLoaded || state.loadMoreError) return;

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

loadTitleTranslateState();
syncTitleTranslateToggle();
document.querySelector<HTMLInputElement>("#title-translate-toggle")
  ?.addEventListener("change", toggleTitleTranslate);

// 跨窗口同步阅读偏好(主题/版心等)
listen<Partial<ReaderPrefs>>("reader-prefs-changed", (event) => {
  const payload = event.payload || {};
  let dirty = false;
  let ocrLangChanged = false;
  let ocrBoxesChanged = false;
  if (payload.theme && payload.theme !== state.readerTheme) {
    state.readerTheme = payload.theme;
    dirty = true;
  }
  if (payload.width && payload.width !== state.readerWidth) {
    state.readerWidth = payload.width;
    dirty = true;
  }
  if (payload.gap && payload.gap !== state.readerGap) {
    state.readerGap = payload.gap;
    dirty = true;
  }
  if (typeof payload.conserveImages === "boolean" && payload.conserveImages !== state.conserveImages) {
    state.conserveImages = payload.conserveImages;
    dirty = true;
  }
  if (typeof payload.ocrBoxes === "boolean" && payload.ocrBoxes !== state.ocrEnabled) {
    state.ocrEnabled = payload.ocrBoxes;
    ocrEnableToken++; // 其它窗口改了 OCR 开关,同样作废进行中的“开启”请求
    ocrBoxesChanged = true;
    dirty = true;
  }
  if ((payload.fit === "page" || payload.fit === "width") && payload.fit !== state.readerFit) {
    state.readerFit = payload.fit;
    dirty = true;
  }
  if ((payload.ocrLang === "zh" || payload.ocrLang === "ja") && payload.ocrLang !== state.ocrLang) {
    state.ocrLang = payload.ocrLang;
    ocrLangChanged = true;
    dirty = true;
  }
  if (dirty) {
    if (ocrBoxesChanged || ocrLangChanged) resetReaderPipelines();
    applyReaderPrefs();
    syncReaderControls();
    redrawReaderOverlays();
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
  }
}).catch((err) => console.error("listen(reader-prefs-changed) failed:", err));

window.addEventListener("resize", () => {
  if (state.ocrEnabled && state.lightboxIndex >= 0) {
    renderLightboxOcrOverlay();
  }
  redrawReaderOverlays();
});

const initialAid = getInitialAlbumFromHash();
if (initialAid) {
  // 新窗口模式:隐藏 sidebar、跳过列表加载,直接进 reader
  shell.classList.add("standalone-album");
  loadAlbumReader(initialAid, "");
} else {
  loadAlbums();
  // 主窗口:监听子窗口发来的标签搜索请求
  listen<string>("search-tag", (event) => {
    const tag = typeof event.payload === "string" ? event.payload : String(event.payload ?? "");
    if (!tag.trim()) return;
    applyTagSearch(tag.trim());
  }).catch((err) => console.error("listen(search-tag) failed:", err));
}
