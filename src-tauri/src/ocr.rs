use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const VISION_HELPER_SOURCE: &str = include_str!("../ocr/ocr_helper.swift");
const VISION_HELPER_VERSION: &str = "v2";

// 漫画引擎(日文竖排):Rust 助手 + ONNX 模型,首次使用由 cargo 编译并缓存
const MANGA_CARGO_TOML: &str = include_str!("../ocr/manga_helper/Cargo.toml");
const MANGA_HELPER_SOURCE: &str = include_str!("../ocr/manga_helper/src/main.rs");
const MANGA_HELPER_VERSION: &str = "v1";

const MAX_VISION_POOL: usize = 3;
const MAX_MANGA_POOL: usize = 2;
const IMAGE_CACHE_MAX_BYTES: usize = 192 * 1024 * 1024;

// (文件名, 下载地址, 最小字节数, 用于校验下载是否完整)
const MODEL_FILES: &[(&str, &str, u64)] = &[
    (
        "comic-text-detector.onnx",
        "https://huggingface.co/mayocream/comic-text-detector-onnx/resolve/main/comic-text-detector.onnx",
        50_000_000,
    ),
    (
        "encoder_model.onnx",
        "https://huggingface.co/l0wgear/manga-ocr-2025-onnx/resolve/main/encoder_model.onnx",
        10_000_000,
    ),
    (
        "decoder_model.onnx",
        "https://huggingface.co/l0wgear/manga-ocr-2025-onnx/resolve/main/decoder_model.onnx",
        50_000_000,
    ),
    (
        "vocab.txt",
        "https://huggingface.co/l0wgear/manga-ocr-2025-onnx/resolve/main/vocab.txt",
        10_000,
    ),
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPageInput {
    pub index: usize,
    #[serde(default)]
    pub image_url: Option<String>,
    #[serde(default)]
    pub data_url: Option<String>,
    #[serde(default)]
    pub languages: Option<Vec<String>>,
    /// "manga" = 日文漫画引擎(竖排优先), "vision" = Apple Vision(默认)
    #[serde(default)]
    pub engine: Option<String>,
    /// 是否附带逐块文字识别(manga 引擎可用;vision 恒返回文字)
    #[serde(default)]
    pub with_text: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrRegion {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPageOutput {
    pub index: usize,
    pub regions: Vec<OcrRegion>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, PartialEq)]
enum OcrEngine {
    Vision,
    Manga,
}

impl OcrEngine {
    fn from_str(value: Option<&str>) -> Self {
        match value {
            Some("manga") => OcrEngine::Manga,
            _ => OcrEngine::Vision,
        }
    }
}

struct Worker {
    stdin: ChildStdin,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<serde_json::Value>>>>,
    next_id: u64,
    engine: OcrEngine,
}

struct Pool {
    workers: Vec<Worker>,
    next: AtomicUsize,
}

static VISION_POOL: OnceLock<Mutex<Option<Pool>>> = OnceLock::new();
static MANGA_POOL: OnceLock<Mutex<Option<Pool>>> = OnceLock::new();
struct ImageByteCache {
    entries: HashMap<String, Arc<Vec<u8>>>,
    order: VecDeque<String>,
    bytes: usize,
}

impl ImageByteCache {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
        }
    }

    fn insert(&mut self, url: String, bytes: Vec<u8>) {
        if bytes.is_empty() || bytes.len() > IMAGE_CACHE_MAX_BYTES {
            return;
        }
        if let Some(previous) = self.entries.remove(&url) {
            self.bytes = self.bytes.saturating_sub(previous.len());
            self.order.retain(|key| key != &url);
        }
        while self.bytes + bytes.len() > IMAGE_CACHE_MAX_BYTES {
            let Some(oldest) = self.order.pop_front() else { break };
            if let Some(removed) = self.entries.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(removed.len());
            }
        }
        self.bytes += bytes.len();
        self.order.push_back(url.clone());
        self.entries.insert(url, Arc::new(bytes));
    }

    fn get(&mut self, url: &str) -> Option<Arc<Vec<u8>>> {
        let bytes = self.entries.get(url)?.clone();
        self.order.retain(|key| key != url);
        self.order.push_back(url.to_string());
        Some(bytes)
    }
}

static IMAGE_CACHE: OnceLock<Mutex<ImageByteCache>> = OnceLock::new();

pub fn cache_image_bytes(url: &str, bytes: Vec<u8>) {
    if url.is_empty() || bytes.is_empty() {
        return;
    }
    let map = IMAGE_CACHE
        .get_or_init(|| Mutex::new(ImageByteCache::new()))
        .lock()
        .ok();
    let Some(mut cache) = map else {
        return;
    };
    cache.insert(url.to_string(), bytes);
}

fn cached_image_bytes(url: &str) -> Option<Arc<Vec<u8>>> {
    IMAGE_CACHE
        .get_or_init(|| Mutex::new(ImageByteCache::new()))
        .lock()
        .ok()?
        .get(url)
}

fn pool_for(engine: OcrEngine) -> &'static Mutex<Option<Pool>> {
    match engine {
        OcrEngine::Vision => VISION_POOL.get_or_init(|| Mutex::new(None)),
        OcrEngine::Manga => MANGA_POOL.get_or_init(|| Mutex::new(None)),
    }
}

fn lock_pool(engine: OcrEngine) -> Result<std::sync::MutexGuard<'static, Option<Pool>>, String> {
    pool_for(engine)
        .lock()
        .map_err(|_| "OCR 内部锁异常".to_string())
}

// ── 引擎安装(编译缓存) ───────────────────────────────────────────────────

fn hash_sources(items: &[&str]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for item in items {
        item.hash(&mut hasher);
    }
    hasher.finish()
}

fn vision_helper_dir() -> PathBuf {
    let hash = hash_sources(&[VISION_HELPER_VERSION, VISION_HELPER_SOURCE]);
    std::env::temp_dir().join(format!("wnacg-ocr-vision-{hash:016x}"))
}

fn manga_helper_dir() -> PathBuf {
    let hash = hash_sources(&[
        MANGA_HELPER_VERSION,
        MANGA_CARGO_TOML,
        MANGA_HELPER_SOURCE,
    ]);
    std::env::temp_dir().join(format!("wnacg-ocr-manga-{hash:016x}"))
}

fn models_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("wnacg")
        .join("ocr-models")
}

fn ensure_vision_helper() -> Result<PathBuf, String> {
    static COMPILING: Mutex<()> = Mutex::new(());
    let _guard = COMPILING.lock().map_err(|_| "OCR 初始化冲突".to_string())?;

    let dir = vision_helper_dir();
    std::fs::create_dir_all(&dir).map_err(|err| format!("无法创建 OCR 缓存目录：{err}"))?;
    let bin = dir.join("ocr-helper");
    if bin.exists() {
        return Ok(bin);
    }

    let src = dir.join("ocr_helper.swift");
    std::fs::write(&src, VISION_HELPER_SOURCE)
        .map_err(|err| format!("无法写入 OCR 助手源码：{err}"))?;
    let status = Command::new("swiftc")
        .arg("-O")
        .arg(&src)
        .arg("-o")
        .arg(&bin)
        .status()
        .map_err(|err| format!("未找到 swiftc，本地 OCR 需要 macOS 与 Xcode 命令行工具：{err}"))?;
    if !status.success() {
        let _ = std::fs::remove_file(&bin);
        return Err("OCR 引擎编译失败，请确认已安装 Xcode 命令行工具".to_string());
    }
    Ok(bin)
}

fn ensure_manga_models() -> Result<(), String> {
    let dir = models_dir();
    std::fs::create_dir_all(&dir).map_err(|err| format!("无法创建模型目录：{err}"))?;
    for (name, url, min_bytes) in MODEL_FILES {
        let dest = dir.join(name);
        if let Ok(meta) = std::fs::metadata(&dest) {
            if meta.len() >= *min_bytes {
                continue;
            }
        }
        let status = Command::new("curl")
            .args(["-fL", "--retry", "3", "-C", "-"])
            .arg(url)
            .arg("-o")
            .arg(&dest)
            .status()
            .map_err(|err| format!("未找到 curl，无法下载 OCR 模型：{err}"))?;
        if !status.success() {
            let _ = std::fs::remove_file(&dest);
            return Err(format!("OCR 模型 {name} 下载失败，请检查网络后重试"));
        }
        if let Ok(meta) = std::fs::metadata(&dest) {
            if meta.len() < *min_bytes {
                let _ = std::fs::remove_file(&dest);
                return Err(format!("OCR 模型 {name} 下载不完整，请重试"));
            }
        }
    }
    Ok(())
}

fn cargo_bin() -> Command {
    match Command::new("cargo").arg("--version").output() {
        Ok(_) => Command::new("cargo"),
        Err(_) => {
            let fallback = std::env::var("HOME")
                .map(|home| PathBuf::from(home).join(".cargo/bin/cargo"))
                .unwrap_or_default();
            Command::new(fallback)
        }
    }
}

fn ensure_manga_helper() -> Result<PathBuf, String> {
    static COMPILING: Mutex<()> = Mutex::new(());
    let _guard = COMPILING.lock().map_err(|_| "OCR 初始化冲突".to_string())?;

    let dir = manga_helper_dir();
    std::fs::create_dir_all(&dir.join("src"))
        .map_err(|err| format!("无法创建 OCR 缓存目录：{err}"))?;
    let bin = dir
        .join("target")
        .join("release")
        .join("manga_ocr_helper");
    if bin.exists() {
        return Ok(bin);
    }

    std::fs::write(dir.join("Cargo.toml"), MANGA_CARGO_TOML)
        .map_err(|err| format!("无法写入 OCR 助手工程：{err}"))?;
    std::fs::write(dir.join("src/main.rs"), MANGA_HELPER_SOURCE)
        .map_err(|err| format!("无法写入 OCR 助手源码：{err}"))?;

    let status = cargo_bin()
        .current_dir(&dir)
        .args(["build", "--release"])
        .env("WNACG_OCR_MODELS_DIR", models_dir())
        .status()
        .map_err(|err| format!("未找到 cargo，本地漫画 OCR 需要 Rust 工具链：{err}"))?;
    if !status.success() {
        return Err("漫画 OCR 引擎编译失败，请确认已安装 Rust 工具链".to_string());
    }
    if !bin.exists() {
        return Err("漫画 OCR 引擎编译产物缺失".to_string());
    }
    Ok(bin)
}

// ── 工作进程池 ───────────────────────────────────────────────────────────

fn spawn_worker(helper: &std::path::Path, engine: OcrEngine) -> Result<Worker, String> {
    let mut command = Command::new(helper);
    if engine == OcrEngine::Manga {
        command.env("WNACG_OCR_MODELS_DIR", models_dir());
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("无法启动本地 OCR 进程：{err}"))?;
    let stdout = child.stdout.take().ok_or("OCR 进程输出不可用")?;
    let stdin = child.stdin.take().ok_or("OCR 进程输入不可用")?;

    let pending: Arc<Mutex<HashMap<u64, mpsc::Sender<serde_json::Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let reader_pending = Arc::clone(&pending);
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let id = value.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
            if let Ok(mut map) = reader_pending.lock() {
                if let Some(tx) = map.remove(&id) {
                    let _ = tx.send(value);
                }
            }
        }
    });

    Ok(Worker {
        stdin,
        pending,
        next_id: 1,
        engine,
    })
}

fn submit(
    worker: &mut Worker,
    data: String,
    languages: &[String],
    with_text: bool,
) -> Result<mpsc::Receiver<serde_json::Value>, String> {
    let id = worker.next_id;
    worker.next_id += 1;
    let (tx, rx) = mpsc::channel();
    {
        let mut pending = worker
            .pending
            .lock()
            .map_err(|_| "OCR 内部锁异常".to_string())?;
        pending.insert(id, tx);
    }

    let payload = match worker.engine {
        OcrEngine::Vision => {
            let languages: Vec<String> = if languages.is_empty() {
                vec![
                    "ja-JP".to_string(),
                    "zh-Hans".to_string(),
                    "zh-Hant".to_string(),
                    "en-US".to_string(),
                ]
            } else {
                languages.to_vec()
            };
            serde_json::json!({
                "id": id,
                "data": data,
                "languages": languages,
                "minimumTextHeight": 0.002
            })
        }
        OcrEngine::Manga => serde_json::json!({
            "id": id,
            "data": data,
            "withText": with_text
        }),
    };
    let line = serde_json::to_string(&payload).map_err(|err| err.to_string())?;
    if let Err(err) = writeln!(worker.stdin, "{line}").and_then(|_| worker.stdin.flush()) {
        if let Ok(mut pending) = worker.pending.lock() {
            pending.remove(&id);
        }
        return Err(format!("OCR 进程通信失败：{err}"));
    }
    Ok(rx)
}

fn extract_base64(data_url: &str) -> Result<String, String> {
    if data_url.is_empty() {
        return Err("缺少图片数据".to_string());
    }
    let payload = match data_url.find(";base64,") {
        Some(idx) => &data_url[idx + ";base64,".len()..],
        None => data_url,
    }
    .trim();
    if payload.is_empty() {
        return Err("图片数据为空".to_string());
    }
    if payload.len() > 60_000_000 {
        return Err("图片过大，无法本地识别".to_string());
    }
    Ok(payload.to_string())
}

fn resolve_page_source(page: &OcrPageInput) -> Result<String, String> {
    if let Some(image_url) = page.image_url.as_deref() {
        if let Some(bytes) = cached_image_bytes(image_url) {
            return Ok(base64::engine::general_purpose::STANDARD.encode(bytes.as_slice()));
        }
    }
    match page.data_url.as_deref() {
        Some(data_url) => extract_base64(data_url),
        None => Err("图片尚未加载完成，等待后重试".to_string()),
    }
}

fn ensure_engine(engine: OcrEngine) -> Result<PathBuf, String> {
    match engine {
        OcrEngine::Vision => ensure_vision_helper(),
        OcrEngine::Manga => {
            ensure_manga_models()?;
            ensure_manga_helper()
        }
    }
}

fn ensure_pool(engine: OcrEngine, helper: &std::path::Path) -> Result<(), String> {
    let max_workers = match engine {
        OcrEngine::Vision => MAX_VISION_POOL,
        OcrEngine::Manga => MAX_MANGA_POOL,
    };
    let mut pool_guard = lock_pool(engine)?;
    if pool_guard.is_none() {
        *pool_guard = Some(Pool {
            workers: Vec::new(),
            next: AtomicUsize::new(0),
        });
    }
    let pool = pool_guard.as_mut().expect("pool just initialized");
    while pool.workers.len() < max_workers {
        match spawn_worker(helper, engine) {
            Ok(worker) => pool.workers.push(worker),
            Err(err) => {
                if pool.workers.is_empty() {
                    return Err(err);
                }
                break;
            }
        }
    }
    if pool.workers.is_empty() {
        return Err("本地 OCR 引擎启动失败".to_string());
    }
    Ok(())
}

fn page_engine(page: &OcrPageInput) -> OcrEngine {
    OcrEngine::from_str(page.engine.as_deref())
}

pub fn ocr_pages_sync(pages: Vec<OcrPageInput>) -> Result<Vec<OcrPageOutput>, String> {
    let mut need_vision = false;
    let mut need_manga = false;
    for page in &pages {
        match page_engine(page) {
            OcrEngine::Vision => need_vision = true,
            OcrEngine::Manga => need_manga = true,
        }
    }
    if need_vision {
        let helper = ensure_engine(OcrEngine::Vision)?;
        ensure_pool(OcrEngine::Vision, &helper)?;
    }
    if need_manga {
        let helper = ensure_engine(OcrEngine::Manga)?;
        ensure_pool(OcrEngine::Manga, &helper)?;
    }

    let mut outputs: Vec<OcrPageOutput> = Vec::with_capacity(pages.len());
    let mut receivers: Vec<(usize, OcrEngine, mpsc::Receiver<serde_json::Value>)> = Vec::new();

    for page in pages {
        let engine = page_engine(&page);
        let data = resolve_page_source(&page);
        let data = match data {
            Ok(data) => data,
            Err(err) => {
                outputs.push(OcrPageOutput {
                    index: page.index,
                    regions: Vec::new(),
                    error: Some(err),
                });
                continue;
            }
        };

        let mut attempts = 0;
        loop {
            let mut pool_guard = lock_pool(engine)?;
            let pool = pool_guard.as_mut().expect("pool initialized above");
            let matching: Vec<usize> = pool
                .workers
                .iter()
                .enumerate()
                .filter(|(_, w)| w.engine == engine)
                .map(|(i, _)| i)
                .collect();
            if matching.is_empty() {
                outputs.push(OcrPageOutput {
                    index: page.index,
                    regions: Vec::new(),
                    error: Some("本地 OCR 引擎未就绪".to_string()),
                });
                break;
            }
            let slot = matching[pool.next.fetch_add(1, Ordering::Relaxed) % matching.len()];
            let languages = page.languages.as_deref().unwrap_or(&[]);
            match submit(
                &mut pool.workers[slot],
                data.clone(),
                languages,
                page.with_text,
            ) {
                Ok(rx) => {
                    receivers.push((page.index, engine, rx));
                    break;
                }
                Err(err) => {
                    let dead = pool.workers.swap_remove(slot);
                    drop(dead);
                    let helper = match ensure_engine(engine) {
                        Ok(helper) => helper,
                        Err(ensure_err) => {
                            outputs.push(OcrPageOutput {
                                index: page.index,
                                regions: Vec::new(),
                                error: Some(ensure_err),
                            });
                            break;
                        }
                    };
                    if let Ok(worker) = spawn_worker(&helper, engine) {
                        pool.workers.push(worker);
                    }
                    attempts += 1;
                    if attempts > 2 || pool.workers.is_empty() {
                        outputs.push(OcrPageOutput {
                            index: page.index,
                            regions: Vec::new(),
                            error: Some(err),
                        });
                        break;
                    }
                }
            }
        }
    }
    // 提交阶段结束后立即释放各池锁,避免其它窗口/批次的 OCR 被长时间阻塞

    for (index, engine, rx) in receivers {
        let timeout = match engine {
            OcrEngine::Vision => Duration::from_secs(45),
            OcrEngine::Manga => Duration::from_secs(120),
        };
        let result = match rx.recv_timeout(timeout) {
            Ok(value) => {
                if let Some(err) = value.get("error").and_then(|v| v.as_str()) {
                    OcrPageOutput {
                        index,
                        regions: Vec::new(),
                        error: Some(err.to_string()),
                    }
                } else if let Some(regions) = value.get("regions").and_then(|v| v.as_array()) {
                    let parsed: Vec<OcrRegion> = regions
                        .iter()
                        .filter_map(|r| serde_json::from_value::<OcrRegion>(r.clone()).ok())
                        .collect();
                    OcrPageOutput {
                        index,
                        regions: parsed,
                        error: None,
                    }
                } else {
                    OcrPageOutput {
                        index,
                        regions: Vec::new(),
                        error: Some("OCR 返回格式异常".to_string()),
                    }
                }
            }
            Err(_) => OcrPageOutput {
                index,
                regions: Vec::new(),
                error: Some("OCR 超时或进程退出".to_string()),
            },
        };
        outputs.push(result);
    }

    outputs.sort_by_key(|output| output.index);
    Ok(outputs)
}

#[tauri::command]
pub async fn ocr_pages(pages: Vec<OcrPageInput>) -> Result<Vec<OcrPageOutput>, String> {
    tauri::async_runtime::spawn_blocking(move || ocr_pages_sync(pages))
        .await
        .map_err(|err| format!("OCR 任务执行失败：{err}"))?
}

#[tauri::command]
pub async fn ocr_engine_status(engine: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let engine = OcrEngine::from_str(engine.as_deref());
        let helper = ensure_engine(engine)?;
        ensure_pool(engine, &helper)?;
        Ok::<_, String>("ready".to_string())
    })
    .await
    .map_err(|err| format!("OCR 引擎初始化失败：{err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manga_engine_detects_vertical_japanese() {
        let path = std::env::var("WNACG_OCR_TEST_IMAGE").unwrap_or_else(|_| {
            "/Users/gavin/Documents/Codex/2026-08-07/wn/work/ocr-test/test_vertical3.png".to_string()
        });
        let bytes = std::fs::read(&path).expect("测试图片不存在");
        let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let pages = vec![OcrPageInput {
            index: 0,
            image_url: None,
            data_url: Some(data),
            languages: None,
            engine: Some("manga".to_string()),
            with_text: true,
        }];
        let outputs = ocr_pages_sync(pages).expect("OCR 任务应成功");
        assert_eq!(outputs.len(), 1);
        let output = &outputs[0];
        assert!(
            output.error.is_none(),
            "OCR 报错: {:?}",
            output.error
        );
        assert!(output.regions.len() >= 2, "检测到的区域太少: {:?}", output.regions);
        let texts: Vec<&str> = output.regions.iter().map(|r| r.text.as_str()).collect();
        eprintln!("识别文本: {texts:?}");
        assert!(
            texts.iter().any(|t| t.contains("縦書き")),
            "应识别出竖排文字,实际: {texts:?}"
        );
    }

    #[test]
    fn manga_engine_boxes_are_deterministic_between_passes() {
        let path = std::env::var("WNACG_OCR_TEST_IMAGE").unwrap_or_else(|_| {
            "/Users/gavin/Documents/Codex/2026-08-07/wn/work/ocr-test/test_manga2.png".to_string()
        });
        let bytes = std::fs::read(&path).expect("测试图片不存在");
        let data = base64::engine::general_purpose::STANDARD.encode(&bytes);

        let run = |with_text: bool| -> Vec<OcrRegion> {
            let pages = vec![OcrPageInput {
                index: 0,
                image_url: None,
                data_url: Some(data.clone()),
                languages: None,
                engine: Some("manga".to_string()),
                with_text,
            }];
            let outputs = ocr_pages_sync(pages).expect("OCR 任务应成功");
            outputs[0].regions.clone()
        };

        let boxes_pass = run(false);
        let text_pass = run(true);
        assert!(!boxes_pass.is_empty(), "检测结果为空");
        assert_eq!(boxes_pass.len(), text_pass.len(), "两次区域数量不一致");
        for (a, b) in boxes_pass.iter().zip(text_pass.iter()) {
            assert!(
                (a.x - b.x).abs() < 0.0001
                    && (a.y - b.y).abs() < 0.0001
                    && (a.w - b.w).abs() < 0.0001
                    && (a.h - b.h).abs() < 0.0001,
                "两次框坐标不一致: {a:?} vs {b:?}"
            );
        }
        assert!(
            text_pass.iter().any(|r| !r.text.trim().is_empty()),
            "文字识别结果为空"
        );
    }
}
