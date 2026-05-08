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

type ReaderWidth = "comfort" | "wide" | "edge";
type ReaderGap = "relaxed" | "compact";
type ReaderTheme = "warm" | "dark";

type ReaderPrefs = {
  width: ReaderWidth;
  gap: ReaderGap;
  theme: ReaderTheme;
  conserveImages: boolean;
};

const readerPrefKey = "wnacg.readerPrefs.v1";

const defaultReaderPrefs: ReaderPrefs = {
  width: "comfort",
  gap: "relaxed",
  theme: "dark",
  conserveImages: true,
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
    };
  } catch {
    return { ...defaultReaderPrefs };
  }
}

const readerPrefs = loadReaderPrefs();

const categories: Category[] = [
  { label: "更新", path: "/albums-index-page-{page}.html" },
  { label: "同人志 汉化", path: "/albums-index-page-{page}-cate-1.html" },
  { label: "单行本 汉化", path: "/albums-index-page-{page}-cate-9.html" },
  { label: "短篇 汉化", path: "/albums-index-page-{page}-cate-10.html" },
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
  conserveImages: readerPrefs.conserveImages,
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
    conserveImages: state.conserveImages,
  };
  localStorage.setItem(readerPrefKey, JSON.stringify(prefs));
}

function applyReaderPrefs() {
  shell.dataset.readerWidth = state.readerWidth;
  shell.dataset.readerGap = state.readerGap;
  shell.dataset.readerTheme = state.readerTheme;
  shell.classList.toggle("reader-low-data", state.conserveImages);
}

function syncReaderControls() {
  readerSettings.hidden = false;
  if (readerSettingsOpen) buildReaderSettingsPanel();
}

function updateReaderPrefs(next: Partial<ReaderPrefs>) {
  const previousConserve = state.conserveImages;
  Object.assign(state, {
    readerWidth: next.width ?? state.readerWidth,
    readerGap: next.gap ?? state.readerGap,
    readerTheme: next.theme ?? state.readerTheme,
    conserveImages: next.conserveImages ?? state.conserveImages,
  });
  saveReaderPrefs();
  applyReaderPrefs();
  syncReaderControls();
  // 广播给其它窗口同步主题
  emit("reader-prefs-changed", {
    width: state.readerWidth,
    gap: state.readerGap,
    theme: state.readerTheme,
    conserveImages: state.conserveImages,
  }).catch(() => {});

  if (state.view === "reader" && previousConserve !== state.conserveImages) {
    setupStreamObserver();
  }
  if (!state.conserveImages && state.lightboxIndex >= 0) {
    preloadNeighbors(state.lightboxIndex);
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

function toggleReaderPreload() {
  updateReaderPrefs({ conserveImages: !state.conserveImages });
}

function updateReaderProgress() {
  const active = state.view === "reader" && state.lightboxIndex < 0;
  readerProgress.hidden = !active;
  if (!active) {
    readerProgressFill.style.width = "0%";
    readerProgress.removeAttribute("title");
    lastReportedStreamIndex = -1;
    return;
  }
  const maxScroll = Math.max(1, resultGrid.scrollHeight - resultGrid.clientHeight);
  const percent = Math.max(0, Math.min(100, (resultGrid.scrollTop / maxScroll) * 100));
  readerProgressFill.style.width = `${percent}%`;

  const total = state.photos.length;
  if (total > 0) {
    const current = currentStreamIndex();
    if (current >= 0) {
      readerProgress.title = `${current + 1} / ${total} · 点击跳转`;
      if (current !== lastReportedStreamIndex) {
        lastReportedStreamIndex = current;
        setSoftStatus(`正在阅读 ${current + 1} / ${total}`);
      }
    }
  } else {
    readerProgress.removeAttribute("title");
    lastReportedStreamIndex = -1;
  }
}

let lastReportedStreamIndex = -1;

function currentStreamIndex() {
  const photos = document.querySelectorAll<HTMLElement>(".stream-photo");
  if (photos.length === 0) return -1;
  const probe = resultGrid.getBoundingClientRect().top + resultGrid.clientHeight * 0.35;
  for (let i = 0; i < photos.length; i++) {
    const rect = photos[i].getBoundingClientRect();
    if (rect.bottom >= probe) return i;
  }
  return photos.length - 1;
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
  const referer = state.photos[index]?.url;
  try {
    return {
      url: await fetchImageDataUrlWithProgress(imageUrl, referer, requestId, onProgress),
      viaFallback: false,
    };
  } catch (error) {
    console.warn("Image proxy failed, falling back to direct URL", error);
    setSoftStatus("图片线路较慢，正在尝试备用显示");
    return { url: imageUrl, viaFallback: true };
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

  try {
    const imageUrl = await resolvePhotoImageUrlWithRetry(index, 2);
    if (readerToken !== state.readerToken || state.view !== "reader") return "failed";
    const image = await invokeTauri<ImageData>("fetch_image_data_url", {
      url: imageUrl,
      referer: state.photos[index]?.url ?? null,
    });
    if (readerToken !== state.readerToken || state.view !== "reader") return "failed";
    state.preloadedUrls[index] = image.dataUrl;
    delete state.preloadFailures[index];
    preloadImage(image.dataUrl);
    return "loaded";
  } catch {
    if (readerToken !== state.readerToken || state.view !== "reader") return "failed";
    state.preloadFailures[index] = (state.preloadFailures[index] ?? 0) + 1;
    if (state.preloadFailures[index] > 3) return "failed";
    const nextDelay = Math.min(30_000, state.preloadFailures[index] * 5_000);
    window.setTimeout(() => {
      if (readerToken === state.readerToken && state.view === "reader" && !state.preloadedUrls[index]) {
        preloadFullImage(index, readerToken);
      }
    }, nextDelay);
    return "failed";
  }
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
  const title = String(album.title ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return title || `AID ${album.aid}`;
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
    backButton.title = standalone ? "关闭窗口 (Esc)" : "返回 (Esc)";
    backButton.setAttribute("aria-label", standalone ? "关闭窗口" : "返回列表");
    pagerControls.hidden = false;
    refreshButton.hidden = true;
    fullscreenButton.hidden = false;
    readerSettings.hidden = false;
    viewTitle.textContent = state.currentAlbum?.title ?? "阅读";
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

async function applyAlbumTitle(title: string) {
  const trimmed = title.trim();
  if (!trimmed) return;
  // 同步刷新 view-title（如果当前在 reader 视图）
  if (state.view === "reader") {
    viewTitle.textContent = trimmed;
  }
  document.title = `${trimmed} · wnacg`;
  try {
    await invokeTauri<void>("set_window_title", { title: `${trimmed} · wnacg` });
  } catch {
    // 主窗口失败可忽略,前端 document.title 已经更新
  }
}

function resetWindowTitle() {
  document.title = APP_TITLE;
  invokeTauri<void>("set_window_title", { title: APP_TITLE }).catch(() => {});
}

function renderAlbumCard(album: Album): HTMLElement {
  const card = document.createElement("article");
  card.className = "album-card";
  card.tabIndex = 0;
  card.setAttribute("role", "button");

  const titleText = displayTitle(album);
  const subtitleText = albumSubtitle(album);
  card.dataset.title = titleText;
  card.dataset.subtitle = subtitleText;
  card.setAttribute("aria-label", `打开《${titleText}》`);
  card.title = `${titleText}\n点击在新窗口打开`;
  card.addEventListener("click", () => {
    openAlbumInNewWindow(album.aid, titleText);
  });
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openAlbumInNewWindow(album.aid, titleText);
    }
  });

  const cover = document.createElement("div");
  cover.className = "cover";
  cover.dataset.title = titleText;
  cover.dataset.subtitle = subtitleText;
  if (album.cover) {
    const img = document.createElement("img");
    img.alt = "";
    hydrateImage(img, album.cover, album.url);
    img.loading = "lazy";
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
      resultGrid.scrollTop = 0;
      saveListSnapshot();
    }
    setStatus(`第 ${state.page} 页 · 共 ${albums.length} 项`);
  } catch (error) {
    if (token !== state.listToken || state.view !== "list" || contextKey !== listContextKey()) return;
    const message = error instanceof Error ? error.message : String(error);
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
    const requestId = `stream-${token}-${index}-${Date.now()}`;
    const image = await loadDisplayImageDataUrl(index, requestId, (progress) => {
      if (token !== state.readerToken || container.dataset.state !== "loading") return;
      container.replaceChildren(createProgressIndicator(progress, true));
    });
    if (token !== state.readerToken || container.dataset.state !== "loading") return;

    const img = document.createElement("img");
    img.className = "stream-img";
    img.alt = state.photos[index]?.title || `#${index + 1}`;
    img.addEventListener("load", () => {
      if (token !== state.readerToken) return;
      container.dataset.state = "loaded";
      container.replaceChildren(img);
      setSoftStatus(`已加载 ${index + 1} / ${state.photos.length}`);
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
  state.preloadFailures = {};
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

  let imageUrl: string;
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
    if (token !== state.lightboxToken || state.lightboxIndex !== index) return;
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
    } catch (error) {
      console.warn("Image proxy failed, falling back to direct URL", error);
      setSoftStatus("图片线路较慢，正在尝试备用显示");
      imageUrl = rawImageUrl;
    }
  } catch {
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
  state.preloadedUrls[index] = imageUrl;
  delete state.preloadFailures[index];
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
      img.addEventListener("load", applyLightboxZoomAndPan, { once: true });
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
    img.addEventListener("load", applyLightboxZoomAndPan, { once: true });
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
    if (e.key === "Escape") {
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
    if (e.key.toLowerCase() === "p") {
      toggleReaderPreload();
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
backButton.title = "返回 (Esc)";

jumpTopButton.addEventListener("click", () => {
  resultGrid.scrollTo({ top: 0, behavior: "smooth" });
});

resultGrid.addEventListener(
  "scroll",
  () => {
    updateJumpTopButton();
    updateReaderProgress();
    const snapshot = state.listSnapshots[listContextKey()];
    if (state.view === "list" && snapshot) {
      snapshot.scrollTop = resultGrid.scrollTop;
    }
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

// 跨窗口同步阅读偏好(主题/版心等)
listen<Partial<ReaderPrefs>>("reader-prefs-changed", (event) => {
  const payload = event.payload || {};
  let dirty = false;
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
  if (dirty) {
    applyReaderPrefs();
    syncReaderControls();
  }
}).catch((err) => console.error("listen(reader-prefs-changed) failed:", err));

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
