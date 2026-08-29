use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::Duration;

const API_URL: &str = "https://api.deepseek.com/chat/completions";
const KEYCHAIN_SERVICE: &str = "com.yuxino.wnacg.translation";
const KEYCHAIN_ACCOUNT: &str = "deepseek-api-key";
const CHUNK_SIZE: usize = 30;
const MAX_TRANSLATION_ITEMS: usize = 512;
const MAX_TRANSLATION_ITEM_BYTES: usize = 16 * 1024;
const MAX_TRANSLATION_TOTAL_BYTES: usize = 512 * 1024;
const MAX_TRANSLATION_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;
const TRANSLATION_RESPONSE_TOO_LARGE: &str = "翻译响应超过 2 MiB 安全上限";
const TRANSLATION_REQUEST_CONCURRENCY: usize = 3;
const CACHE_VERSION: u32 = 1;
const CACHE_FILE_NAME: &str = "translation-cache-v1.json";
const CACHE_MAX_ENTRIES_PER_NAMESPACE: usize = 4_000;
const CACHE_MAX_CONTENT_BYTES: usize = 8 * 1024 * 1024;
const CACHE_MAX_FILE_BYTES: u64 = 12 * 1024 * 1024;
const LEGACY_CONFIG_MAX_FILE_BYTES: u64 = 1024 * 1024;
const CACHE_MAX_SOURCE_BYTES: usize = 16 * 1024;
const CACHE_MAX_TRANSLATION_BYTES: usize = 32 * 1024;

static TRANSLATION_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
static TRANSLATION_CACHE: OnceLock<Mutex<TranslationCache>> = OnceLock::new();
static TRANSLATION_CACHE_WRITE_LOCK: Mutex<()> = Mutex::new(());
static TRANSLATION_REQUEST_SEMAPHORE: LazyLock<tokio::sync::Semaphore> =
    LazyLock::new(|| tokio::sync::Semaphore::new(TRANSLATION_REQUEST_CONCURRENCY));

#[derive(Clone, Copy)]
enum ApiKeySource {
    Keychain,
    KeychainWithLegacy,
    Environment,
    LegacyConfig,
}

impl ApiKeySource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Keychain => "keychain",
            Self::KeychainWithLegacy => "keychain-with-legacy",
            Self::Environment => "environment",
            Self::LegacyConfig => "legacy-config",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CacheNamespace {
    Dialogue,
    Title,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry {
    translated: String,
    order: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct TranslationCache {
    version: u32,
    next_order: u64,
    dialogue: HashMap<String, CacheEntry>,
    title: HashMap<String, CacheEntry>,
}

impl Default for TranslationCache {
    fn default() -> Self {
        Self {
            version: CACHE_VERSION,
            next_order: 1,
            dialogue: HashMap::new(),
            title: HashMap::new(),
        }
    }
}

impl TranslationCache {
    fn map(&self, namespace: CacheNamespace) -> &HashMap<String, CacheEntry> {
        match namespace {
            CacheNamespace::Dialogue => &self.dialogue,
            CacheNamespace::Title => &self.title,
        }
    }

    fn map_mut(&mut self, namespace: CacheNamespace) -> &mut HashMap<String, CacheEntry> {
        match namespace {
            CacheNamespace::Dialogue => &mut self.dialogue,
            CacheNamespace::Title => &mut self.title,
        }
    }

    fn get(&self, namespace: CacheNamespace, source: &str) -> Option<&str> {
        self.map(namespace)
            .get(source)
            .map(|entry| entry.translated.as_str())
    }

    fn insert(&mut self, namespace: CacheNamespace, source: String, translated: String) -> bool {
        if source.is_empty()
            || translated.is_empty()
            || source.len() > CACHE_MAX_SOURCE_BYTES
            || translated.len() > CACHE_MAX_TRANSLATION_BYTES
        {
            return false;
        }
        if self.get(namespace, &source) == Some(translated.as_str()) {
            return false;
        }

        let order = self.next_order.max(1);
        self.next_order = order.saturating_add(1);
        self.map_mut(namespace)
            .insert(source, CacheEntry { translated, order });
        self.prune_with_limits(CACHE_MAX_ENTRIES_PER_NAMESPACE, CACHE_MAX_CONTENT_BYTES);
        true
    }

    fn sanitize_loaded(&mut self) {
        if self.version != CACHE_VERSION {
            *self = Self::default();
            return;
        }
        for map in [&mut self.dialogue, &mut self.title] {
            map.retain(|source, entry| {
                !source.is_empty()
                    && !entry.translated.is_empty()
                    && source.len() <= CACHE_MAX_SOURCE_BYTES
                    && entry.translated.len() <= CACHE_MAX_TRANSLATION_BYTES
            });
        }
        let max_order = self
            .dialogue
            .values()
            .chain(self.title.values())
            .map(|entry| entry.order)
            .max()
            .unwrap_or(0);
        self.next_order = self.next_order.max(max_order.saturating_add(1)).max(1);
        self.prune_with_limits(CACHE_MAX_ENTRIES_PER_NAMESPACE, CACHE_MAX_CONTENT_BYTES);
    }

    fn prune_with_limits(&mut self, max_entries_per_namespace: usize, max_content_bytes: usize) {
        fn prune_map(map: &mut HashMap<String, CacheEntry>, max_entries: usize) {
            if map.len() <= max_entries {
                return;
            }
            let mut oldest: Vec<(u64, String)> = map
                .iter()
                .map(|(source, entry)| (entry.order, source.clone()))
                .collect();
            oldest.sort_by_key(|(order, _)| *order);
            for (_, source) in oldest.into_iter().take(map.len() - max_entries) {
                map.remove(&source);
            }
        }

        prune_map(&mut self.dialogue, max_entries_per_namespace);
        prune_map(&mut self.title, max_entries_per_namespace);

        let mut content_bytes = self.estimated_content_bytes();
        if content_bytes <= max_content_bytes {
            return;
        }
        let mut oldest: Vec<(u64, CacheNamespace, String, usize)> = self
            .dialogue
            .iter()
            .map(|(source, entry)| {
                (
                    entry.order,
                    CacheNamespace::Dialogue,
                    source.clone(),
                    estimated_entry_bytes(source, entry),
                )
            })
            .chain(self.title.iter().map(|(source, entry)| {
                (
                    entry.order,
                    CacheNamespace::Title,
                    source.clone(),
                    estimated_entry_bytes(source, entry),
                )
            }))
            .collect();
        oldest.sort_by_key(|(order, _, _, _)| *order);
        for (_, namespace, source, entry_bytes) in oldest {
            if content_bytes <= max_content_bytes {
                break;
            }
            if self.map_mut(namespace).remove(&source).is_some() {
                content_bytes = content_bytes.saturating_sub(entry_bytes);
            }
        }
    }

    fn estimated_content_bytes(&self) -> usize {
        self.dialogue
            .iter()
            .chain(self.title.iter())
            .map(|(source, entry)| estimated_entry_bytes(source, entry))
            .sum()
    }
}

fn estimated_entry_bytes(source: &str, entry: &CacheEntry) -> usize {
    source
        .len()
        .saturating_add(entry.translated.len())
        .saturating_add(64)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingText {
    id: usize,
    source: String,
    offsets: Vec<usize>,
}

fn config_dir() -> std::path::PathBuf {
    dirs::data_local_dir()
        .map(|path| path.join("wnacg"))
        .or_else(|| dirs::home_dir().map(|path| path.join(".wnacg")))
        .unwrap_or_else(|| std::env::temp_dir().join("wnacg"))
}

fn cache_path() -> PathBuf {
    config_dir().join(CACHE_FILE_NAME)
}

fn cache_temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(CACHE_FILE_NAME);
    path.with_file_name(format!(".{name}.{}.tmp", std::process::id()))
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|err| format!("无法创建翻译缓存目录：{err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|err| format!("无法保护翻译缓存目录：{err}"))?;
    }
    Ok(())
}

fn ensure_private_file(_path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|err| format!("无法保护本地数据文件：{err}"))?;
    }
    Ok(())
}

fn load_cache_from_path(path: &Path) -> TranslationCache {
    let Ok(metadata) = std::fs::metadata(path) else {
        return TranslationCache::default();
    };
    if let Err(error) = ensure_private_file(path) {
        eprintln!("{error}");
        return TranslationCache::default();
    }
    if metadata.len() > CACHE_MAX_FILE_BYTES {
        return TranslationCache::default();
    }
    let Ok(bytes) = std::fs::read(path) else {
        return TranslationCache::default();
    };
    let Ok(mut cache) = serde_json::from_slice::<TranslationCache>(&bytes) else {
        return TranslationCache::default();
    };
    cache.sanitize_loaded();
    cache
}

fn write_cache_to_path(cache: &TranslationCache, path: &Path) -> Result<(), String> {
    let bytes = serde_json::to_vec(cache).map_err(|err| format!("翻译缓存序列化失败：{err}"))?;
    if bytes.len() as u64 > CACHE_MAX_FILE_BYTES {
        return Err("翻译缓存超过安全上限".to_string());
    }
    let parent = path.parent().ok_or("翻译缓存路径无效")?;
    ensure_private_directory(parent)?;
    let temp_path = cache_temp_path(path);
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp_path)
            .map_err(|err| format!("无法创建翻译缓存临时文件：{err}"))?;
        file.write_all(&bytes)
            .map_err(|err| format!("无法写入翻译缓存：{err}"))?;
        file.sync_all()
            .map_err(|err| format!("无法同步翻译缓存：{err}"))?;
        std::fs::rename(&temp_path, path).map_err(|err| format!("无法原子替换翻译缓存：{err}"))?;
        ensure_private_file(path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

fn remove_legacy_api_key(path: &Path, mut value: serde_json::Value) -> Result<(), String> {
    let object = value
        .as_object_mut()
        .ok_or("旧版配置不是有效的 JSON 对象")?;
    object.remove("deepseekApiKey");
    let bytes =
        serde_json::to_vec_pretty(&value).map_err(|err| format!("旧版配置序列化失败：{err}"))?;
    if bytes.len() as u64 > LEGACY_CONFIG_MAX_FILE_BYTES {
        return Err("旧版配置超过安全上限".to_string());
    }

    let parent = path.parent().ok_or("旧版配置路径无效")?;
    ensure_private_directory(parent)?;
    let temp_path = cache_temp_path(path);
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp_path)
            .map_err(|err| format!("无法创建旧版配置临时文件：{err}"))?;
        file.write_all(&bytes)
            .map_err(|err| format!("无法清理旧版配置：{err}"))?;
        file.sync_all()
            .map_err(|err| format!("无法同步旧版配置：{err}"))?;
        std::fs::rename(&temp_path, path).map_err(|err| format!("无法原子替换旧版配置：{err}"))?;
        ensure_private_file(path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

fn legacy_key_remains_after_cleanup(path: &Path, keychain_key: &str) -> Result<bool, String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("无法检查旧版配置：{error}")),
    };
    if metadata.len() > LEGACY_CONFIG_MAX_FILE_BYTES {
        return Err("旧版配置超过安全上限".to_string());
    }
    ensure_private_file(path)?;
    let content =
        std::fs::read_to_string(path).map_err(|error| format!("无法读取旧版配置：{error}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|error| format!("旧版配置 JSON 无效：{error}"))?;
    let Some(legacy_key) = value.get("deepseekApiKey").and_then(|value| value.as_str()) else {
        return Ok(false);
    };
    let legacy_key = legacy_key.trim();
    if legacy_key.is_empty() {
        return Ok(false);
    }
    if legacy_key != keychain_key {
        return Ok(true);
    }
    remove_legacy_api_key(path, value)?;
    Ok(false)
}

fn remove_legacy_api_key_if_present(path: &Path) -> Result<(), String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("无法检查旧版配置：{error}")),
    };
    if metadata.len() > LEGACY_CONFIG_MAX_FILE_BYTES {
        return Err("旧版配置超过安全上限".to_string());
    }
    ensure_private_file(path)?;
    let content =
        std::fs::read_to_string(path).map_err(|error| format!("无法读取旧版配置：{error}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|error| format!("旧版配置 JSON 无效：{error}"))?;
    if value.get("deepseekApiKey").is_some() {
        remove_legacy_api_key(path, value)?;
    }
    Ok(())
}

fn translation_cache() -> &'static Mutex<TranslationCache> {
    TRANSLATION_CACHE.get_or_init(|| Mutex::new(load_cache_from_path(&cache_path())))
}

fn persist_translation_cache() -> Result<(), String> {
    let _write_guard = TRANSLATION_CACHE_WRITE_LOCK
        .lock()
        .map_err(|_| "翻译缓存写入锁异常".to_string())?;
    let snapshot = translation_cache()
        .lock()
        .map_err(|_| "翻译缓存锁异常".to_string())?
        .clone();
    write_cache_to_path(&snapshot, &cache_path())
}

fn translation_client() -> Result<&'static reqwest::Client, String> {
    match TRANSLATION_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(90))
            .pool_idle_timeout(Duration::from_secs(120))
            .pool_max_idle_per_host(8)
            .tcp_keepalive(Duration::from_secs(30))
            .build()
            .map_err(|err| format!("翻译 HTTP 客户端创建失败：{err}"))
    }) {
        Ok(client) => Ok(client),
        Err(err) => Err(err.clone()),
    }
}

fn validate_translation_input(texts: &[String]) -> Result<(), String> {
    if texts.len() > MAX_TRANSLATION_ITEMS {
        return Err(format!("单次翻译最多支持 {MAX_TRANSLATION_ITEMS} 条文本"));
    }
    if texts
        .iter()
        .any(|text| text.len() > MAX_TRANSLATION_ITEM_BYTES)
    {
        return Err(format!(
            "单条翻译文本不能超过 {} KiB",
            MAX_TRANSLATION_ITEM_BYTES / 1024
        ));
    }
    let total_bytes = texts
        .iter()
        .try_fold(0_usize, |total, text| total.checked_add(text.len()))
        .ok_or("翻译文本总长度溢出")?;
    if total_bytes > MAX_TRANSLATION_TOTAL_BYTES {
        return Err(format!(
            "单次翻译文本总量不能超过 {} KiB",
            MAX_TRANSLATION_TOTAL_BYTES / 1024
        ));
    }
    Ok(())
}

fn prepare_batch(
    cache: &TranslationCache,
    namespace: CacheNamespace,
    texts: &[String],
) -> (Vec<String>, Vec<PendingText>) {
    let mut results = vec![String::new(); texts.len()];
    let mut pending = Vec::<PendingText>::new();
    let mut pending_by_source = HashMap::<String, usize>::new();

    for (offset, source) in texts.iter().enumerate() {
        if let Some(cached) = cache.get(namespace, source) {
            results[offset] = cached.to_string();
            continue;
        }
        if let Some(pending_index) = pending_by_source.get(source).copied() {
            pending[pending_index].offsets.push(offset);
            continue;
        }

        let pending_index = pending.len();
        pending_by_source.insert(source.clone(), pending_index);
        pending.push(PendingText {
            id: pending_index,
            source: source.clone(),
            offsets: vec![offset],
        });
    }

    (results, pending)
}

fn store_cache_updates(
    namespace: CacheNamespace,
    updates: &[(String, String)],
) -> Result<(), String> {
    if updates.is_empty() {
        return Ok(());
    }
    let changed = {
        let mut cache = translation_cache()
            .lock()
            .map_err(|_| "翻译缓存锁异常".to_string())?;
        updates.iter().fold(false, |changed, (source, translated)| {
            cache.insert(namespace, source.clone(), translated.clone()) || changed
        })
    };
    if changed {
        if let Err(err) = persist_translation_cache() {
            eprintln!("{err}");
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn keychain_api_key() -> Result<Option<String>, String> {
    use security_framework::os::macos::keychain::SecKeychain;

    let keychain =
        SecKeychain::default().map_err(|error| format!("无法打开 macOS 默认钥匙串：{error}"))?;
    match keychain.find_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok((password, _)) => {
            let key = std::str::from_utf8(password.as_ref())
                .map_err(|_| "钥匙串中的 DeepSeek 密钥格式无效".to_string())?
                .trim()
                .to_string();
            Ok((!key.is_empty()).then_some(key))
        }
        Err(error) if error.code() == -25300 => Ok(None),
        Err(error) => Err(format!("无法读取 macOS 钥匙串：{error}")),
    }
}

#[cfg(target_os = "windows")]
fn keychain_api_key() -> Result<Option<String>, String> {
    credential_manager::read(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn keychain_api_key() -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(target_os = "macos")]
fn save_api_key_to_keychain(key: &str) -> Result<(), String> {
    use security_framework::os::macos::keychain::SecKeychain;

    SecKeychain::default()
        .and_then(|keychain| {
            keychain.set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, key.as_bytes())
        })
        .map_err(|error| format!("无法保存到 macOS 钥匙串：{error}"))
}

#[cfg(target_os = "windows")]
fn save_api_key_to_keychain(key: &str) -> Result<(), String> {
    credential_manager::save(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, key)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn save_api_key_to_keychain(_key: &str) -> Result<(), String> {
    Err("当前系统暂不支持安全保存 DeepSeek 密钥".to_string())
}

/// Windows 凭据管理器实现，提供与 macOS 钥匙串等价的安全凭据存储。
#[cfg(target_os = "windows")]
mod credential_manager {
    use std::ffi::c_void;

    use windows_sys::core::PWSTR;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{
        CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    fn target_name(service: &str, account: &str) -> Vec<u16> {
        let mut wide: Vec<u16> = format!("{service}/{account}").encode_utf16().collect();
        wide.push(0);
        wide
    }

    fn error_message(code: u32) -> String {
        std::io::Error::from_raw_os_error(code as i32).to_string()
    }

    pub fn save(service: &str, account: &str, key: &str) -> Result<(), String> {
        let target = target_name(service, account);
        let mut blob = key.as_bytes().to_vec();
        let mut credential: CREDENTIALW = unsafe { std::mem::zeroed() };
        credential.Type = CRED_TYPE_GENERIC;
        credential.TargetName = target.as_ptr() as PWSTR;
        credential.CredentialBlobSize = blob.len() as u32;
        credential.CredentialBlob = blob.as_mut_ptr();
        credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
        if unsafe { CredWriteW(&credential, 0) } == 0 {
            return Err(format!(
                "无法保存到 Windows 凭据管理器：{}",
                error_message(unsafe { GetLastError() })
            ));
        }
        Ok(())
    }

    pub fn read(service: &str, account: &str) -> Result<Option<String>, String> {
        let target = target_name(service, account);
        let mut credential_ptr: *mut CREDENTIALW = std::ptr::null_mut();
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential_ptr) } == 0 {
            let error = unsafe { GetLastError() };
            if error == ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err(format!(
                "无法读取 Windows 凭据管理器：{}",
                error_message(error)
            ));
        }
        if credential_ptr.is_null() {
            return Ok(None);
        }
        let credential = unsafe { &*credential_ptr };
        let result = if credential.CredentialBlob.is_null() || credential.CredentialBlobSize == 0 {
            Ok(None)
        } else {
            let bytes = unsafe {
                std::slice::from_raw_parts(
                    credential.CredentialBlob,
                    credential.CredentialBlobSize as usize,
                )
            };
            match std::str::from_utf8(bytes) {
                Ok(key) => {
                    let key = key.trim().to_string();
                    Ok((!key.is_empty()).then_some(key))
                }
                Err(_) => Err("凭据管理器中的 DeepSeek 密钥格式无效".to_string()),
            }
        };
        unsafe { CredFree(credential_ptr as *const c_void) };
        result
    }
}

fn keychain_contains(key: &str) -> bool {
    keychain_api_key()
        .ok()
        .flatten()
        .is_some_and(|stored| stored == key)
}

fn keychain_source_after_legacy_cleanup(key: &str) -> ApiKeySource {
    let legacy_path = config_dir().join("config.json");
    match legacy_key_remains_after_cleanup(&legacy_path, key) {
        Ok(false) => ApiKeySource::Keychain,
        Ok(true) => ApiKeySource::KeychainWithLegacy,
        Err(error) => {
            eprintln!("DeepSeek 旧版明文密钥清理失败：{error}");
            ApiKeySource::KeychainWithLegacy
        }
    }
}

fn api_key_with_source() -> Result<(String, ApiKeySource), String> {
    if let Some(key) = keychain_api_key()? {
        let source = keychain_source_after_legacy_cleanup(&key);
        return Ok((key, source));
    }
    if let Ok(key) = std::env::var("DEEPSEEK_API_KEY") {
        if !key.trim().is_empty() {
            let key = key.trim().to_string();
            match save_api_key_to_keychain(&key) {
                Ok(()) if keychain_contains(&key) => {
                    let source = keychain_source_after_legacy_cleanup(&key);
                    return Ok((key, source));
                }
                Ok(()) => {
                    eprintln!("DeepSeek 环境变量密钥写入安全凭据存储后未能回读确认");
                }
                Err(error) => {
                    eprintln!("DeepSeek 环境变量密钥迁移失败：{error}");
                }
            }
            return Ok((key, ApiKeySource::Environment));
        }
    }
    let path = config_dir().join("config.json");
    if std::fs::metadata(&path)
        .ok()
        .is_some_and(|metadata| metadata.len() <= LEGACY_CONFIG_MAX_FILE_BYTES)
    {
        ensure_private_file(&path)?;
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(key) = value.get("deepseekApiKey").and_then(|v| v.as_str()) {
                    if !key.trim().is_empty() {
                        let key = key.trim().to_string();
                        if save_api_key_to_keychain(&key).is_ok() && keychain_contains(&key) {
                            remove_legacy_api_key(&path, value)?;
                            return Ok((key, ApiKeySource::Keychain));
                        }
                        return Ok((key, ApiKeySource::LegacyConfig));
                    }
                }
            }
        }
    }
    Err("未找到 DeepSeek API 密钥，请在阅读设置中保存密钥".to_string())
}

fn api_key() -> Result<String, String> {
    api_key_with_source().map(|(key, _)| key)
}

/// 将 DeepSeek 密钥保存到操作系统的安全凭据存储中。
#[tauri::command]
pub fn set_deepseek_api_key(api_key: String) -> Result<(), String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("DeepSeek API 密钥不能为空".to_string());
    }
    save_api_key_to_keychain(key)?;
    if !keychain_contains(key) {
        return Err("密钥写入钥匙串后未能回读确认".to_string());
    }
    remove_legacy_api_key_if_present(&config_dir().join("config.json"))
        .map_err(|error| format!("密钥已保存到钥匙串，但旧版明文清理失败：{error}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: Message,
}

#[derive(Debug, Deserialize)]
struct Message {
    content: String,
}

async fn read_translation_body<S, B, E>(
    status: reqwest::StatusCode,
    total: Option<u64>,
    stream: S,
) -> Result<String, String>
where
    S: futures_util::Stream<Item = Result<B, E>>,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    if total.is_some_and(|total| total > MAX_TRANSLATION_RESPONSE_BYTES) {
        return Err(TRANSLATION_RESPONSE_TOO_LARGE.to_string());
    }

    let mut body =
        Vec::with_capacity(total.unwrap_or(0).min(MAX_TRANSLATION_RESPONSE_BYTES) as usize);
    use futures_util::StreamExt as _;
    futures_util::pin_mut!(stream);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| format!("翻译响应读取失败：{err}"))?;
        let chunk = chunk.as_ref();
        if (body.len() as u64).saturating_add(chunk.len() as u64) > MAX_TRANSLATION_RESPONSE_BYTES {
            return Err(TRANSLATION_RESPONSE_TOO_LARGE.to_string());
        }
        body.extend_from_slice(chunk);
    }
    let body = String::from_utf8_lossy(&body).into_owned();
    if !status.is_success() {
        let preview: String = body.chars().take(200).collect();
        return Err(format!("翻译接口返回 {status}: {preview}"));
    }
    Ok(body)
}

async fn read_translation_response(response: reqwest::Response) -> Result<String, String> {
    let status = response.status();
    let total = response.content_length();
    read_translation_body(status, total, response.bytes_stream()).await
}

async fn translate_chunk(
    client: &reqwest::Client,
    key: &str,
    items: Vec<(usize, String)>,
    system_prompt: &str,
) -> Result<HashMap<usize, String>, String> {
    let payload = serde_json::json!({
        "model": "deepseek-chat",
        "temperature": 0.3,
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "system",
                "content": system_prompt
            },
            {
                "role": "user",
                "content": format!(
                    "请逐条翻译下面的日文台词，输出 JSON 对象：{{\"results\":[{{\"i\":序号,\"t\":\"译文\"}}]}}\n台词：{}",
                    serde_json::to_string(
                        &items.iter().map(|(i, t)| serde_json::json!({"i": i, "t": t})).collect::<Vec<_>>()
                    )
                    .map_err(|e| e.to_string())?
                )
            }
        ]
    });

    let _request_permit = TRANSLATION_REQUEST_SEMAPHORE
        .acquire()
        .await
        .map_err(|_| "翻译请求队列已关闭".to_string())?;
    let response = client
        .post(API_URL)
        .bearer_auth(key)
        .json(&payload)
        .timeout(Duration::from_secs(90))
        .send()
        .await
        .map_err(|err| format!("翻译请求失败：{err}"))?;
    let body = read_translation_response(response).await?;
    let parsed: ChatResponse =
        serde_json::from_str(&body).map_err(|err| format!("翻译响应解析失败：{err}"))?;
    let content = parsed
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .ok_or("翻译响应为空")?;
    let json: serde_json::Value =
        serde_json::from_str(&content).map_err(|err| format!("翻译内容解析失败：{err}"))?;
    let results = json
        .get("results")
        .and_then(|v| v.as_array())
        .ok_or("翻译内容缺少 results 字段")?;
    let mut map = HashMap::new();
    for entry in results {
        let Some(index) = entry.get("i").and_then(|v| v.as_u64()) else {
            continue;
        };
        let text = entry
            .get("t")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        map.insert(index as usize, text);
    }
    Ok(map)
}

/// 批量翻译日文台词为简体中文,按输入顺序返回。
/// 已翻译过的文本会走本地缓存,不重复请求。
#[tauri::command]
pub async fn translate_dialogue(texts: Vec<String>) -> Result<Vec<String>, String> {
    const DIALOGUE_PROMPT: &str =
        "你是专业日漫翻译。把日文台词翻译成简体中文口语，保留语气与拟声词，不要加解释、不要输出多余文字。";
    translate_batch(texts, DIALOGUE_PROMPT, CacheNamespace::Dialogue).await
}

/// 批量翻译漫画标题(生肉日文标题 → 简体中文),按输入顺序返回。
/// 方括号 [ ] 内的作者/社团/标签保持原文,圆括号内日文系列名翻译。
#[tauri::command]
pub async fn translate_titles(titles: Vec<String>) -> Result<Vec<String>, String> {
    const TITLE_PROMPT: &str = "你是漫画网站的编辑。把日文漫画标题翻译成简体中文：\
        1) 方括号 [ ] 内的内容(作者名、社团名、标签、DL版等)保持原文不译；\
        2) 圆括号 ( ) 内的系列名若为日文则翻译，英文保持原文；\
        3) 只输出流畅自然的标题译文，不要加解释、不要输出原文。";
    translate_batch(titles, TITLE_PROMPT, CacheNamespace::Title).await
}

async fn translate_batch(
    texts: Vec<String>,
    system_prompt: &str,
    namespace: CacheNamespace,
) -> Result<Vec<String>, String> {
    validate_translation_input(&texts)?;
    let (mut results, pending) = {
        let cache = translation_cache()
            .lock()
            .map_err(|_| "翻译缓存锁异常".to_string())?;
        prepare_batch(&cache, namespace, &texts)
    };
    if pending.is_empty() {
        return Ok(results);
    }

    let key = api_key()?;
    let key_ref = key.as_str();
    let client = translation_client()?;

    use futures_util::StreamExt as _;
    let pending_chunks = pending
        .chunks(CHUNK_SIZE)
        .map(<[PendingText]>::to_vec)
        .collect::<Vec<_>>();
    let mut chunk_results = futures_util::stream::iter(pending_chunks.into_iter().enumerate())
        .map(|(chunk_index, chunk)| {
            let items = chunk
                .iter()
                .map(|item| (item.id, item.source.clone()))
                .collect();
            async move {
                (
                    chunk_index,
                    chunk,
                    translate_chunk(client, key_ref, items, system_prompt).await,
                )
            }
        })
        .buffer_unordered(TRANSLATION_REQUEST_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    chunk_results.sort_by_key(|(chunk_index, _, _)| *chunk_index);

    let mut cache_updates = Vec::<(String, String)>::new();
    for (_, chunk_meta, chunk_result) in chunk_results {
        match chunk_result {
            Ok(map) => {
                for item in chunk_meta {
                    let translated = map.get(&item.id).cloned().unwrap_or_default();
                    if !translated.is_empty() {
                        cache_updates.push((item.source, translated.clone()));
                    }
                    for offset in item.offsets {
                        results[offset] = translated.clone();
                    }
                }
            }
            Err(err) => {
                let _ = store_cache_updates(namespace, &cache_updates);
                return Err(err);
            }
        }
    }
    store_cache_updates(namespace, &cache_updates)?;

    Ok(results)
}

/// 检查翻译密钥是否可用
#[tauri::command]
pub async fn translate_engine_status() -> Result<String, String> {
    let (_, source) = api_key_with_source()?;
    Ok(source.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_DIR_SEQUENCE: AtomicUsize = AtomicUsize::new(1);

    fn test_cache_path(name: &str) -> PathBuf {
        let sequence = TEST_DIR_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir()
            .join(format!(
                "wnacg-translate-test-{}-{sequence}",
                std::process::id()
            ))
            .join(name)
    }

    fn read_test_translation_response(
        status: reqwest::StatusCode,
        content_length: Option<u64>,
        chunks: Vec<Vec<u8>>,
    ) -> Result<String, String> {
        tauri::async_runtime::block_on(read_translation_body(
            status,
            content_length,
            futures_util::stream::iter(chunks.into_iter().map(Ok::<_, &'static str>)),
        ))
    }

    #[test]
    fn translation_client_is_reused_without_network_access() {
        let first = translation_client().expect("应创建翻译客户端") as *const reqwest::Client;
        let second = translation_client().expect("应复用翻译客户端") as *const reqwest::Client;
        assert_eq!(first, second);
    }

    #[test]
    fn translation_response_below_limit_is_accepted() {
        let body = vec![b'a'; MAX_TRANSLATION_RESPONSE_BYTES as usize - 1];

        let received =
            read_test_translation_response(reqwest::StatusCode::OK, None, vec![body.clone()])
                .expect("低于上限的响应应成功读取");

        assert_eq!(received.as_bytes(), body);
    }

    #[test]
    fn translation_response_at_limit_is_accepted() {
        let body = vec![b'a'; MAX_TRANSLATION_RESPONSE_BYTES as usize];

        let received = read_test_translation_response(
            reqwest::StatusCode::OK,
            Some(MAX_TRANSLATION_RESPONSE_BYTES),
            vec![body.clone()],
        )
        .expect("等于上限的响应应成功读取");

        assert_eq!(received.as_bytes(), body);
    }

    #[test]
    fn translation_response_content_length_above_limit_is_rejected() {
        let error = read_test_translation_response(
            reqwest::StatusCode::OK,
            Some(MAX_TRANSLATION_RESPONSE_BYTES + 1),
            vec![],
        )
        .expect_err("超大 Content-Length 应被预先拒绝");

        assert_eq!(error, TRANSLATION_RESPONSE_TOO_LARGE);
    }

    #[test]
    fn translation_response_stream_above_limit_is_rejected() {
        let chunks = vec![
            vec![b'a'; MAX_TRANSLATION_RESPONSE_BYTES as usize],
            vec![b'b'],
        ];

        let error = read_test_translation_response(reqwest::StatusCode::OK, None, chunks)
            .expect_err("累计超限的分块响应应被拒绝");

        assert_eq!(error, TRANSLATION_RESPONSE_TOO_LARGE);
    }

    #[test]
    fn translation_response_error_keeps_status_and_preview() {
        let body = b"rate limited".to_vec();
        let error = read_test_translation_response(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            Some(body.len() as u64),
            vec![body],
        )
        .expect_err("错误响应应保留状态与摘要");

        assert_eq!(error, "翻译接口返回 429 Too Many Requests: rate limited");
    }

    #[test]
    fn translation_input_limits_bound_paid_requests() {
        let too_many = vec!["a".to_string(); MAX_TRANSLATION_ITEMS + 1];
        assert!(validate_translation_input(&too_many).is_err());

        let oversized_item = vec!["a".repeat(MAX_TRANSLATION_ITEM_BYTES + 1)];
        assert!(validate_translation_input(&oversized_item).is_err());

        let within_limits = vec!["短い台詞".to_string(); 30];
        assert!(validate_translation_input(&within_limits).is_ok());
    }

    #[test]
    fn cache_namespaces_keep_dialogue_and_title_separate() {
        let mut cache = TranslationCache::default();
        assert!(cache.insert(
            CacheNamespace::Dialogue,
            "同じ原文".to_string(),
            "对白译文".to_string(),
        ));
        assert!(cache.insert(
            CacheNamespace::Title,
            "同じ原文".to_string(),
            "标题译文".to_string(),
        ));

        assert_eq!(
            cache.get(CacheNamespace::Dialogue, "同じ原文"),
            Some("对白译文")
        );
        assert_eq!(
            cache.get(CacheNamespace::Title, "同じ原文"),
            Some("标题译文")
        );
    }

    #[test]
    fn prepare_batch_deduplicates_uncached_sources_and_preserves_offsets() {
        let mut cache = TranslationCache::default();
        cache.insert(
            CacheNamespace::Dialogue,
            "缓存命中".to_string(),
            "已翻译".to_string(),
        );
        let texts = vec![
            "重复".to_string(),
            "缓存命中".to_string(),
            "重复".to_string(),
            "另一个".to_string(),
            "重复".to_string(),
        ];

        let (results, pending) = prepare_batch(&cache, CacheNamespace::Dialogue, &texts);

        assert_eq!(results, vec!["", "已翻译", "", "", ""]);
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].source, "重复");
        assert_eq!(pending[0].offsets, vec![0, 2, 4]);
        assert_eq!(pending[1].source, "另一个");
        assert_eq!(pending[1].offsets, vec![3]);
    }

    #[test]
    fn cache_prunes_oldest_entries_per_namespace() {
        let mut cache = TranslationCache::default();
        for source in ["第一条", "第二条", "第三条"] {
            cache.insert(
                CacheNamespace::Dialogue,
                source.to_string(),
                format!("{source}译文"),
            );
        }

        cache.prune_with_limits(2, usize::MAX);

        assert_eq!(cache.dialogue.len(), 2);
        assert!(cache.get(CacheNamespace::Dialogue, "第一条").is_none());
        assert!(cache.get(CacheNamespace::Dialogue, "第二条").is_some());
        assert!(cache.get(CacheNamespace::Dialogue, "第三条").is_some());
    }

    #[test]
    fn cache_enforces_entry_and_content_size_limits() {
        let mut cache = TranslationCache::default();
        assert!(!cache.insert(
            CacheNamespace::Dialogue,
            "原".repeat(CACHE_MAX_SOURCE_BYTES + 1),
            "译文".to_string(),
        ));
        assert!(!cache.insert(
            CacheNamespace::Dialogue,
            "原文".to_string(),
            "译".repeat(CACHE_MAX_TRANSLATION_BYTES + 1),
        ));

        for source in ["第一条", "第二条", "第三条"] {
            cache.insert(
                CacheNamespace::Dialogue,
                source.to_string(),
                format!("{source}译文"),
            );
        }
        let two_entries = cache
            .dialogue
            .iter()
            .filter(|(source, _)| source.as_str() != "第一条")
            .map(|(source, entry)| estimated_entry_bytes(source, entry))
            .sum();

        cache.prune_with_limits(10, two_entries);

        assert!(cache.estimated_content_bytes() <= two_entries);
        assert!(cache.get(CacheNamespace::Dialogue, "第一条").is_none());
    }

    #[test]
    fn cache_round_trip_uses_atomic_temp_file() {
        let path = test_cache_path(CACHE_FILE_NAME);
        let temp_path = cache_temp_path(&path);
        let mut cache = TranslationCache::default();
        cache.insert(
            CacheNamespace::Dialogue,
            "また明日".to_string(),
            "明天见".to_string(),
        );
        cache.insert(
            CacheNamespace::Title,
            "漫画タイトル".to_string(),
            "漫画标题".to_string(),
        );

        write_cache_to_path(&cache, &path).expect("缓存应原子落盘");
        cache.insert(
            CacheNamespace::Dialogue,
            "また明日".to_string(),
            "明天再见".to_string(),
        );
        write_cache_to_path(&cache, &path).expect("缓存应能原子替换已有文件");
        let loaded = load_cache_from_path(&path);

        assert_eq!(
            loaded.get(CacheNamespace::Dialogue, "また明日"),
            Some("明天再见")
        );
        assert_eq!(
            loaded.get(CacheNamespace::Title, "漫画タイトル"),
            Some("漫画标题")
        );
        assert!(!temp_path.exists(), "成功写入后不应残留临时文件");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let file_mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            let directory_mode = std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(file_mode, 0o600);
            assert_eq!(directory_mode, 0o700);
        }

        if let Some(parent) = path.parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn legacy_config_cleanup_preserves_unrelated_fields() {
        let path = test_cache_path("config.json");
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent).unwrap();
        let value = serde_json::json!({
            "deepseekApiKey": "test-only-secret",
            "readerMode": "spread"
        });
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();

        remove_legacy_api_key(&path, value).expect("应清理旧版明文密钥");
        let stored: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(stored.get("deepseekApiKey").is_none());
        assert_eq!(
            stored.get("readerMode").and_then(|value| value.as_str()),
            Some("spread")
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = std::fs::remove_dir_all(parent);
    }

    #[test]
    fn existing_keychain_value_cleans_only_the_matching_legacy_key() {
        let path = test_cache_path("config.json");
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent).unwrap();
        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "deepseekApiKey": "same-key",
                "readerMode": "spread"
            }))
            .unwrap(),
        )
        .unwrap();

        assert!(!legacy_key_remains_after_cleanup(&path, "same-key").unwrap());
        let cleaned: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(cleaned.get("deepseekApiKey").is_none());
        assert_eq!(
            cleaned.get("readerMode").and_then(|value| value.as_str()),
            Some("spread")
        );

        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({ "deepseekApiKey": "different-key" })).unwrap(),
        )
        .unwrap();
        assert!(legacy_key_remains_after_cleanup(&path, "same-key").unwrap());
        let preserved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            preserved
                .get("deepseekApiKey")
                .and_then(|value| value.as_str()),
            Some("different-key")
        );

        remove_legacy_api_key_if_present(&path).unwrap();
        let replaced: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(replaced.get("deepseekApiKey").is_none());

        let _ = std::fs::remove_dir_all(parent);
    }

    #[test]
    #[ignore = "requires a DeepSeek API key and network access"]
    fn deepseek_translate_dialogue() {
        let texts = vec!["また明日ね！".to_string(), "ちょっと待って…".to_string()];
        let results =
            tauri::async_runtime::block_on(translate_dialogue(texts)).expect("翻译应成功");
        assert_eq!(results.len(), 2);
        eprintln!("译文: {results:?}");
        assert!(!results[0].trim().is_empty(), "第一条译文为空");
    }

    #[test]
    #[ignore = "requires a DeepSeek API key and network access"]
    fn deepseek_translate_titles() {
        let titles = vec![
            "[板野ちはる] 常夫さんには内緒にしておいて下さい (ガールズ&パンツァー)".to_string(),
            "[スライム企画 (栗柚くりゅー)] ブルアカぼん。5 (ブルーアーカイブ) [DL版]".to_string(),
        ];
        let results =
            tauri::async_runtime::block_on(translate_titles(titles)).expect("标题翻译应成功");
        assert_eq!(results.len(), 2);
        eprintln!("标题译文: {results:?}");
        assert!(!results[0].trim().is_empty(), "第一条标题译文为空");
    }
}
