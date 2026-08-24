use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const API_URL: &str = "https://api.deepseek.com/chat/completions";
const CHUNK_SIZE: usize = 30;
const CACHE_VERSION: u32 = 1;
const CACHE_FILE_NAME: &str = "translation-cache-v1.json";
const CACHE_MAX_ENTRIES_PER_NAMESPACE: usize = 4_000;
const CACHE_MAX_CONTENT_BYTES: usize = 8 * 1024 * 1024;
const CACHE_MAX_FILE_BYTES: u64 = 12 * 1024 * 1024;
const CACHE_MAX_SOURCE_BYTES: usize = 16 * 1024;
const CACHE_MAX_TRANSLATION_BYTES: usize = 32 * 1024;

static TRANSLATION_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
static TRANSLATION_CACHE: OnceLock<Mutex<TranslationCache>> = OnceLock::new();
static TRANSLATION_CACHE_WRITE_LOCK: Mutex<()> = Mutex::new(());

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
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("wnacg")
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

fn load_cache_from_path(path: &Path) -> TranslationCache {
    let Ok(metadata) = std::fs::metadata(path) else {
        return TranslationCache::default();
    };
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
    std::fs::create_dir_all(parent).map_err(|err| format!("无法创建翻译缓存目录：{err}"))?;
    let temp_path = cache_temp_path(path);
    let result = (|| {
        let mut file = std::fs::File::create(&temp_path)
            .map_err(|err| format!("无法创建翻译缓存临时文件：{err}"))?;
        file.write_all(&bytes)
            .map_err(|err| format!("无法写入翻译缓存：{err}"))?;
        file.sync_all()
            .map_err(|err| format!("无法同步翻译缓存：{err}"))?;
        std::fs::rename(&temp_path, path).map_err(|err| format!("无法原子替换翻译缓存：{err}"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
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

fn api_key() -> Result<String, String> {
    if let Ok(key) = std::env::var("DEEPSEEK_API_KEY") {
        if !key.trim().is_empty() {
            return Ok(key.trim().to_string());
        }
    }
    let path = config_dir().join("config.json");
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(key) = value.get("deepseekApiKey").and_then(|v| v.as_str()) {
                if !key.trim().is_empty() {
                    return Ok(key.trim().to_string());
                }
            }
        }
    }
    Err("未找到 DeepSeek API 密钥，请在 ~/Library/Application Support/wnacg/config.json 中配置 deepseekApiKey".to_string())
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

    let response = client
        .post(API_URL)
        .bearer_auth(key)
        .json(&payload)
        .timeout(Duration::from_secs(90))
        .send()
        .await
        .map_err(|err| format!("翻译请求失败：{err}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("翻译响应读取失败：{err}"))?;
    if !status.is_success() {
        let preview: String = body.chars().take(200).collect();
        return Err(format!("翻译接口返回 {status}: {}", preview));
    }
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
    let client = translation_client()?;

    let mut pending_chunks = Vec::new();
    let mut chunk_texts = Vec::<Vec<PendingText>>::new();
    for chunk in pending.chunks(CHUNK_SIZE) {
        let items: Vec<(usize, String)> = chunk
            .iter()
            .map(|item| (item.id, item.source.clone()))
            .collect();
        chunk_texts.push(chunk.to_vec());
        pending_chunks.push(translate_chunk(client, &key, items, system_prompt));
    }

    // 各分块并行请求,总延迟取最慢的一块而非逐块累加
    let chunk_results = futures_util::future::join_all(pending_chunks).await;
    let mut cache_updates = Vec::<(String, String)>::new();
    for (chunk_meta, chunk_result) in chunk_texts.into_iter().zip(chunk_results) {
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
    api_key()?;
    Ok("ready".to_string())
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

    #[test]
    fn translation_client_is_reused_without_network_access() {
        let first = translation_client().expect("应创建翻译客户端") as *const reqwest::Client;
        let second = translation_client().expect("应复用翻译客户端") as *const reqwest::Client;
        assert_eq!(first, second);
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

        if let Some(parent) = path.parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
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
