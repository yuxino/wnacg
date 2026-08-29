use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const VISION_HELPER_SOURCE: &str = include_str!("../ocr/ocr_helper.swift");
const VISION_HELPER_VERSION: &str = "v2";

// 漫画引擎(日文竖排):Rust 助手 + ONNX 模型,首次使用由 cargo 编译并缓存
const MANGA_CARGO_TOML: &str = include_str!("../ocr/manga_helper/Cargo.toml");
const MANGA_CARGO_LOCK: &str = include_str!("../ocr/manga_helper/Cargo.lock");
const MANGA_HELPER_SOURCE: &str = include_str!("../ocr/manga_helper/src/main.rs");
const MANGA_HELPER_VERSION: &str = "v1";

const MAX_VISION_POOL: usize = 3;
const MAX_MANGA_POOL: usize = 2;
const IMAGE_CACHE_MAX_BYTES: usize = 192 * 1024 * 1024;

/// Windows 上以无控制台窗口方式启动子进程，避免 OCR 工作进程/curl/cargo 弹出黑框。
#[cfg(target_os = "windows")]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_console(_command: &mut Command) {}

struct ModelFile {
    name: &'static str,
    url: &'static str,
    bytes: u64,
    sha256: &'static str,
}

const MODEL_FILES: &[ModelFile] = &[
    ModelFile {
        name: "comic-text-detector.onnx",
        url: "https://huggingface.co/mayocream/comic-text-detector-onnx/resolve/a5d67ec772adef819ef5b0e7aa701fcf4c8bf74a/comic-text-detector.onnx",
        bytes: 94_669_756,
        sha256: "1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f",
    },
    ModelFile {
        name: "encoder_model.onnx",
        url: "https://huggingface.co/l0wgear/manga-ocr-2025-onnx/resolve/e8b27bbd3f424fe3877e0bda704d6a920e4f0a33/encoder_model.onnx",
        bytes: 22_356_885,
        sha256: "f87668ae0f62d6f032dac6b213e8c0fea84cd15895ac8cab624cc9a2f49d4a27",
    },
    ModelFile {
        name: "decoder_model.onnx",
        url: "https://huggingface.co/l0wgear/manga-ocr-2025-onnx/resolve/e8b27bbd3f424fe3877e0bda704d6a920e4f0a33/decoder_model.onnx",
        bytes: 118_053_454,
        sha256: "6b1fb216d542c4b2a4fa5b9d7ae3522081eb85fb959d2cecd28055af956a8a5e",
    },
    ModelFile {
        name: "vocab.txt",
        url: "https://huggingface.co/l0wgear/manga-ocr-2025-onnx/resolve/e8b27bbd3f424fe3877e0bda704d6a920e4f0a33/vocab.txt",
        bytes: 24_072,
        sha256: "344fbb6b8bf18c57839e924e2c9365434697e0227fac00b88bb4899b78aa594d",
    },
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
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
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
        MANGA_CARGO_LOCK,
        MANGA_HELPER_SOURCE,
    ]);
    std::env::temp_dir().join(format!("wnacg-ocr-manga-{hash:016x}"))
}

fn models_dir() -> PathBuf {
    dirs::data_local_dir()
        .map(|path| path.join("wnacg"))
        .or_else(|| dirs::home_dir().map(|path| path.join(".wnacg")))
        .unwrap_or_else(|| std::env::temp_dir().join("wnacg"))
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

fn file_sha256(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest as _, Sha256};

    let mut file =
        std::fs::File::open(path).map_err(|error| format!("无法读取 OCR 模型：{error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("无法校验 OCR 模型：{error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn model_file_is_valid(path: &std::path::Path, model: &ModelFile) -> bool {
    std::fs::metadata(path)
        .ok()
        .is_some_and(|metadata| metadata.len() == model.bytes)
        && file_sha256(path)
            .ok()
            .is_some_and(|digest| digest == model.sha256)
}

fn ensure_manga_models_inner() -> Result<(), String> {
    let dir = models_dir();
    std::fs::create_dir_all(&dir).map_err(|err| format!("无法创建模型目录：{err}"))?;
    for model in MODEL_FILES {
        let dest = dir.join(model.name);
        if model_file_is_valid(&dest, model) {
            continue;
        }
        let part = dir.join(format!("{}.part", model.name));
        let mut command = Command::new("curl");
        hide_console(&mut command);
        let status = command
            .args([
                "--proto",
                "=https",
                "--proto-redir",
                "=https",
                "-fL",
                "--retry",
                "3",
                "--max-filesize",
            ])
            .arg(model.bytes.to_string())
            .args(["-C", "-"])
            .arg(model.url)
            .arg("-o")
            .arg(&part)
            .status()
            .map_err(|err| format!("未找到 curl，无法下载 OCR 模型：{err}"))?;
        if !status.success() {
            let _ = std::fs::remove_file(&part);
            return Err(format!(
                "OCR 模型 {} 下载失败，请检查网络后重试",
                model.name
            ));
        }
        if !model_file_is_valid(&part, model) {
            let _ = std::fs::remove_file(&part);
            return Err(format!("OCR 模型 {} 校验失败，请重试", model.name));
        }
        if dest.exists() {
            std::fs::remove_file(&dest)
                .map_err(|error| format!("无法替换旧 OCR 模型 {}: {error}", model.name))?;
        }
        std::fs::rename(&part, &dest)
            .map_err(|error| format!("无法安装 OCR 模型 {}: {error}", model.name))?;
    }
    Ok(())
}

fn ensure_manga_models() -> Result<(), String> {
    static MODELS_READY: OnceLock<()> = OnceLock::new();
    static INSTALLING: Mutex<()> = Mutex::new(());
    if MODELS_READY.get().is_some() {
        return Ok(());
    }
    let _guard = INSTALLING
        .lock()
        .map_err(|_| "OCR 模型初始化冲突".to_string())?;
    if MODELS_READY.get().is_some() {
        return Ok(());
    }
    ensure_manga_models_inner()?;
    let _ = MODELS_READY.set(());
    Ok(())
}

fn cargo_bin() -> Command {
    let mut version_check = Command::new("cargo");
    hide_console(&mut version_check);
    let mut command = match version_check.arg("--version").output() {
        Ok(_) => Command::new("cargo"),
        Err(_) => {
            let binary_name = if cfg!(target_os = "windows") {
                "cargo.exe"
            } else {
                "cargo"
            };
            let fallback = dirs::home_dir()
                .map(|home| home.join(".cargo").join("bin").join(binary_name))
                .unwrap_or_else(|| PathBuf::from(binary_name));
            Command::new(fallback)
        }
    };
    hide_console(&mut command);
    command
}

fn manga_helper_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "manga_ocr_helper.exe"
    } else {
        "manga_ocr_helper"
    }
}

fn is_scoped_manga_cache_dir(temp_root: &Path, cache_dir: &Path) -> bool {
    let Some(name) = cache_dir.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(hash) = name.strip_prefix("wnacg-ocr-manga-") else {
        return false;
    };
    cache_dir.parent() == Some(temp_root)
        && hash.len() == 16
        && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_manga_cache_dir(temp_root: &Path, cache_dir: &Path) -> Result<(), String> {
    if !is_scoped_manga_cache_dir(temp_root, cache_dir) {
        return Err("OCR 助手缓存目录路径越界".to_string());
    }
    let metadata = std::fs::symlink_metadata(cache_dir)
        .map_err(|error| format!("无法检查 OCR 助手缓存目录：{error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("OCR 助手缓存目录不是可信的普通目录".to_string());
    }
    Ok(())
}

fn cleanup_manga_build_target_in(
    temp_root: &Path,
    expected_cache_dir: &Path,
    cache_dir: &Path,
) -> Result<(), String> {
    if cache_dir != expected_cache_dir || !is_scoped_manga_cache_dir(temp_root, cache_dir) {
        return Err("拒绝清理 OCR 助手缓存目录之外的路径".to_string());
    }
    validate_manga_cache_dir(temp_root, cache_dir)?;

    let target = cache_dir.join("target");
    let target_metadata = match std::fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("无法检查 OCR 助手构建缓存：{error}")),
    };
    if target_metadata.file_type().is_symlink() || !target_metadata.is_dir() {
        return Err("OCR 助手 target 不是可信的普通目录".to_string());
    }
    std::fs::remove_dir_all(&target).map_err(|error| format!("无法清理 OCR 助手构建缓存：{error}"))
}

fn cleanup_manga_build_target(cache_dir: &Path) -> Result<(), String> {
    cleanup_manga_build_target_in(&std::env::temp_dir(), &manga_helper_dir(), cache_dir)
}

fn install_manga_helper_artifact(
    cache_dir: &Path,
    built_binary: &Path,
    installed_binary: &Path,
) -> Result<(), String> {
    let expected_built_binary = cache_dir
        .join("target")
        .join("release")
        .join(manga_helper_binary_name());
    let expected_installed_binary = cache_dir.join(manga_helper_binary_name());
    if !is_scoped_manga_cache_dir(&std::env::temp_dir(), cache_dir)
        || built_binary != expected_built_binary
        || installed_binary != expected_installed_binary
    {
        return Err("漫画 OCR 引擎安装路径越界".to_string());
    }
    validate_manga_cache_dir(&std::env::temp_dir(), cache_dir)?;
    for directory in [cache_dir.join("target"), cache_dir.join("target/release")] {
        let metadata = std::fs::symlink_metadata(&directory)
            .map_err(|error| format!("无法检查漫画 OCR 引擎构建目录：{error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("漫画 OCR 引擎构建目录不是可信的普通目录".to_string());
        }
    }
    let built_metadata = std::fs::symlink_metadata(built_binary)
        .map_err(|error| format!("漫画 OCR 引擎编译产物缺失：{error}"))?;
    if built_metadata.file_type().is_symlink()
        || !built_metadata.is_file()
        || built_metadata.len() == 0
    {
        return Err("漫画 OCR 引擎编译产物无效".to_string());
    }

    let staging = cache_dir.join(format!(
        ".{}.{}.tmp",
        manga_helper_binary_name(),
        std::process::id()
    ));
    let install_result = (|| {
        let mut source = std::fs::File::open(built_binary)
            .map_err(|error| format!("无法读取漫画 OCR 引擎编译产物：{error}"))?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        let mut destination = options
            .open(&staging)
            .map_err(|error| format!("无法创建漫画 OCR 引擎临时产物：{error}"))?;
        let copied = std::io::copy(&mut source, &mut destination)
            .map_err(|error| format!("无法复制漫画 OCR 引擎：{error}"))?;
        if copied != built_metadata.len() {
            return Err("漫画 OCR 引擎复制不完整".to_string());
        }
        destination
            .sync_all()
            .map_err(|error| format!("无法同步漫画 OCR 引擎：{error}"))?;
        std::fs::set_permissions(&staging, built_metadata.permissions())
            .map_err(|error| format!("无法设置漫画 OCR 引擎权限：{error}"))?;
        std::fs::rename(&staging, installed_binary)
            .map_err(|error| format!("无法安装漫画 OCR 引擎：{error}"))
    })();
    if install_result.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    install_result
}

fn ensure_manga_helper() -> Result<PathBuf, String> {
    static COMPILING: Mutex<()> = Mutex::new(());
    let _guard = COMPILING.lock().map_err(|_| "OCR 初始化冲突".to_string())?;

    let dir = manga_helper_dir();
    std::fs::create_dir_all(dir.join("src"))
        .map_err(|err| format!("无法创建 OCR 缓存目录：{err}"))?;
    let binary_name = manga_helper_binary_name();
    let bin = dir.join(binary_name);
    if std::fs::symlink_metadata(&bin)
        .ok()
        .is_some_and(|metadata| {
            !metadata.file_type().is_symlink() && metadata.is_file() && metadata.len() > 0
        })
    {
        if let Err(error) = cleanup_manga_build_target(&dir) {
            eprintln!("{error}");
        }
        return Ok(bin);
    }

    std::fs::write(dir.join("Cargo.toml"), MANGA_CARGO_TOML)
        .map_err(|err| format!("无法写入 OCR 助手工程：{err}"))?;
    std::fs::write(dir.join("Cargo.lock"), MANGA_CARGO_LOCK)
        .map_err(|err| format!("无法写入 OCR 助手锁文件：{err}"))?;
    std::fs::write(dir.join("src/main.rs"), MANGA_HELPER_SOURCE)
        .map_err(|err| format!("无法写入 OCR 助手源码：{err}"))?;

    let status = cargo_bin()
        .current_dir(&dir)
        .args(["build", "--release", "--locked"])
        .env("WNACG_OCR_MODELS_DIR", models_dir())
        .status()
        .map_err(|err| format!("未找到 cargo，本地漫画 OCR 需要 Rust 工具链：{err}"))?;
    if !status.success() {
        return Err("漫画 OCR 引擎编译失败，请确认已安装 Rust 工具链".to_string());
    }
    let built_bin = dir.join("target").join("release").join(binary_name);
    install_manga_helper_artifact(&dir, &built_bin, &bin)?;
    if let Err(error) = cleanup_manga_build_target(&dir) {
        eprintln!("{error}");
    }
    Ok(bin)
}

// ── 工作进程池 ───────────────────────────────────────────────────────────

fn spawn_worker(helper: &std::path::Path, engine: OcrEngine) -> Result<Worker, String> {
    let mut command = Command::new(helper);
    if engine == OcrEngine::Manga {
        command.env("WNACG_OCR_MODELS_DIR", models_dir());
    }
    hide_console(&mut command);
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
            let helper = ensure_manga_helper()?;
            ensure_manga_models()?;
            Ok(helper)
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

    static CACHE_TEST_SEQUENCE: AtomicUsize = AtomicUsize::new(1);

    fn test_manga_cache_dir() -> PathBuf {
        let sequence = CACHE_TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed) as u64;
        let unique = ((std::process::id() as u64) << 32) | sequence;
        std::env::temp_dir().join(format!("wnacg-ocr-manga-{unique:016x}"))
    }

    #[test]
    fn model_validation_checks_exact_size_and_sha256() {
        let path =
            std::env::temp_dir().join(format!("wnacg-model-validation-{}", std::process::id()));
        std::fs::write(&path, b"abc").unwrap();
        let model = ModelFile {
            name: "fixture",
            url: "https://example.invalid/fixture",
            bytes: 3,
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        };
        assert!(model_file_is_valid(&path, &model));
        std::fs::write(&path, b"abcd").unwrap();
        assert!(!model_file_is_valid(&path, &model));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn manga_helper_install_keeps_only_the_fixed_binary() {
        let cache_dir = test_manga_cache_dir();
        let target_dir = cache_dir.join("target");
        let release_dir = target_dir.join("release");
        std::fs::create_dir_all(&release_dir).unwrap();
        let built = release_dir.join(manga_helper_binary_name());
        let installed = cache_dir.join(manga_helper_binary_name());
        std::fs::write(&built, b"compiled helper fixture").unwrap();

        install_manga_helper_artifact(&cache_dir, &built, &installed).unwrap();
        cleanup_manga_build_target_in(&std::env::temp_dir(), &cache_dir, &cache_dir).unwrap();

        assert_eq!(
            std::fs::read(&installed).unwrap(),
            b"compiled helper fixture"
        );
        assert!(!target_dir.exists(), "成功安装后应删除 Cargo target 缓存");
        let files = std::fs::read_dir(&cache_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(files, vec![installed.file_name().unwrap()]);
        std::fs::remove_dir_all(cache_dir).unwrap();
    }

    #[test]
    fn failed_manga_helper_install_preserves_the_build_directory() {
        let cache_dir = test_manga_cache_dir();
        let target_dir = cache_dir.join("target");
        std::fs::create_dir_all(&target_dir).unwrap();
        let sentinel = target_dir.join("keep-on-failure");
        std::fs::write(&sentinel, b"keep").unwrap();
        let missing = target_dir.join("release").join(manga_helper_binary_name());
        let installed = cache_dir.join(manga_helper_binary_name());

        assert!(install_manga_helper_artifact(&cache_dir, &missing, &installed).is_err());
        assert!(sentinel.exists(), "安装失败时不得清理 target");
        assert!(!installed.exists());
        std::fs::remove_dir_all(cache_dir).unwrap();
    }

    #[test]
    fn manga_helper_cleanup_rejects_paths_outside_the_hashed_cache() {
        let temp_root = std::env::temp_dir();
        let valid = test_manga_cache_dir();
        assert!(is_scoped_manga_cache_dir(&temp_root, &valid));
        assert!(!is_scoped_manga_cache_dir(
            &temp_root,
            &temp_root.join("wnacg-ocr-vision-0123456789abcdef")
        ));
        assert!(!is_scoped_manga_cache_dir(
            &temp_root,
            &temp_root.join("nested/wnacg-ocr-manga-0123456789abcdef")
        ));
        assert!(!is_scoped_manga_cache_dir(
            &temp_root,
            &temp_root.join("wnacg-ocr-manga-too-short")
        ));

        let rejected = temp_root.join("wnacg-ocr-vision-0123456789abcdef");
        let sentinel = rejected.join("target/keep-outside-scope");
        std::fs::create_dir_all(sentinel.parent().unwrap()).unwrap();
        std::fs::write(&sentinel, b"keep").unwrap();
        assert!(cleanup_manga_build_target_in(&temp_root, &valid, &rejected).is_err());
        assert!(sentinel.exists(), "越界清理必须保持目标内容不变");
        std::fs::remove_dir_all(rejected).unwrap();
    }

    #[test]
    #[ignore = "requires WNACG_OCR_TEST_IMAGE and the downloaded manga OCR models"]
    fn manga_engine_detects_vertical_japanese() {
        let path = std::env::var("WNACG_OCR_TEST_IMAGE")
            .expect("请通过 WNACG_OCR_TEST_IMAGE 指定测试图片");
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
        assert!(output.error.is_none(), "OCR 报错: {:?}", output.error);
        assert!(
            output.regions.len() >= 2,
            "检测到的区域太少: {:?}",
            output.regions
        );
        let texts: Vec<&str> = output.regions.iter().map(|r| r.text.as_str()).collect();
        eprintln!("识别文本: {texts:?}");
        assert!(
            texts.iter().any(|t| t.contains("縦書き")),
            "应识别出竖排文字,实际: {texts:?}"
        );
    }

    #[test]
    #[ignore = "requires WNACG_OCR_TEST_IMAGE and the downloaded manga OCR models"]
    fn manga_engine_boxes_are_deterministic_between_passes() {
        let path = std::env::var("WNACG_OCR_TEST_IMAGE")
            .expect("请通过 WNACG_OCR_TEST_IMAGE 指定测试图片");
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
