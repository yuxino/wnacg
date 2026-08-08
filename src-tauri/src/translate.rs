use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const API_URL: &str = "https://api.deepseek.com/chat/completions";
const CHUNK_SIZE: usize = 30;

static TRANSLATION_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn config_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("wnacg")
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
        return Err(format!("翻译接口返回 {status}: {}", &body[..body.len().min(200)]));
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
    translate_batch(texts, DIALOGUE_PROMPT).await
}

/// 批量翻译漫画标题(生肉日文标题 → 简体中文),按输入顺序返回。
/// 方括号 [ ] 内的作者/社团/标签保持原文,圆括号内日文系列名翻译。
#[tauri::command]
pub async fn translate_titles(titles: Vec<String>) -> Result<Vec<String>, String> {
    const TITLE_PROMPT: &str = "你是漫画网站的编辑。把日文漫画标题翻译成简体中文：\
        1) 方括号 [ ] 内的内容(作者名、社团名、标签、DL版等)保持原文不译；\
        2) 圆括号 ( ) 内的系列名若为日文则翻译，英文保持原文；\
        3) 只输出流畅自然的标题译文，不要加解释、不要输出原文。";
    translate_batch(titles, TITLE_PROMPT).await
}

async fn translate_batch(texts: Vec<String>, system_prompt: &str) -> Result<Vec<String>, String> {
    let key = api_key()?;
    let client = reqwest::Client::new();

    let cache = TRANSLATION_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut results: Vec<String> = vec![String::new(); texts.len()];
    let mut uncached: Vec<(usize, &str)> = Vec::new();
    {
        let cache = cache.lock().map_err(|_| "翻译缓存锁异常".to_string())?;
        for (offset, text) in texts.iter().enumerate() {
            if let Some(cached) = cache.get(text) {
                results[offset] = cached.clone();
            } else {
                uncached.push((offset, text.as_str()));
            }
        }
    }

    let mut pending_chunks = Vec::new();
    let mut chunk_texts: Vec<Vec<(usize, String)>> = Vec::new();
    for chunk in uncached.chunks(CHUNK_SIZE) {
        let items: Vec<(usize, String)> = chunk
            .iter()
            .map(|(offset, text)| (*offset, (*text).to_string()))
            .collect();
        chunk_texts.push(items.clone());
        pending_chunks.push(translate_chunk(&client, &key, items, system_prompt));
    }

    // 各分块并行请求,总延迟取最慢的一块而非逐块累加
    let chunk_results = futures_util::future::join_all(pending_chunks).await;
    for (chunk_meta, chunk_result) in chunk_texts.into_iter().zip(chunk_results) {
        match chunk_result {
            Ok(map) => {
                let mut cache = cache.lock().map_err(|_| "翻译缓存锁异常".to_string())?;
                for (offset, text) in &chunk_meta {
                    let translated = map.get(offset).cloned().unwrap_or_default();
                    if !translated.is_empty() {
                        cache.insert((*text).to_string(), translated.clone());
                    }
                    results[*offset] = translated;
                }
            }
            Err(err) => {
                return Err(err);
            }
        }
    }

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

    #[test]
    fn deepseek_translate_dialogue() {
        let texts = vec![
            "また明日ね！".to_string(),
            "ちょっと待って…".to_string(),
        ];
        let results = tauri::async_runtime::block_on(translate_dialogue(texts)).expect("翻译应成功");
        assert_eq!(results.len(), 2);
        eprintln!("译文: {results:?}");
        assert!(!results[0].trim().is_empty(), "第一条译文为空");
    }

    #[test]
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
