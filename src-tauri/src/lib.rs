use base64::Engine;
use futures_util::StreamExt;
use scraper::{Html, Selector};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

mod ocr;
mod translate;

const BASE_URLS: [&str; 2] = ["https://www.wn09.shop", "https://www.wn03.cfd"];
const RELEASES_API: &str = "https://api.github.com/repos/yuxino/wnacg/releases?per_page=100";
const RELEASES_URL: &str = "https://github.com/yuxino/wnacg/releases";
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ALBUM_INDEX_PAGES: usize = 256;
const ALBUM_PAGE_FETCH_CONCURRENCY: usize = 2;
const PAGE_FETCH_MIN_INTERVAL: Duration = Duration::from_millis(1_200);
const PAGE_FETCH_DEFAULT_COOLDOWN: Duration = Duration::from_secs(15);
const PAGE_FETCH_MAX_COOLDOWN: Duration = Duration::from_secs(120);
const RATE_LIMIT_ERROR_PREFIX: &str = "站点请求过于频繁（HTTP 429）";
const CURL_RATE_LIMIT_MARKER: &str = "__WNACG_HTTP_429__";

/// Windows 上以无控制台窗口方式启动应用管理的子进程。
#[cfg(target_os = "windows")]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_console(_command: &mut Command) {}
static HTTP_CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::REFERER,
        reqwest::header::HeaderValue::from_static("https://wnacg.com/"),
    );
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static(
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        ),
    );
    headers.insert(
        reqwest::header::ACCEPT_LANGUAGE,
        reqwest::header::HeaderValue::from_static("zh-CN,zh;q=0.9"),
    );
    headers.insert(
        reqwest::header::HeaderName::from_static("sec-fetch-dest"),
        reqwest::header::HeaderValue::from_static("document"),
    );
    headers.insert(
        reqwest::header::HeaderName::from_static("sec-fetch-mode"),
        reqwest::header::HeaderValue::from_static("navigate"),
    );
    headers.insert(
        reqwest::header::HeaderName::from_static("sec-fetch-site"),
        reqwest::header::HeaderValue::from_static("none"),
    );
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36")
        .default_headers(headers)
        .referer(true)
        .cookie_store(true)
        .http1_only()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 8 {
                return attempt.error(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "重定向次数过多",
                ));
            }
            if is_allowed_remote_url(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "阻止重定向到未授权站点",
                ))
            }
        }))
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|err| format!("HTTP 客户端创建失败：{err}"))
});

#[derive(Debug)]
struct PageFetchGate {
    next_allowed_at: Instant,
}

impl PageFetchGate {
    fn new(now: Instant) -> Self {
        Self {
            next_allowed_at: now,
        }
    }

    fn reserve(&mut self, now: Instant) -> Option<Duration> {
        if now < self.next_allowed_at {
            return Some(self.next_allowed_at.duration_since(now));
        }
        self.next_allowed_at = now + PAGE_FETCH_MIN_INTERVAL;
        None
    }

    fn defer(&mut self, now: Instant, delay: Duration) {
        let deferred_until = now + delay;
        if deferred_until > self.next_allowed_at {
            self.next_allowed_at = deferred_until;
        }
    }
}

static PAGE_FETCH_GATE: LazyLock<tokio::sync::Mutex<PageFetchGate>> =
    LazyLock::new(|| tokio::sync::Mutex::new(PageFetchGate::new(Instant::now())));

async fn wait_for_page_fetch_slot() {
    loop {
        let delay = {
            let mut gate = PAGE_FETCH_GATE.lock().await;
            gate.reserve(Instant::now())
        };
        match delay {
            Some(delay) => tokio::time::sleep(delay).await,
            None => return,
        }
    }
}

async fn defer_page_fetches(delay: Duration) {
    PAGE_FETCH_GATE.lock().await.defer(Instant::now(), delay);
}

fn rate_limit_delay(retry_after: Option<&str>) -> Duration {
    let seconds = retry_after
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(PAGE_FETCH_DEFAULT_COOLDOWN.as_secs())
        .clamp(1, PAGE_FETCH_MAX_COOLDOWN.as_secs());
    Duration::from_secs(seconds)
}

fn rate_limit_error(delay: Duration) -> String {
    format!(
        "{RATE_LIMIT_ERROR_PREFIX}，已自动暂停 {} 秒。请稍后重试。",
        delay.as_secs()
    )
}

fn is_rate_limit_error(error: &str) -> bool {
    error.starts_with(RATE_LIMIT_ERROR_PREFIX)
}

fn combine_fallback_error(primary: String, fallback: String) -> String {
    if is_rate_limit_error(&fallback) {
        fallback
    } else {
        format!("{primary}\n备用通道也失败：{fallback}")
    }
}

#[derive(Debug, Serialize)]
struct Album {
    aid: String,
    title: String,
    url: String,
    cover: Option<String>,
    meta: String,
}

#[derive(Debug, Serialize)]
struct PhotoEntry {
    id: String,
    url: String,
    title: String,
}

#[derive(Debug, Serialize)]
struct PhotoImage {
    url: String,
}

#[derive(Debug, Clone, Serialize)]
struct Tag {
    name: String,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlbumDetail {
    photos: Vec<PhotoEntry>,
    tags: Vec<Tag>,
    categories: Vec<Tag>,
    author: Option<Tag>,
    title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowseLinkRequest {
    kind: String,
    name: String,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageData {
    data_url: String,
}

fn image_data_url_capacity(content_type: &str, bytes_len: usize) -> Result<usize, String> {
    let encoded_len =
        base64::encoded_len(bytes_len, true).ok_or_else(|| "图片编码长度溢出".to_string())?;
    "data:"
        .len()
        .checked_add(content_type.len())
        .and_then(|length| length.checked_add(";base64,".len()))
        .and_then(|length| length.checked_add(encoded_len))
        .ok_or_else(|| "图片 data URL 长度溢出".to_string())
}

fn encode_image_data_url(content_type: &str, bytes: &[u8]) -> Result<String, String> {
    let mut data_url = String::with_capacity(image_data_url_capacity(content_type, bytes.len())?);
    data_url.push_str("data:");
    data_url.push_str(content_type);
    data_url.push_str(";base64,");
    base64::engine::general_purpose::STANDARD.encode_string(bytes, &mut data_url);
    Ok(data_url)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageDownloadProgress {
    request_id: String,
    loaded: u64,
    total: Option<u64>,
    percent: Option<u8>,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    draft: bool,
    prerelease: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateInfo {
    current_version: String,
    latest_version: Option<String>,
    available: bool,
    release_url: String,
}

const IMAGE_PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(90);

struct ImageProgressThrottle {
    last_emitted_at: Instant,
    last_loaded: u64,
    last_percent: Option<u8>,
}

impl ImageProgressThrottle {
    fn new(now: Instant, loaded: u64, percent: Option<u8>) -> Self {
        Self {
            last_emitted_at: now,
            last_loaded: loaded,
            last_percent: percent,
        }
    }

    fn should_emit(&mut self, now: Instant, loaded: u64, percent: Option<u8>) -> bool {
        // Completion is emitted exactly once after the stream finishes.
        if percent == Some(100) || loaded == self.last_loaded {
            return false;
        }
        if now.saturating_duration_since(self.last_emitted_at) < IMAGE_PROGRESS_EMIT_INTERVAL {
            return false;
        }
        // With a known total, only repaint when the displayed integer percent changes.
        // Without a total, elapsed bytes are the only useful progress signal.
        if percent.is_some() && percent == self.last_percent {
            return false;
        }

        self.last_emitted_at = now;
        self.last_loaded = loaded;
        self.last_percent = percent;
        true
    }
}

fn clean_url_value(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .replace("&amp;", "&")
        .replace("\\/", "/")
}

fn normalize_url(base_url: &str, value: &str) -> String {
    let value = clean_url_value(value);
    if value.starts_with("http://") || value.starts_with("https://") {
        value
    } else if value.starts_with("//") {
        format!("https://{}", value.trim_start_matches('/'))
    } else if value.starts_with('/') {
        format!("{base_url}{value}")
    } else {
        format!("{base_url}/{value}")
    }
}

fn normalized_host(host: &str) -> String {
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

fn host_is_domain(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.') && prefix.len() > 1)
}

fn is_allowed_wnacg_host(host: &str) -> bool {
    let host = normalized_host(host);
    host_is_domain(&host, "wnacg.com")
        || host_is_domain(&host, "wnacg.org")
        || host_is_domain(&host, "wn03.cfd")
        || host_is_domain(&host, "wn09.shop")
}

fn is_allowed_image_host(host: &str) -> bool {
    let host = normalized_host(host);
    is_allowed_wnacg_host(&host)
        || host_is_domain(&host, "wnacgimg.date")
        || host_is_domain(&host, "wnimg1.ru")
        || host_is_domain(&host, "qy0.ru")
}

fn has_safe_remote_url_shape(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

fn is_allowed_page_url(url: &reqwest::Url) -> bool {
    has_safe_remote_url_shape(url) && url.host_str().is_some_and(is_allowed_wnacg_host)
}

fn is_allowed_image_url(url: &reqwest::Url) -> bool {
    has_safe_remote_url_shape(url) && url.host_str().is_some_and(is_allowed_image_host)
}

fn is_allowed_remote_url(url: &reqwest::Url) -> bool {
    is_allowed_page_url(url) || is_allowed_image_url(url)
}

fn is_allowed_image_url_value(value: &str) -> bool {
    reqwest::Url::parse(value)
        .ok()
        .is_some_and(|url| is_allowed_image_url(&url))
}

fn is_allowed_absolute_url(value: &str) -> bool {
    reqwest::Url::parse(value)
        .ok()
        .is_some_and(|url| is_allowed_page_url(&url))
}

fn build_url(base_url: &str, path: &str) -> Result<String, String> {
    let path = clean_url_value(path);
    if path.starts_with("http://") || path.starts_with("https://") {
        let allowed = is_allowed_absolute_url(&path);
        return allowed
            .then_some(path)
            .ok_or_else(|| "只允许抓取 WNACG 站点".to_string());
    }

    if !path.starts_with('/') {
        return Err("路径必须以 / 开头".to_string());
    }

    Ok(format!("{base_url}{path}"))
}

fn client() -> Result<&'static reqwest::Client, String> {
    HTTP_CLIENT.as_ref().map_err(Clone::clone)
}

fn normalized_version(value: &str) -> Result<Version, String> {
    let trimmed = value.trim();
    let normalized = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    Version::parse(normalized).map_err(|_| format!("无法识别版本号：{value}"))
}

#[cfg(test)]
fn is_newer_version(latest: &str, current: &str) -> Result<bool, String> {
    Ok(normalized_version(latest)? > normalized_version(current)?)
}

fn newest_stable_release(releases: Vec<GithubRelease>) -> Option<(GithubRelease, Version)> {
    releases
        .into_iter()
        .filter(|release| !release.draft && !release.prerelease)
        .filter_map(|release| {
            normalized_version(&release.tag_name)
                .ok()
                .filter(|version| version.pre.is_empty())
                .map(|version| (release, version))
        })
        .max_by(|(_, left), (_, right)| left.cmp(right))
}

fn safe_release_url(value: &str) -> String {
    reqwest::Url::parse(value)
        .ok()
        .filter(|url| {
            url.scheme() == "https"
                && url.host_str() == Some("github.com")
                && url.port().is_none()
                && url.username().is_empty()
                && url.password().is_none()
                && url.path().starts_with("/yuxino/wnacg/releases/")
        })
        .map(|url| url.to_string())
        .unwrap_or_else(|| RELEASES_URL.to_string())
}

fn looks_like_cloudflare_challenge(body: &str) -> bool {
    body.contains("cf_chl")
        || body.contains("Just a moment")
        || body.contains("challenge-platform")
        || body.contains("cf-mitigated")
        || body.contains("challenges.cloudflare.com")
}

fn extract_aid(href: &str) -> Option<String> {
    let marker = "aid-";
    let start = href.find(marker)? + marker.len();
    let aid: String = href[start..]
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect();

    (!aid.is_empty()).then_some(aid)
}

fn extract_photoid(href: &str) -> Option<String> {
    for marker in &["photos-view-id-", "photos-view-aid-", "view-id-"] {
        if let Some(start) = href.find(marker) {
            let start = start + marker.len();
            let id: String = href[start..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if !id.is_empty() {
                return Some(id);
            }
        }
    }
    None
}

fn cleaned_text(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn parse_albums(html: &str, base_url: &str) -> Result<Vec<Album>, String> {
    if html.contains("cf_chl")
        || html.contains("Just a moment")
        || html.contains("challenge-platform")
    {
        return Err("被 Cloudflare 校验拦截，当前抓取 API 暂时拿不到页面内容".to_string());
    }

    let document = Html::parse_document(html);
    let container_selector = Selector::parse(".gallary_item, li, .pic_box, .album, .list li")
        .map_err(|err| format!("选择器错误：{err}"))?;
    let link_selector = Selector::parse("a[href*='photos-index-aid-']")
        .map_err(|err| format!("选择器错误：{err}"))?;
    let img_selector = Selector::parse("img").map_err(|err| format!("选择器错误：{err}"))?;

    let mut albums = Vec::new();

    for container in document.select(&container_selector) {
        let Some(link) = container.select(&link_selector).next() else {
            continue;
        };
        let Some(href) = link.value().attr("href") else {
            continue;
        };
        let Some(aid) = extract_aid(href) else {
            continue;
        };

        if albums.iter().any(|album: &Album| album.aid == aid) {
            continue;
        }

        let cover = container
            .select(&img_selector)
            .find_map(|img| {
                img.value()
                    .attr("data-original")
                    .or_else(|| img.value().attr("data-src"))
                    .or_else(|| img.value().attr("data-url"))
                    .or_else(|| img.value().attr("src"))
            })
            .map(|url| normalize_url(base_url, url));
        let img_title = container.select(&img_selector).find_map(|img| {
            img.value()
                .attr("alt")
                .or_else(|| img.value().attr("title"))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        });

        let title = [
            cleaned_text(&link.text().collect::<Vec<_>>().join(" ")),
            link.value()
                .attr("title")
                .unwrap_or_default()
                .trim()
                .to_string(),
            img_title.unwrap_or_default(),
        ]
        .into_iter()
        .find(|value| !value.is_empty())
        .unwrap_or_else(|| format!("作品 {aid}"));

        let raw_meta = cleaned_text(&container.text().collect::<Vec<_>>().join(" "));
        let meta = raw_meta.replace(&title, "").trim().to_string();

        albums.push(Album {
            aid,
            title,
            url: normalize_url(base_url, href),
            cover,
            meta,
        });
    }

    if albums.is_empty() {
        return Err("没有解析到条目，页面结构可能变化或被站点拦截".to_string());
    }

    Ok(albums)
}

fn parse_album_photos(html: &str, base_url: &str) -> Result<Vec<PhotoEntry>, String> {
    if html.contains("cf_chl")
        || html.contains("Just a moment")
        || html.contains("challenge-platform")
    {
        return Err("被 Cloudflare 校验拦截，当前抓取 API 暂时拿不到页面内容".to_string());
    }

    let document = Html::parse_document(html);
    let link_selector =
        Selector::parse("a[href*='photos-view']").map_err(|err| format!("选择器错误：{err}"))?;
    let img_selector = Selector::parse("img").map_err(|err| format!("选择器错误：{err}"))?;

    let mut photos = Vec::new();

    for link_ref in document.select(&link_selector) {
        let Some(href) = link_ref.value().attr("href") else {
            continue;
        };
        let Some(id) = extract_photoid(href) else {
            continue;
        };
        if photos.iter().any(|p: &PhotoEntry| p.id == id) {
            continue;
        }

        let title = cleaned_text(&link_ref.text().collect::<Vec<_>>().join(" "));
        let title = if title.is_empty() {
            link_ref
                .value()
                .attr("title")
                .unwrap_or_default()
                .trim()
                .to_string()
        } else {
            title
        };
        // fallback: use thumbnail alt text or page number from id
        let title = if title.is_empty() {
            link_ref
                .select(&img_selector)
                .find_map(|img| img.value().attr("alt").filter(|a| !a.is_empty()))
                .map(|a| a.trim().to_string())
                .unwrap_or_else(|| format!("#{}", id))
        } else {
            title
        };

        photos.push(PhotoEntry {
            id,
            url: normalize_url(base_url, href),
            title,
        });
    }

    if photos.is_empty() {
        return Err("没有解析到图片条目，页面结构可能变化或被站点拦截".to_string());
    }

    Ok(photos)
}

fn parse_album_max_page(html: &str) -> Result<usize, String> {
    let Some(re) = regex_lite::Regex::new(
        r#"(?:photos-index-page-|[?&]page=|[?&]p=)(\d+)(?:-aid-\d+\.html|[&#"'])?"#,
    )
    .ok() else {
        return Ok(1);
    };

    let max_page = re
        .captures_iter(html)
        .filter_map(|cap| cap.get(1)?.as_str().parse::<usize>().ok())
        .max()
        .unwrap_or(1);
    if max_page > MAX_ALBUM_INDEX_PAGES {
        return Err(format!(
            "作品分页异常（{max_page} 页），已超过安全上限 {MAX_ALBUM_INDEX_PAGES}"
        ));
    }
    Ok(max_page)
}

fn parse_photo_image(html: &str, base_url: &str) -> Result<PhotoImage, String> {
    if html.contains("cf_chl")
        || html.contains("Just a moment")
        || html.contains("challenge-platform")
    {
        return Err("被 Cloudflare 校验拦截".to_string());
    }

    let document = Html::parse_document(html);

    fn looks_like_ad(src: &str) -> bool {
        let s = src.to_lowercase();
        s.contains("ad.")
            || s.contains("/ad/")
            || s.contains("banner")
            || s.contains("promo")
            || s.contains("sponsor")
            || s.contains("logo")
            || s.contains("icon")
            || s.contains("avatar")
            || s.contains("qr_code")
            || s.contains("weixin")
    }

    fn looks_like_photo(src: &str) -> bool {
        let s = src.to_lowercase();
        s.contains(".jpg")
            || s.contains(".jpeg")
            || s.contains(".png")
            || s.contains(".webp")
            || s.contains(".gif")
            || s.contains("/photos/")
            || s.contains("/upload/")
            || s.contains("/images/")
            || s.contains("/img/")
    }

    fn attr_src<'a>(el: &'a scraper::ElementRef<'a>, attr: &str) -> Option<&'a str> {
        el.value()
            .attr(attr)
            .filter(|s| !s.is_empty() && !s.starts_with("data:"))
    }

    // 1) meta og:image
    if let Ok(sel) = Selector::parse("meta[property='og:image']") {
        if let Some(el) = document.select(&sel).next() {
            if let Some(src) = attr_src(&el, "content") {
                if !looks_like_ad(src) {
                    return Ok(PhotoImage {
                        url: normalize_url(base_url, src),
                    });
                }
            }
        }
    }

    // 2) link[rel="image_src"]
    if let Ok(sel) = Selector::parse("link[rel='image_src']") {
        if let Some(el) = document.select(&sel).next() {
            if let Some(src) = attr_src(&el, "href") {
                if !looks_like_ad(src) {
                    return Ok(PhotoImage {
                        url: normalize_url(base_url, src),
                    });
                }
            }
        }
    }

    // 3) targeted img selectors
    let targeted = [
        "img#picarea",
        "#imgarea img",
        "#picarea img",
        "img#photo",
        "#photo img",
        ".main-image img",
        "#img_area img",
        ".img_box img",
        "#view-photo img",
        ".photo-view img",
        "#comicpic img",
        "#display_image img",
        ".photo-content img",
        "img[data-original]",
        "img[data-url]",
    ];

    for sel_str in targeted {
        let Ok(sel) = Selector::parse(sel_str) else {
            continue;
        };
        for img in document.select(&sel) {
            // try data-original first (often used for lazy-load)
            let src = attr_src(&img, "data-original")
                .or_else(|| attr_src(&img, "data-src"))
                .or_else(|| attr_src(&img, "data-url"))
                .or_else(|| attr_src(&img, "src"));
            let Some(src) = src else { continue };
            if looks_like_ad(src) {
                continue;
            }
            return Ok(PhotoImage {
                url: normalize_url(base_url, src),
            });
        }
    }

    // 4) search script / JSON for image URLs
    let script_re = regex_lite::Regex::new(
        r#"(?:img_url|image_url|photo_url|pic_url|img_src|image_src|src)\s*[=:]\s*["']([^"']+)["']"#,
    ).ok();
    if let (Some(re), Ok(sel)) = (&script_re, Selector::parse("script")) {
        for script in document.select(&sel) {
            let text = script.text().collect::<Vec<_>>().join(" ");
            for cap in re.captures_iter(&text) {
                if let Some(m) = cap.get(1) {
                    let url = m.as_str();
                    if looks_like_photo(url) && !looks_like_ad(url) {
                        return Ok(PhotoImage {
                            url: normalize_url(base_url, url),
                        });
                    }
                }
            }
        }
    }

    // 5) regex search raw HTML for image URLs (catches JS vars, JSON, etc.)
    {
        let re = regex_lite::Regex::new(
            r#"(?:https?:)?//[^"'\s<>\[\]{}()]+\.(?:jpg|jpeg|png|webp|gif)[^"'\s<>\[\]{}()]*"#,
        )
        .ok();
        if let Some(re) = &re {
            for cap in re.captures_iter(html) {
                let url = cap.get(0).unwrap().as_str();
                if !looks_like_ad(url) && looks_like_photo(url) {
                    return Ok(PhotoImage {
                        url: normalize_url(base_url, url),
                    });
                }
            }
        }
    }

    // 6) broader scan: collect all non-ad images, prefer photo-like ones
    let img_sel = Selector::parse("img").unwrap();
    let mut photo_candidates: Vec<String> = Vec::new();
    let mut other_candidates: Vec<String> = Vec::new();

    for img in document.select(&img_sel) {
        let src = attr_src(&img, "data-original")
            .or_else(|| attr_src(&img, "data-src"))
            .or_else(|| attr_src(&img, "data-url"))
            .or_else(|| attr_src(&img, "src"));
        let Some(src) = src else { continue };
        if looks_like_ad(src) {
            continue;
        }

        let is_in_bad_area = img.ancestors().any(|el| {
            el.value().as_element().is_some_and(|e| {
                let id = e.id().unwrap_or_default().to_lowercase();
                let classes = e.classes().collect::<Vec<_>>().join(" ").to_lowercase();
                id.contains("ad")
                    || id.contains("banner")
                    || classes.contains("ad")
                    || classes.contains("banner")
                    || id.contains("sidebar")
                    || classes.contains("sidebar")
                    || id.contains("footer")
                    || classes.contains("footer")
                    || id.contains("header")
            })
        });
        if is_in_bad_area {
            continue;
        }

        if looks_like_photo(src) {
            photo_candidates.push(src.to_string());
        } else {
            other_candidates.push(src.to_string());
        }
    }

    if let Some(src) = photo_candidates
        .iter()
        .chain(other_candidates.iter())
        .next()
    {
        return Ok(PhotoImage {
            url: normalize_url(base_url, src),
        });
    }

    Err("无法解析图片地址，页面结构可能变化或图片由脚本延迟加载".to_string())
}

async fn fetch_page(url: String, referer: Option<&str>) -> Result<String, String> {
    let referer = referer.unwrap_or("https://wnacg.com/");
    wait_for_page_fetch_slot().await;
    let response =
        match client()?.get(&url).header("referer", referer).send().await {
            Ok(r) => r,
            Err(err) => {
                return fetch_page_via_curl(url, referer.to_string()).await.map_err(
                    |fallback_err| combine_fallback_error(format!("请求失败：{err}"), fallback_err),
                );
            }
        };

    if !is_allowed_page_url(response.url()) {
        return Err("WNACG 页面重定向到了未授权站点".to_string());
    }

    let status = response.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let delay = rate_limit_delay(
            response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok()),
        );
        defer_page_fetches(delay).await;
        return Err(rate_limit_error(delay));
    }
    if !response.status().is_success() {
        return fetch_page_via_curl(url, referer.to_string())
            .await
            .map_err(|fallback_err| {
                combine_fallback_error(format!("服务返回 HTTP {status}"), fallback_err)
            });
    }

    let body = match response.text().await {
        Ok(b) => b,
        Err(err) => {
            return fetch_page_via_curl(url, referer.to_string())
                .await
                .map_err(|fallback_err| {
                    combine_fallback_error(format!("读取响应失败：{err}"), fallback_err)
                });
        }
    };

    if body.is_empty() || looks_like_cloudflare_challenge(&body) {
        return fetch_page_via_curl(url, referer.to_string())
            .await
            .map_err(|fallback_err| {
                combine_fallback_error("站点返回空内容或被 CF 拦截".to_string(), fallback_err)
            });
    }

    Ok(body)
}

async fn fetch_page_via_curl(url: String, referer: String) -> Result<String, String> {
    let parsed_url = reqwest::Url::parse(&url).map_err(|_| "WNACG 页面地址无效".to_string())?;
    if !is_allowed_page_url(&parsed_url) {
        return Err("只允许抓取受信任的 WNACG 页面".to_string());
    }

    wait_for_page_fetch_slot().await;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new("curl");
        hide_console(&mut command);
        let output = command
            .arg("--http1.1")
            .args(["--proto", "=https"])
            .arg("--compressed")
            .arg("--max-time")
            .arg("25")
            .arg("-sS")
            .arg("-A")
            .arg("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36")
            .arg("-H")
            .arg("Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
            .arg("-H")
            .arg("Accept-Language: zh-CN,zh;q=0.9")
            .arg("-H")
            .arg(format!("Referer: {referer}"))
            .arg("-w")
            .arg("\n__WNACG_HTTP_STATUS__:%{http_code}")
            .arg(&url)
            .output()
            .map_err(|err| format!("无法启动 curl：{err}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                format!("curl 退出码 {}", output.status)
            } else {
                stderr
            });
        }

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let marker = "\n__WNACG_HTTP_STATUS__:";
        let Some(marker_at) = stdout.rfind(marker) else {
            return Err("curl 没有返回状态码".to_string());
        };
        let body = stdout[..marker_at].to_string();
        let code = stdout[marker_at + marker.len()..].trim();

        if code == "429" {
            return Err(CURL_RATE_LIMIT_MARKER.to_string());
        }
        if !code.starts_with('2') {
            return Err(format!("curl 返回 HTTP {code}"));
        }
        if body.is_empty() || looks_like_cloudflare_challenge(&body) {
            return Err("curl 返回空内容或仍被 Cloudflare 校验拦截".to_string());
        }

        Ok(body)
    })
    .await
    .map_err(|err| format!("curl 备用任务失败：{err}"))?;

    match result {
        Err(error) if error == CURL_RATE_LIMIT_MARKER => {
            let delay = PAGE_FETCH_DEFAULT_COOLDOWN;
            defer_page_fetches(delay).await;
            Err(rate_limit_error(delay))
        }
        result => result,
    }
}

async fn fetch_binary(url: String, referer: Option<String>) -> Result<(String, Vec<u8>), String> {
    let parsed_url = reqwest::Url::parse(&url).map_err(|_| "图片地址无效".to_string())?;
    if !is_allowed_image_url(&parsed_url) {
        return Err("不允许加载非 WNACG 图片域名".to_string());
    }

    let mut request = client()?
        .get(&url)
        .header(
            "accept",
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        )
        .header("accept-language", "zh-CN,zh;q=0.9")
        .header("priority", "u=1, i")
        .header(
            "sec-ch-ua",
            r#""Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147""#,
        )
        .header("sec-ch-ua-mobile", "?0")
        .header("sec-ch-ua-platform", "macOS")
        .header("sec-fetch-dest", "image")
        .header("sec-fetch-mode", "no-cors")
        .header("sec-fetch-site", "cross-site")
        .header("sec-fetch-storage-access", "none");

    if let Some(referer) = referer {
        request = request.header("referer", referer);
    } else {
        request = request.header("referer", "https://wnacg.com/");
    }

    let response = request
        .send()
        .await
        .map_err(|err| format!("图片请求失败：{err}"))?;

    if !is_allowed_image_url(response.url()) {
        return Err("图片请求重定向到了未授权站点".to_string());
    }

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .ok_or("图片响应缺少内容类型")?
        .split(';')
        .next()
        .unwrap_or_default()
        .to_string();
    let total = response.content_length();

    if !status.is_success() {
        return Err(format!("图片服务返回 HTTP {status}"));
    }
    if !content_type.starts_with("image/") {
        return Err(format!("图片服务返回了非图片内容：{content_type}"));
    }
    if total.is_some_and(|total| total > MAX_IMAGE_BYTES) {
        return Err("图片超过 64 MiB 安全上限".to_string());
    }

    let mut bytes = Vec::with_capacity(total.unwrap_or(0).min(MAX_IMAGE_BYTES) as usize);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| format!("读取图片失败：{err}"))?;
        if (bytes.len() as u64).saturating_add(chunk.len() as u64) > MAX_IMAGE_BYTES {
            return Err("图片超过 64 MiB 安全上限".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }

    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }

    Ok((content_type, bytes))
}

async fn fetch_binary_with_progress(
    app: tauri::AppHandle,
    request_id: String,
    url: String,
    referer: Option<String>,
) -> Result<(String, Vec<u8>), String> {
    let parsed_url = reqwest::Url::parse(&url).map_err(|_| "图片地址无效".to_string())?;
    if !is_allowed_image_url(&parsed_url) {
        return Err("不允许加载非 WNACG 图片域名".to_string());
    }

    let mut request = client()?
        .get(&url)
        .header(
            "accept",
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        )
        .header("accept-language", "zh-CN,zh;q=0.9")
        .header("priority", "u=1, i")
        .header(
            "sec-ch-ua",
            r#""Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147""#,
        )
        .header("sec-ch-ua-mobile", "?0")
        .header("sec-ch-ua-platform", "macOS")
        .header("sec-fetch-dest", "image")
        .header("sec-fetch-mode", "no-cors")
        .header("sec-fetch-site", "cross-site")
        .header("sec-fetch-storage-access", "none");

    if let Some(referer) = referer {
        request = request.header("referer", referer);
    } else {
        request = request.header("referer", "https://wnacg.com/");
    }

    let response = request
        .send()
        .await
        .map_err(|err| format!("图片请求失败：{err}"))?;

    if !is_allowed_image_url(response.url()) {
        return Err("图片请求重定向到了未授权站点".to_string());
    }

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .ok_or("图片响应缺少内容类型")?
        .split(';')
        .next()
        .unwrap_or_default()
        .to_string();
    let total = response.content_length();

    if !status.is_success() {
        return Err(format!("图片服务返回 HTTP {status}"));
    }
    if !content_type.starts_with("image/") {
        return Err(format!("图片服务返回了非图片内容：{content_type}"));
    }
    if total.is_some_and(|total| total > MAX_IMAGE_BYTES) {
        return Err("图片超过 64 MiB 安全上限".to_string());
    }

    let mut loaded = 0_u64;
    let mut bytes = Vec::with_capacity(total.unwrap_or(0).min(30_000_000) as usize);
    let mut stream = response.bytes_stream();
    let initial_percent = total.filter(|total| *total > 0).map(|_| 0);
    let _ = app.emit(
        "image-download-progress",
        ImageDownloadProgress {
            request_id: request_id.clone(),
            loaded,
            total,
            percent: initial_percent,
        },
    );
    let mut progress_throttle = ImageProgressThrottle::new(Instant::now(), loaded, initial_percent);

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| format!("读取图片失败：{err}"))?;
        if loaded.saturating_add(chunk.len() as u64) > MAX_IMAGE_BYTES {
            return Err("图片超过 64 MiB 安全上限".to_string());
        }
        loaded += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);
        let percent = total
            .filter(|total| *total > 0)
            .map(|total| ((loaded.saturating_mul(100) / total).min(100)) as u8);
        if progress_throttle.should_emit(Instant::now(), loaded, percent) {
            let _ = app.emit(
                "image-download-progress",
                ImageDownloadProgress {
                    request_id: request_id.clone(),
                    loaded,
                    total,
                    percent,
                },
            );
        }
    }

    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }

    let _ = app.emit(
        "image-download-progress",
        ImageDownloadProgress {
            request_id,
            loaded,
            total,
            percent: Some(100),
        },
    );

    Ok((content_type, bytes))
}

#[tauri::command]
async fn fetch_albums(path: String, _app: tauri::AppHandle) -> Result<Vec<Album>, String> {
    let mut errors = Vec::new();

    for base_url in BASE_URLS {
        let url = build_url(base_url, &path)?;

        match fetch_page(url, None)
            .await
            .and_then(|html| parse_albums(&html, base_url))
        {
            Ok(albums) => return Ok(albums),
            Err(error) if is_rate_limit_error(&error) => return Err(error),
            Err(error) => errors.push(format!("{base_url}: {error}")),
        }
    }

    Err(errors.join("\n"))
}

#[tauri::command]
async fn search_albums(
    query: String,
    page: u32,
    app: tauri::AppHandle,
) -> Result<Vec<Album>, String> {
    let page = page.max(1);
    let encoded_query = urlencoding::encode(query.trim());
    let path = format!("/search/index.php?q={encoded_query}&m=&f=_all&s=create_time_DESC&p={page}");
    fetch_albums(path, app).await
}

fn parse_album_tags(html: &str, base_url: &str) -> Vec<Tag> {
    let document = Html::parse_document(html);
    let tag_sel = Selector::parse("a.tagshow").ok();
    let Some(sel) = tag_sel else { return vec![] };
    document
        .select(&sel)
        .filter_map(|el| {
            let href = el.value().attr("href")?;
            let name = el.text().collect::<String>().trim().to_string();
            if name.is_empty() || href.is_empty() {
                return None;
            }
            Some(Tag {
                name,
                path: normalize_url(base_url, href),
            })
        })
        .collect()
}

fn parse_album_categories(html: &str, base_url: &str) -> Vec<Tag> {
    let document = Html::parse_document(html);
    let Ok(selector) = Selector::parse(
        "#bread .bread a[href*='albums-index-cate-'], .png.bread a[href*='albums-index-cate-']",
    ) else {
        return vec![];
    };
    let mut seen = HashSet::new();

    document
        .select(&selector)
        .filter_map(|element| {
            let href = element.value().attr("href")?;
            let name = cleaned_text(&element.text().collect::<Vec<_>>().join(" "));
            if name.is_empty() || href.is_empty() || !seen.insert(href.to_string()) {
                return None;
            }
            Some(Tag {
                name,
                path: normalize_url(base_url, href),
            })
        })
        .collect()
}

fn parse_album_author(html: &str, base_url: &str) -> Option<Tag> {
    let document = Html::parse_document(html);
    let selector = Selector::parse(".uwuinfo a[href*='albums-user-uid-']").ok()?;
    let element = document.select(&selector).next()?;
    let href = element.value().attr("href")?;
    let name = cleaned_text(&element.text().collect::<Vec<_>>().join(" "));
    if name.is_empty() || href.is_empty() {
        return None;
    }
    Some(Tag {
        name,
        path: normalize_url(base_url, href),
    })
}

fn parse_album_title(html: &str) -> Option<String> {
    let document = Html::parse_document(html);

    // 优先取页面正文 <h2>（站点把作品名放在这里）
    if let Ok(sel) = Selector::parse("#bodywrap h2, .userwrap h2, h2") {
        if let Some(el) = document.select(&sel).next() {
            let text = cleaned_text(&el.text().collect::<Vec<_>>().join(" "));
            if !text.is_empty() {
                return Some(text);
            }
        }
    }

    // fallback: <title> 去掉站名后缀
    if let Ok(sel) = Selector::parse("title") {
        if let Some(el) = document.select(&sel).next() {
            let raw = cleaned_text(&el.text().collect::<Vec<_>>().join(" "));
            if raw.is_empty() {
                return None;
            }
            let trimmed = raw
                .split(['|', '-', '_'])
                .next()
                .unwrap_or(&raw)
                .trim()
                .to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }

    None
}

#[tauri::command]
async fn fetch_album_photos(aid: String, _app: tauri::AppHandle) -> Result<AlbumDetail, String> {
    let aid = aid.trim().to_string();
    let path = format!("/photos-index-aid-{aid}.html");
    let mut errors = Vec::new();

    for base_url in BASE_URLS {
        let url = build_url(base_url, &path)?;

        match fetch_page(url, None).await {
            Ok(first_html) => {
                let max_page = match parse_album_max_page(&first_html) {
                    Ok(max_page) => max_page,
                    Err(error) => {
                        errors.push(format!("{base_url}: {error}"));
                        continue;
                    }
                };
                let mut photos = match parse_album_photos(&first_html, base_url) {
                    Ok(photos) => photos,
                    Err(error) => {
                        errors.push(format!("{base_url}: {error}"));
                        continue;
                    }
                };

                if max_page > 1 {
                    let mut page_stream = futures_util::stream::iter(2..=max_page)
                        .map(|page| {
                            let bu = base_url.to_string();
                            let a = aid.clone();
                            async move {
                                let page_path = format!("/photos-index-page-{page}-aid-{a}.html");
                                let page_url = build_url(&bu, &page_path)?;
                                let html = fetch_page(page_url, None).await?;
                                Ok::<_, String>((page, parse_album_photos(&html, &bu)?))
                            }
                        })
                        .buffer_unordered(ALBUM_PAGE_FETCH_CONCURRENCY);
                    let mut page_results = Vec::new();
                    let mut page_error = None;
                    while let Some(result) = page_stream.next().await {
                        match result {
                            Ok(page_result) => page_results.push(page_result),
                            Err(error) => {
                                page_error = Some(error);
                                break;
                            }
                        }
                    }
                    drop(page_stream);
                    if let Some(error) = page_error {
                        if is_rate_limit_error(&error) {
                            return Err(error);
                        }
                        errors.push(format!("{base_url}: {error}"));
                        continue;
                    }
                    page_results.sort_by_key(|(page, _)| *page);
                    for (_, mut page_photos) in page_results {
                        photos.append(&mut page_photos);
                    }
                }

                let tags = parse_album_tags(&first_html, base_url);
                let categories = parse_album_categories(&first_html, base_url);
                let author = parse_album_author(&first_html, base_url);
                let title = parse_album_title(&first_html);
                let mut seen = HashSet::new();
                photos.retain(|photo| seen.insert(photo.id.clone()));
                return Ok(AlbumDetail {
                    photos,
                    tags,
                    categories,
                    author,
                    title,
                });
            }
            Err(error) if is_rate_limit_error(&error) => return Err(error),
            Err(error) => errors.push(format!("{base_url}: {error}")),
        }
    }

    Err(errors.join("\n"))
}

#[tauri::command]
async fn fetch_photo_image(
    page_url: String,
    album_url: Option<String>,
    _app: tauri::AppHandle,
) -> Result<PhotoImage, String> {
    let mut errors = Vec::new();

    for base_url in BASE_URLS {
        let url = build_url(base_url, &page_url)?;
        let referer = album_url.as_deref().or(Some(base_url));

        match fetch_page(url, referer)
            .await
            .and_then(|html| parse_photo_image(&html, base_url))
        {
            Ok(photo) => return Ok(photo),
            Err(error) if is_rate_limit_error(&error) => return Err(error),
            Err(error) => errors.push(format!("{base_url}: {error}")),
        }
    }

    Err(errors.join("\n"))
}

#[tauri::command]
async fn fetch_image_data_url(url: String, referer: Option<String>) -> Result<ImageData, String> {
    let url = clean_url_value(&url);
    if !is_allowed_image_url_value(&url) {
        return Err("不允许加载非 WNACG 图片域名".to_string());
    }

    let (content_type, bytes) = fetch_binary(url.clone(), referer).await?;
    let data_url = encode_image_data_url(&content_type, &bytes)?;
    ocr::cache_image_bytes(&url, bytes);

    Ok(ImageData { data_url })
}

#[tauri::command]
async fn fetch_image_data_url_progress(
    url: String,
    referer: Option<String>,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<ImageData, String> {
    let url = clean_url_value(&url);
    if !is_allowed_image_url_value(&url) {
        return Err("不允许加载非 WNACG 图片域名".to_string());
    }

    let (content_type, bytes) =
        fetch_binary_with_progress(app, request_id, url.clone(), referer).await?;
    let data_url = encode_image_data_url(&content_type, &bytes)?;
    ocr::cache_image_bytes(&url, bytes);

    Ok(ImageData { data_url })
}

#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<AppUpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    let client = reqwest::Client::builder()
        .user_agent(format!("wnacg/{current_version}"))
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|err| format!("更新检查初始化失败：{err}"))?;

    let response = client
        .get(RELEASES_API)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|err| format!("无法连接更新服务器：{err}"))?;

    let releases = response
        .error_for_status()
        .map_err(|err| format!("更新服务器返回错误：{err}"))?
        .json::<Vec<GithubRelease>>()
        .await
        .map_err(|err| format!("更新信息解析失败：{err}"))?;
    let Some((release, latest_version)) = newest_stable_release(releases) else {
        return Ok(AppUpdateInfo {
            current_version,
            latest_version: None,
            available: false,
            release_url: RELEASES_URL.to_string(),
        });
    };
    let available = latest_version > normalized_version(&current_version)?;

    Ok(AppUpdateInfo {
        current_version,
        latest_version: Some(latest_version.to_string()),
        available,
        release_url: safe_release_url(&release.html_url),
    })
}

#[cfg(target_os = "windows")]
fn tray_icon_image() -> Image<'static> {
    tauri::include_image!("icons/kiri/32x32.png")
}

#[cfg(not(target_os = "windows"))]
fn tray_icon_image() -> Image<'static> {
    tauri::include_image!("icons/tray-icon.png")
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[tauri::command]
fn is_window_fullscreen(window: tauri::Window) -> Result<bool, String> {
    window
        .is_fullscreen()
        .map_err(|err| format!("读取全屏状态失败：{err}"))
}

#[tauri::command]
fn toggle_window_fullscreen(window: tauri::Window) -> Result<bool, String> {
    let next = !window
        .is_fullscreen()
        .map_err(|err| format!("读取全屏状态失败：{err}"))?;
    window
        .set_fullscreen(next)
        .map_err(|err| format!("切换全屏失败：{err}"))?;
    Ok(next)
}

fn sanitize_window_label(aid: &str) -> String {
    let mut label = String::from("album-");
    for ch in aid.chars().take(40) {
        if ch.is_ascii_alphanumeric() {
            label.push(ch);
        } else {
            label.push('_');
        }
    }
    label
}

#[tauri::command]
async fn open_album_window(
    app: tauri::AppHandle,
    aid: String,
    title: String,
) -> Result<(), String> {
    if aid.trim().is_empty() {
        return Err("缺少作品 ID".to_string());
    }
    let label = sanitize_window_label(&aid);

    if let Some(existing) = app.get_webview_window(&label) {
        existing.unminimize().ok();
        existing.show().ok();
        existing.set_focus().ok();
        return Ok(());
    }

    let url = format!("index.html#aid={}", aid);
    let window_title = if title.trim().is_empty() {
        format!("作品 {aid}")
    } else {
        title
    };

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(window_title)
        .inner_size(1100.0, 820.0)
        .min_inner_size(880.0, 640.0)
        .build()
        .map_err(|err| format!("无法创建窗口：{err}"))?;

    Ok(())
}

#[tauri::command]
fn set_window_title(window: tauri::Window, title: String) -> Result<(), String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    window.set_title(trimmed).map_err(|err| err.to_string())
}

#[tauri::command]
fn close_current_window(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|err| err.to_string())
}

#[tauri::command]
fn browse_link_in_main(
    app: tauri::AppHandle,
    kind: String,
    name: String,
    path: String,
) -> Result<(), String> {
    let kind = kind.trim();
    let name = name.trim();
    let path = path.trim();
    if !matches!(kind, "tag" | "author" | "classification") {
        return Err("不支持的列表类型".to_string());
    }
    if name.is_empty() || path.is_empty() {
        return Err("缺少列表信息".to_string());
    }
    // Reuse the same URL allow-list as the fetch commands before passing this
    // link to the main window.
    build_url(BASE_URLS[0], path)?;

    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    main.show().ok();
    main.unminimize().ok();
    main.set_focus().ok();
    main.emit(
        "browse-link",
        BrowseLinkRequest {
            kind: kind.to_string(),
            name: name.to_string(),
            path: path.to_string(),
        },
    )
    .map_err(|err| format!("通知主窗口失败：{err}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fetch_albums,
            search_albums,
            fetch_album_photos,
            fetch_photo_image,
            fetch_image_data_url,
            fetch_image_data_url_progress,
            check_for_update,
            is_window_fullscreen,
            toggle_window_fullscreen,
            open_album_window,
            set_window_title,
            close_current_window,
            browse_link_in_main,
            ocr::ocr_capabilities,
            ocr::ocr_pages,
            ocr::ocr_engine_status,
            translate::translate_dialogue,
            translate::translate_engine_status,
            translate::set_deepseek_api_key,
            translate::translate_titles
        ])
        .setup(|app| {
            translate::migrate_legacy_data();

            let show = MenuItemBuilder::with_id("show", "显示").build(app)?;
            let hide = MenuItemBuilder::with_id("hide", "隐藏").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show)
                .item(&hide)
                .separator()
                .item(&quit)
                .build()?;

            let is_quitting = Arc::new(AtomicBool::new(false));

            if cfg!(debug_assertions) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title("wnacg [DEV]");
                }
            }

            let app_handle = app.handle().clone();
            let close_is_quitting = is_quitting.clone();
            if let Some(window) = app.get_webview_window("main") {
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if close_is_quitting.load(Ordering::Relaxed) {
                            return;
                        }
                        api.prevent_close();
                        hide_main_window(&app_handle);
                    }
                });
            }

            let tray_builder = TrayIconBuilder::new()
                .icon(tray_icon_image())
                .tooltip("wnacg")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        show_main_window(app);
                    }
                    "hide" => {
                        hide_main_window(app);
                    }
                    "quit" => {
                        app.state::<Arc<AtomicBool>>()
                            .store(true, Ordering::Relaxed);
                        ocr::shutdown_workers();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(tray.app_handle());
                    }
                });
            #[cfg(target_os = "macos")]
            let tray_builder = tray_builder.icon_as_template(true);
            let _tray = tray_builder.build(app)?;

            app.manage(is_quitting);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main_window(app),
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                ocr::shutdown_workers();
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_release_versions_semantically() {
        assert!(is_newer_version("v0.1.6", "0.1.5").unwrap());
        assert!(is_newer_version("1.0.0", "0.9.9").unwrap());
        assert!(is_newer_version("v0.1.6+build.4", "0.1.5").unwrap());
        assert!(!is_newer_version("v0.1.5", "0.1.5").unwrap());
        assert!(!is_newer_version("v0.1.4", "0.1.5").unwrap());
        assert!(is_newer_version("vv0.1.6", "0.1.5").is_err());
        assert!(is_newer_version("latest", "0.1.5").is_err());
    }

    #[test]
    fn selects_the_highest_stable_semver_release() {
        let release = |tag: &str, draft: bool, prerelease: bool| GithubRelease {
            tag_name: tag.to_string(),
            html_url: format!("{RELEASES_URL}/tag/{tag}"),
            draft,
            prerelease,
        };
        let (_, version) = newest_stable_release(vec![
            release("v0.1.7", false, false),
            release("v0.2.0-beta.1", false, false),
            release("v9.0.0", true, false),
            release("v8.0.0", false, true),
            release("not-a-version", false, false),
            release("v0.2.0", false, false),
        ])
        .expect("a stable release should be selected");

        assert_eq!(version, Version::parse("0.2.0").unwrap());
    }

    #[test]
    fn only_accepts_release_links_from_the_project_repository() {
        assert_eq!(
            safe_release_url("https://github.com/yuxino/wnacg/releases/tag/v0.1.6"),
            "https://github.com/yuxino/wnacg/releases/tag/v0.1.6"
        );
        assert_eq!(
            safe_release_url("https://example.com/yuxino/wnacg/releases/tag/v0.1.6"),
            RELEASES_URL
        );
        assert_eq!(
            safe_release_url("https://github.com:444/yuxino/wnacg/releases/tag/v0.1.6"),
            RELEASES_URL
        );
        assert_eq!(
            safe_release_url("https://reader@github.com/yuxino/wnacg/releases/tag/v0.1.6"),
            RELEASES_URL
        );
        assert_eq!(
            safe_release_url("https://github.com/yuxino/wnacg/releases.evil/tag/v0.1.6"),
            RELEASES_URL
        );
    }

    #[test]
    fn only_allows_known_https_wnacg_pages() {
        for value in [
            "https://www.wn03.cfd/albums-index-page-1.html",
            "https://www.wn09.shop/photos-index-aid-1.html",
            "https://www.wnacg.com/",
        ] {
            let url = reqwest::Url::parse(value).unwrap();
            assert!(is_allowed_page_url(&url), "应允许 {value}");
        }

        for value in [
            "http://www.wn09.shop/albums-index-page-1.html",
            "https://www.wn09.shop:444/albums-index-page-1.html",
            "https://reader@www.wn09.shop/albums-index-page-1.html",
            "https://www.wn09.shop.evil.example/albums-index-page-1.html",
            "https://img5.wnimg1.ru/data/1.jpg",
        ] {
            let url = reqwest::Url::parse(value).unwrap();
            assert!(!is_allowed_page_url(&url), "应拒绝 {value}");
        }
    }

    #[test]
    fn image_proxy_only_allows_known_cdn_domains() {
        for value in [
            "https://t4.wnacgimg.date/data/cover.webp",
            "https://img5.wnimg1.ru/data/page.jpg",
            "https://cdn.qy0.ru/data/page.jpg",
            "https://www.wn09.shop/static/page.jpg",
        ] {
            assert!(is_allowed_image_url_value(value), "应允许 {value}");
        }

        for value in [
            "https://img.evil.example/page.jpg",
            "https://cdn-example.com/page.jpg",
            "https://wnimg1.ru.evil.example/page.jpg",
            "http://img5.wnimg1.ru/page.jpg",
            "https://img5.wnimg1.ru:444/page.jpg",
            "https://reader@img5.wnimg1.ru/page.jpg",
            "file:///etc/passwd",
        ] {
            assert!(!is_allowed_image_url_value(value), "应拒绝 {value}");
        }
    }

    #[test]
    fn image_data_url_encoding_matches_the_standard_base64_form() {
        let bytes = b"\x00WNACG image bytes\xff";
        let expected = format!(
            "data:image/webp;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        );
        let actual = encode_image_data_url("image/webp", bytes).unwrap();

        assert_eq!(actual, expected);
        assert_eq!(
            actual.len(),
            image_data_url_capacity("image/webp", bytes.len()).unwrap()
        );
    }

    #[test]
    fn image_data_url_capacity_handles_padding_and_rejects_overflow() {
        let prefix_len = "data:image/png;base64,".len();
        for (bytes_len, encoded_len) in [(0, 0), (1, 4), (2, 4), (3, 4), (4, 8)] {
            assert_eq!(
                image_data_url_capacity("image/png", bytes_len).unwrap(),
                prefix_len + encoded_len
            );
        }
        assert_eq!(
            image_data_url_capacity("image/png", MAX_IMAGE_BYTES as usize).unwrap(),
            prefix_len + base64::encoded_len(MAX_IMAGE_BYTES as usize, true).unwrap()
        );
        assert!(image_data_url_capacity("image/png", usize::MAX).is_err());
    }

    #[test]
    fn album_pagination_rejects_implausible_page_counts() {
        let ordinary = r#"<a href="/photos-index-page-12-aid-42.html">12</a>"#;
        assert_eq!(parse_album_max_page(ordinary).unwrap(), 12);

        let malicious = r#"<a href="/photos-index-page-999999-aid-42.html">last</a>"#;
        assert!(parse_album_max_page(malicious).is_err());
    }

    #[test]
    fn parses_album_browse_links_with_their_real_paths() {
        let html = r#"
            <div id="bread"><div class="png bread">
              <a href="/">首頁</a>
              <a href="/albums-index-cate-5.html">同人誌</a>
              <a href="/albums-index-cate-1.html">漢化</a>
            </div></div>
            <div class="addtags">標籤：
              <a class="tagshow" href="/albums-index-tag-Story.html">Story</a>
            </div>
            <div class="uwuinfo">
              <a href="/albums-user-uid-42.html"><img src="avatar.jpg"><p>Uploader</p></a>
            </div>
        "#;

        let categories = parse_album_categories(html, "https://www.wn03.cfd");
        assert_eq!(categories.len(), 2);
        assert_eq!(categories[0].name, "同人誌");
        assert_eq!(
            categories[1].path,
            "https://www.wn03.cfd/albums-index-cate-1.html"
        );

        let tags = parse_album_tags(html, "https://www.wn03.cfd");
        assert_eq!(tags.len(), 1);
        assert_eq!(
            tags[0].path,
            "https://www.wn03.cfd/albums-index-tag-Story.html"
        );

        let author = parse_album_author(html, "https://www.wn03.cfd").expect("author");
        assert_eq!(author.name, "Uploader");
        assert_eq!(author.path, "https://www.wn03.cfd/albums-user-uid-42.html");
    }

    #[test]
    fn image_progress_throttle_limits_fast_updates_and_duplicate_percentages() {
        let start = Instant::now();
        let mut throttle = ImageProgressThrottle::new(start, 0, Some(0));

        assert!(!throttle.should_emit(start + Duration::from_millis(40), 100, Some(1)));
        assert!(throttle.should_emit(start + Duration::from_millis(90), 200, Some(2)));
        assert!(!throttle.should_emit(start + Duration::from_millis(180), 250, Some(2)));
        assert!(throttle.should_emit(start + Duration::from_millis(180), 300, Some(3)));
    }

    #[test]
    fn image_progress_throttle_updates_unknown_totals_on_the_interval() {
        let start = Instant::now();
        let mut throttle = ImageProgressThrottle::new(start, 0, None);

        assert!(!throttle.should_emit(start + Duration::from_millis(89), 100, None));
        assert!(throttle.should_emit(start + Duration::from_millis(90), 200, None));
        assert!(!throttle.should_emit(start + Duration::from_millis(180), 200, None));
        assert!(throttle.should_emit(start + Duration::from_millis(180), 300, None));
    }

    #[test]
    fn image_progress_throttle_reserves_completion_for_the_final_event() {
        let start = Instant::now();
        let mut throttle = ImageProgressThrottle::new(start, 0, Some(0));

        assert!(!throttle.should_emit(start + Duration::from_secs(1), 1_000, Some(100)));
    }

    #[test]
    fn page_fetch_gate_spaces_requests_and_extends_rate_limit_cooldowns() {
        let start = Instant::now();
        let mut gate = PageFetchGate::new(start);

        assert_eq!(gate.reserve(start), None);
        assert_eq!(
            gate.reserve(start + Duration::from_millis(200)),
            Some(Duration::from_millis(1_000))
        );

        gate.defer(start + Duration::from_millis(300), Duration::from_secs(15));
        assert_eq!(
            gate.reserve(start + Duration::from_secs(1)),
            Some(Duration::from_millis(14_300))
        );
    }

    #[test]
    fn retry_after_seconds_are_bounded_and_render_a_rate_limit_error() {
        assert_eq!(rate_limit_delay(None), PAGE_FETCH_DEFAULT_COOLDOWN);
        assert_eq!(rate_limit_delay(Some("9")), Duration::from_secs(9));
        assert_eq!(rate_limit_delay(Some("0")), Duration::from_secs(1));
        assert_eq!(rate_limit_delay(Some("9999")), PAGE_FETCH_MAX_COOLDOWN);

        let error = rate_limit_error(Duration::from_secs(9));
        assert!(is_rate_limit_error(&error));
        assert!(error.contains("已自动暂停 9 秒"));
        assert_eq!(
            combine_fallback_error("原请求失败".to_string(), error.clone()),
            error
        );
    }
}
