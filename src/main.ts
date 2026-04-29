import { invoke } from "@tauri-apps/api/core";

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

type Tag = {
  name: string;
  path: string;
};

type AlbumDetail = {
  photos: PhotoEntry[];
  tags: Tag[];
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
  readerMode: "stream" as "grid" | "stream",
  lightboxIndex: -1,
  lightboxImageUrl: null as string | null,
  preloadedUrls: {} as Record<number, string>, // index -> full image URL
  preloading: false,
  preloadTotal: 0,
  preloadDone: 0,
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
};

// DOM refs
const shell = document.querySelector<HTMLElement>(".shell")!;
const sidebar = document.querySelector<HTMLElement>(".sidebar")!;
const workspace = document.querySelector<HTMLElement>(".workspace")!;
const categoryList = document.querySelector<HTMLElement>("#category-list")!;
const resultGrid = document.querySelector<HTMLElement>("#result-grid")!;
const searchForm = document.querySelector<HTMLFormElement>("#search-form")!;
const searchInput = document.querySelector<HTMLInputElement>("#search-input")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh")!;
const viewTitle = document.querySelector<HTMLElement>("#view-title")!;
const statusLabel = document.querySelector<HTMLElement>("#status-label")!;
const backButton = document.querySelector<HTMLButtonElement>("#back-to-list")!;
const pagerControls = document.querySelector<HTMLElement>("#pager-controls")!;

const readerModeBtn = document.createElement("button");
readerModeBtn.type = "button";
readerModeBtn.className = "reader-mode-toggle";
readerModeBtn.hidden = true;
readerModeBtn.addEventListener("click", () => toggleReaderMode());
pagerControls.append(readerModeBtn);

const jumpTopButton = document.createElement("button");
jumpTopButton.type = "button";
jumpTopButton.className = "jump-top";
jumpTopButton.textContent = "↑";
jumpTopButton.title = "回到顶部";
jumpTopButton.hidden = true;
workspace.append(jumpTopButton);


// ---- helpers ----

function setStatus(message: string) {
  statusLabel.textContent = message;
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
    state.preloadedUrls[index] = imageUrl;
    delete state.preloadFailures[index];
    preloadImage(imageUrl);
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
  setStatus(snapshot.status || `已恢复 ${state.albums.length} 条，第 ${state.page} 页`);
  requestAnimationFrame(() => {
    resultGrid.scrollTop = snapshot.scrollTop;
    updateJumpTopButton();
  });
  return true;
}

// ---- toolbar sync ----

function syncToolbar() {
  if (state.view === "reader") {
    backButton.hidden = false;
    pagerControls.hidden = true;
    readerModeBtn.hidden = false;
    readerModeBtn.textContent = state.readerMode === "stream" ? "网格" : "一图流";
    viewTitle.textContent = state.currentAlbum?.title ?? "阅读";
    sidebar.classList.add("hidden");
    shell.classList.add("reader-mode");
  } else {
    backButton.hidden = true;
    pagerControls.hidden = false;
    readerModeBtn.hidden = true;
    viewTitle.textContent =
      state.mode === "tag" ? `标签：${state.query}` :
      state.mode === "search" ? `搜索：${state.query || "未输入"}` : state.category.label;
    sidebar.classList.remove("hidden");
    shell.classList.remove("reader-mode");
  }
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

function renderAlbumCard(album: Album): HTMLElement {
  const card = document.createElement("article");
  card.className = "album-card";

  const enterReader = () => loadAlbumReader(album.aid, album.title);
  const titleText = displayTitle(album);
  const subtitleText = albumSubtitle(album);
  card.dataset.title = titleText;
  card.dataset.subtitle = subtitleText;

  const cover = document.createElement("div");
  cover.className = "cover";
  cover.dataset.title = titleText;
  cover.dataset.subtitle = subtitleText;
  cover.addEventListener("click", enterReader);
  if (album.cover) {
    const img = document.createElement("img");
    img.alt = "";
    hydrateImage(img, album.cover, album.url);
    img.loading = "lazy";
    cover.append(img);
  } else {
    cover.textContent = "No Cover";
  }

  const coverLabel = document.createElement("div");
  coverLabel.className = "cover-label";
  const coverTitle = document.createElement("strong");
  coverTitle.textContent = titleText;
  const coverSubtitle = document.createElement("span");
  coverSubtitle.textContent = subtitleText;
  coverLabel.append(coverTitle, coverSubtitle);
  cover.append(coverLabel);

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

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const readBtn = document.createElement("button");
  readBtn.type = "button";
  readBtn.textContent = "开始阅读";
  readBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    enterReader();
  });

  body.append(cardTitle, cardSub, meta, aid);
  actions.append(readBtn);
  card.append(cover, body, actions);
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
  setStatus("抓取中...");
}

function showEmpty(text: string) {
  teardownInfiniteScroll();
  resultGrid.className = "result-grid";
  resultGrid.replaceChildren(
    Object.assign(document.createElement("div"), { className: "state-card", textContent: text }),
  );
}

function showError(message: string, onRetry?: () => void) {
  teardownInfiniteScroll();
  const card = document.createElement("div");
  card.className = "state-card error state-action";
  const text = document.createElement("p");
  text.textContent = message;
  card.append(text);
  if (onRetry) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重试";
    retry.addEventListener("click", onRetry);
    card.append(retry);
  }
  resultGrid.className = "result-grid";
  resultGrid.replaceChildren(card);
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
    setStatus(`抓到 ${albums.length} 条，第 ${state.page} 页`);
  } catch (error) {
    if (token !== state.listToken || state.view !== "list" || contextKey !== listContextKey()) return;
    const message = error instanceof Error ? error.message : String(error);
    showError(message, () => loadAlbums());
    setStatus("抓取失败");
  } finally {
    if (token === state.listToken && contextKey === listContextKey()) {
      state.listLoading = false;
      syncToolbar();
    }
  }
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
    setStatus(`抓到 ${resultGrid.querySelectorAll(".album-card").length} 条，第 ${state.page} 页`);
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
  streamLoading = false;
}

function renderReaderGrid(tags?: Tag[]) {
  teardownReaderObserver();
  resultGrid.className = state.readerMode === "stream" ? "reader-stream" : "reader-grid";

  const frag = document.createDocumentFragment();

  if (tags && tags.length > 0) {
    const tagBar = document.createElement("div");
    tagBar.className = "tag-bar";
    for (const tag of tags) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tag-btn";
      btn.textContent = `#${tag.name}`;
      btn.addEventListener("click", () => {
        state.mode = "tag";
        state.query = tag.name;
        state.page = 1;
        searchInput.value = tag.name;
        backToList({ restore: false });
      });
      tagBar.append(btn);
    }
    frag.append(tagBar);
  }

  for (let i = 0; i < state.photos.length; i++) {
    const photo = state.photos[i];
    const idx = i;

    if (state.readerMode === "stream") {
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
    } else {
      const card = document.createElement("div");
      card.className = "reader-photo";
      card.style.setProperty("--card-order", String(i));

      const thumbWrap = document.createElement("div");
      thumbWrap.className = "thumb-wrap";

      if (photo.thumbnail) {
        const img = document.createElement("img");
        img.alt = "";
        img.loading = "lazy";
        hydrateImage(img, photo.thumbnail, photo.url);
        thumbWrap.append(img);
      }

      const label = document.createElement("span");
      label.className = "thumb-label";
      label.textContent = `${i + 1} / ${state.photos.length}`;
      thumbWrap.append(label);

      card.append(thumbWrap);
      card.addEventListener("click", () => openLightbox(idx));
      frag.append(card);
    }
  }

  resultGrid.replaceChildren(frag);

  if (state.readerMode === "stream") {
    setupStreamObserver();
  }
}

let streamQueue: HTMLElement[] = [];
let streamLoading = false;

function setupStreamObserver() {
  teardownReaderObserver();
  streamQueue = [];
  streamLoading = false;
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
      if (!streamLoading) pumpStreamQueue();
    },
    { rootMargin: "400px" },
  );

  document.querySelectorAll<HTMLElement>(".stream-photo").forEach((el) => {
    readerObserver!.observe(el);
  });
  // kick off first few visible
  if (streamQueue.length === 0) {
    const first = document.querySelector<HTMLElement>('.stream-photo[data-state=""]');
    if (first) { streamQueue.push(first); pumpStreamQueue(); }
  }
}

async function pumpStreamQueue() {
  if (streamLoading || streamQueue.length === 0) return;
  streamLoading = true;
  while (streamQueue.length > 0) {
    const container = streamQueue.shift()!;
    if (container.dataset.state !== "") continue;
    const token = state.readerToken;
    if (token !== state.readerToken || state.view !== "reader") break;
    await loadStreamImage(container);
  }
  streamLoading = false;
}

async function loadStreamImage(container: HTMLElement) {
  const index = parseInt(container.dataset.index || "", 10);
  if (isNaN(index)) return;
  const token = state.readerToken;
  container.dataset.state = "loading";

  try {
    const imageUrl = await resolvePhotoImageUrlWithRetry(index, 2);
    if (token !== state.readerToken || container.dataset.state !== "loading") return;

    const img = document.createElement("img");
    img.className = "stream-img";
    img.alt = state.photos[index]?.title || `#${index + 1}`;
    img.addEventListener("load", () => {
      container.dataset.state = "loaded";
    }, { once: true });
    img.addEventListener("error", () => {
      container.dataset.state = "error";
    }, { once: true });
    img.src = imageUrl;
    container.append(img);
  } catch {
    if (token !== state.readerToken || container.dataset.state !== "loading") return;
    container.dataset.state = "error";
  }
}

function toggleReaderMode() {
  state.readerMode = state.readerMode === "grid" ? "stream" : "grid";
  renderReaderGrid();
  syncToolbar();
}

async function loadAlbumReader(aid: string, title: string) {
  if (state.view === "list") saveListSnapshot();
  const token = ++state.readerToken;
  state.listToken++;
  state.view = "reader";
  state.currentAlbum = { aid, title: title || `作品 ${aid}` };
  state.photos = [];
  state.lightboxIndex = -1;
  state.preloadedUrls = {};
  state.preloadFailures = {};
  state.preloadDone = 0;
  state.preloadTotal = 0;
  state.preloading = false;
  syncToolbar();
  showEmpty("正在加载图集...");

  try {
    const detail = await invokeTauri<AlbumDetail>("fetch_album_photos", { aid });
    if (token !== state.readerToken || state.view !== "reader" || state.currentAlbum?.aid !== aid) return;
    state.photos = detail.photos;
    if (detail.photos.length === 0) {
      showEmpty("图集里没有图片");
      setStatus("空图集");
      return;
    }
    renderReaderGrid(detail.tags);
    setStatus(`共 ${detail.photos.length} 张`);
    startPreload(token);
  } catch (error) {
    if (token !== state.readerToken || state.view !== "reader" || state.currentAlbum?.aid !== aid) return;
    const message = error instanceof Error ? error.message : String(error);
    showError(message, () => loadAlbumReader(aid, title));
    setStatus("加载失败");
  }
}

async function startPreload(_readerToken = state.readerToken) {
  // 不再全局预加载所有图片的页面，改为按需加载
  // 缩略图已经通过 hydrateImage 直接使用 WebView 加载
  state.preloading = false;
  updatePreloadBar();
}

function updatePreloadBar() {
  const bar = document.querySelector<HTMLElement>("#preload-bar");
  const fill = document.querySelector<HTMLElement>("#preload-fill");
  if (!bar || !fill) return;

  const pct = state.preloadTotal > 0 ? (state.preloadDone / state.preloadTotal) * 100 : 0;
  fill.style.width = `${pct}%`;

  if (state.preloading) {
    bar.hidden = false;
    const failed = Object.keys(state.preloadFailures).length;
    bar.querySelector("span")!.textContent =
      failed > 0
        ? `预加载 ${state.preloadDone}/${state.preloadTotal}，重试中 ${failed}`
        : `预加载 ${state.preloadDone}/${state.preloadTotal}`;
  } else if (state.preloadDone > 0) {
    const cached = Object.keys(state.preloadedUrls).length;
    bar.querySelector("span")!.textContent = `已缓存 ${cached}/${state.photos.length}`;
    setTimeout(() => { bar.hidden = true; }, 2000);
  }
}

function backToList(options: { restore?: boolean } = {}) {
  const restore = options.restore ?? true;
  state.readerToken++;
  state.lightboxToken++;
  state.view = "list";
  state.currentAlbum = null;
  state.photos = [];
  state.lightboxIndex = -1;
  state.lightboxImageUrl = null;
  state.lightboxZoom = 1;
  state.lightboxPanX = 0;
  state.lightboxPanY = 0;
  state.lightboxPanning = false;
  state.retryNotice = "";
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
        event.preventDefault();
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
  state.retryNotice = "";
  renderLightbox();

  // use preloaded URL if available
  if (state.preloadedUrls[index]) {
    state.lightboxImageUrl = state.preloadedUrls[index];
    renderLightbox();
    preloadNeighbors(index);
    return;
  }

  await loadCurrentPhoto(index, token);
}

async function loadCurrentPhoto(index: number, token = ++state.lightboxToken) {
  state.lightboxImageUrl = null;
  state.retryNotice = "";
  renderLightbox();

  let imageUrl: string;
  try {
    imageUrl = await resolvePhotoImageUrlUntilSuccess(
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
  } catch {
    return;
  }

  if (token !== state.lightboxToken || state.lightboxIndex !== index) return;
  state.lightboxImageUrl = imageUrl;
  state.preloadedUrls[index] = imageUrl;
  delete state.preloadFailures[index];
  state.retryNotice = "";
  preloadImage(imageUrl);
  renderLightbox();
  preloadNeighbors(index);
  setStatus("");
}

function preloadNeighbors(index: number) {
  for (const offset of [-2, -1, 1, 2]) {
    const ni = index + offset;
    if (ni >= 0 && ni < state.photos.length && !state.preloadedUrls[ni]) {
      preloadFullImage(ni);
    }
  }
}

function closeLightbox() {
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
  zoomOut.textContent = "−";
  zoomOut.title = "缩小";
  zoomOut.addEventListener("click", (event) => {
    event.stopPropagation();
    setLightboxZoom(state.lightboxZoom / 1.2);
  });
  const zoomReset = document.createElement("button");
  zoomReset.type = "button";
  zoomReset.textContent = "100%";
  zoomReset.title = "重置缩放";
  zoomReset.addEventListener("click", (event) => {
    event.stopPropagation();
    resetLightboxZoom();
  });
  const zoomIn = document.createElement("button");
  zoomIn.type = "button";
  zoomIn.textContent = "+";
  zoomIn.title = "放大";
  zoomIn.addEventListener("click", (event) => {
    event.stopPropagation();
    setLightboxZoom(state.lightboxZoom * 1.2);
  });
  controls.append(zoomOut, zoomReset, zoomIn);

  toolbar.append(titleEl, counter, controls, zoom);

  const closeBtn = document.createElement("button");
  closeBtn.className = "lightbox-close";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", closeLightbox);

  const prevBtn = document.createElement("button");
  prevBtn.className = "lightbox-nav prev";
  prevBtn.textContent = "‹";
  prevBtn.disabled = state.lightboxIndex <= 0;
  prevBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    navigateLightbox(-1);
  });

  const nextBtn = document.createElement("button");
  nextBtn.className = "lightbox-nav next";
  nextBtn.textContent = "›";
  nextBtn.disabled = state.lightboxIndex >= total - 1;
  nextBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    navigateLightbox(1);
  });

  bindLightboxZoomEvents(overlay);

  overlay.append(imgWrap, toolbar, closeBtn, prevBtn, nextBtn);
  document.body.append(overlay);
  applyLightboxZoomAndPan();
}

// ---- keyboard ----

document.addEventListener("keydown", (e) => {
  if (state.lightboxIndex >= 0) {
    if (e.key === "Escape") {
      closeLightbox();
    } else if (e.key === "ArrowLeft") {
      navigateLightbox(-1);
    } else if (e.key === "ArrowRight") {
      navigateLightbox(1);
    } else if ((e.key === "+" || e.key === "=") && state.lightboxImageUrl && state.lightboxImageUrl !== "__error__") {
      setLightboxZoom(state.lightboxZoom * 1.2);
    } else if (e.key === "-" && state.lightboxImageUrl && state.lightboxImageUrl !== "__error__") {
      setLightboxZoom(state.lightboxZoom / 1.2);
    } else if (e.key === "0" && state.lightboxImageUrl && state.lightboxImageUrl !== "__error__") {
      resetLightboxZoom();
    }
    return;
  }

  if (state.view === "reader" && e.key === "Escape") {
    backToList();
  }
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

jumpTopButton.addEventListener("click", () => {
  resultGrid.scrollTo({ top: 0, behavior: "smooth" });
});

resultGrid.addEventListener(
  "scroll",
  () => {
    updateJumpTopButton();
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

renderCategories();
loadAlbums();
