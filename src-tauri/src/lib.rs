use base64::Engine;
use scraper::{Element, Html, Selector};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

const BASE_URLS: [&str; 3] = [
    "https://www.wn03.cfd",
    "https://wnacg.com",
    "https://www.wnacg.com",
];
static HTTP_CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::REFERER,
        reqwest::header::HeaderValue::from_static("https://wnacg.com/"),
    );
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"),
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
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|err| format!("HTTP 客户端创建失败：{err}"))
});

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
    thumbnail: Option<String>,
    title: String,
}

#[derive(Debug, Serialize)]
struct PhotoImage {
    url: String,
}

#[derive(Debug, Serialize)]
struct Tag {
    name: String,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlbumDetail {
    photos: Vec<PhotoEntry>,
    tags: Vec<Tag>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageData {
    data_url: String,
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

fn is_allowed_wnacg_host(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    host == "wnacg.com"
        || host.ends_with(".wnacg.com")
        || host == "wnacg.org"
        || host.ends_with(".wnacg.org")
        || host == "wn03.cfd"
        || host.ends_with(".wn03.cfd")
}

fn is_allowed_absolute_url(value: &str) -> bool {
    reqwest::Url::parse(value)
        .ok()
        .and_then(|url| url.host_str().map(is_allowed_wnacg_host))
        .unwrap_or(false)
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
    if html.contains("cf_chl") || html.contains("Just a moment") || html.contains("challenge-platform") {
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
            link.value().attr("title").unwrap_or_default().trim().to_string(),
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
    if html.contains("cf_chl") || html.contains("Just a moment") || html.contains("challenge-platform") {
        return Err("被 Cloudflare 校验拦截，当前抓取 API 暂时拿不到页面内容".to_string());
    }

    let document = Html::parse_document(html);
    let link_selector = Selector::parse("a[href*='photos-view']")
        .map_err(|err| format!("选择器错误：{err}"))?;
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
            link_ref.value().attr("title").unwrap_or_default().trim().to_string()
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

        let thumbnail = link_ref
            .select(&img_selector)
            .find_map(|img| {
                img.value()
                    .attr("data-original")
                    .or_else(|| img.value().attr("data-src"))
                    .or_else(|| img.value().attr("data-url"))
                    .or_else(|| img.value().attr("src"))
            })
            .map(|url| normalize_url(base_url, url));

        // Also look for images in parent/ancestor elements
        let thumbnail = thumbnail.or_else(|| {
            link_ref
                .parent_element()
                .and_then(|p| {
                    p.select(&img_selector).find_map(|img| {
                        img.value()
                            .attr("data-original")
                            .or_else(|| img.value().attr("data-src"))
                            .or_else(|| img.value().attr("data-url"))
                            .or_else(|| img.value().attr("src"))
                    })
                })
                .map(|url| normalize_url(base_url, url))
        });

        photos.push(PhotoEntry {
            id,
            url: normalize_url(base_url, href),
            thumbnail,
            title,
        });
    }

    if photos.is_empty() {
        return Err("没有解析到图片条目，页面结构可能变化或被站点拦截".to_string());
    }

    Ok(photos)
}

fn parse_album_max_page(html: &str) -> usize {
    let Some(re) = regex_lite::Regex::new(
        r#"(?:photos-index-page-|[?&]page=|[?&]p=)(\d+)(?:-aid-\d+\.html|[&#"'])?"#,
    ).ok() else {
        return 1;
    };

    re.captures_iter(html)
        .filter_map(|cap| cap.get(1)?.as_str().parse::<usize>().ok())
        .max()
        .unwrap_or(1)
}

fn parse_photo_image(html: &str, base_url: &str) -> Result<PhotoImage, String> {
    if html.contains("cf_chl") || html.contains("Just a moment") || html.contains("challenge-platform") {
        return Err("被 Cloudflare 校验拦截".to_string());
    }

    let document = Html::parse_document(html);

    fn looks_like_ad(src: &str) -> bool {
        let s = src.to_lowercase();
        s.contains("ad.") || s.contains("/ad/") || s.contains("banner") || s.contains("promo")
            || s.contains("sponsor") || s.contains("logo") || s.contains("icon")
            || s.contains("avatar") || s.contains("qr_code") || s.contains("weixin")
    }

    fn looks_like_photo(src: &str) -> bool {
        let s = src.to_lowercase();
        s.contains(".jpg") || s.contains(".jpeg") || s.contains(".png")
            || s.contains(".webp") || s.contains(".gif") || s.contains("/photos/")
            || s.contains("/upload/") || s.contains("/images/") || s.contains("/img/")
    }

    fn attr_src<'a>(el: &'a scraper::ElementRef<'a>, attr: &str) -> Option<&'a str> {
        el.value().attr(attr).filter(|s| !s.is_empty() && !s.starts_with("data:"))
    }

    // 1) meta og:image
    if let Ok(sel) = Selector::parse("meta[property='og:image']") {
        if let Some(el) = document.select(&sel).next() {
            if let Some(src) = attr_src(&el, "content") {
                if !looks_like_ad(src) {
                    return Ok(PhotoImage { url: normalize_url(base_url, src) });
                }
            }
        }
    }

    // 2) link[rel="image_src"]
    if let Ok(sel) = Selector::parse("link[rel='image_src']") {
        if let Some(el) = document.select(&sel).next() {
            if let Some(src) = attr_src(&el, "href") {
                if !looks_like_ad(src) {
                    return Ok(PhotoImage { url: normalize_url(base_url, src) });
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
        let Ok(sel) = Selector::parse(sel_str) else { continue };
        for img in document.select(&sel) {
            // try data-original first (often used for lazy-load)
            let src = attr_src(&img, "data-original")
                .or_else(|| attr_src(&img, "data-src"))
                .or_else(|| attr_src(&img, "data-url"))
                .or_else(|| attr_src(&img, "src"));
            let Some(src) = src else { continue };
            if looks_like_ad(src) { continue; }
            return Ok(PhotoImage { url: normalize_url(base_url, src) });
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
                        return Ok(PhotoImage { url: normalize_url(base_url, url) });
                    }
                }
            }
        }
    }

    // 5) regex search raw HTML for image URLs (catches JS vars, JSON, etc.)
    {
        let re = regex_lite::Regex::new(r#"(?:https?:)?//[^"'\s<>\[\]{}()]+\.(?:jpg|jpeg|png|webp|gif)[^"'\s<>\[\]{}()]*"#).ok();
        if let Some(re) = &re {
            for cap in re.captures_iter(html) {
                let url = cap.get(0).unwrap().as_str();
                if !looks_like_ad(url) && looks_like_photo(url) {
                    return Ok(PhotoImage { url: normalize_url(base_url, url) });
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
        if looks_like_ad(src) { continue; }

        let is_in_bad_area = img.ancestors().any(|el| {
            el.value().as_element().map_or(false, |e| {
                let id = e.id().unwrap_or_default().to_lowercase();
                let classes = e.classes().collect::<Vec<_>>().join(" ").to_lowercase();
                id.contains("ad") || id.contains("banner") || classes.contains("ad")
                    || classes.contains("banner") || id.contains("sidebar")
                    || classes.contains("sidebar") || id.contains("footer")
                    || classes.contains("footer") || id.contains("header")
            })
        });
        if is_in_bad_area { continue; }

        if looks_like_photo(src) {
            photo_candidates.push(src.to_string());
        } else {
            other_candidates.push(src.to_string());
        }
    }

    for src in photo_candidates.iter().chain(other_candidates.iter()) {
        return Ok(PhotoImage { url: normalize_url(base_url, src) });
    }

    Err("无法解析图片地址，页面结构可能变化或图片由脚本延迟加载".to_string())
}

async fn fetch_page(url: String, referer: Option<&str>) -> Result<String, String> {
    let referer = referer.unwrap_or("https://wnacg.com/");
    let response = client()?
        .get(&url)
        .header("referer", referer)
        .send()
        .await
        .map_err(|err| format!("请求失败：{err}"))?;

    if !response.status().is_success() {
        return Err(format!("服务返回 HTTP {}", response.status()));
    }

    let body = response
        .text()
        .await
        .map_err(|err| format!("读取响应失败：{err}"))?;

    if body.is_empty() || body.contains("cf_chl") || body.contains("Just a moment") {
        return Err("站点返回空内容或被 CF 拦截".to_string());
    }

    Ok(body)
}

async fn fetch_binary(url: String, referer: Option<String>) -> Result<(String, Vec<u8>), String> {
    let mut request = client()?
        .get(&url)
        .header("accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
        .header("accept-language", "zh-CN,zh;q=0.9")
        .header("priority", "u=1, i")
        .header("sec-ch-ua", r#""Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147""#)
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

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/jpeg")
        .split(';')
        .next()
        .unwrap_or("image/jpeg")
        .to_string();

    if !status.is_success() {
        return Err(format!("图片服务返回 HTTP {status}"));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("读取图片失败：{err}"))?
        .to_vec();

    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }

    Ok((content_type, bytes))
}

#[tauri::command]
async fn fetch_albums(path: String, _app: tauri::AppHandle) -> Result<Vec<Album>, String> {
    let mut errors = Vec::new();

    for base_url in BASE_URLS {
        let url = build_url(base_url, &path)?;

        match fetch_page(url, None).await.and_then(|html| parse_albums(&html, base_url)) {
            Ok(albums) => return Ok(albums),
            Err(error) => errors.push(format!("{base_url}: {error}")),
        }
    }

    Err(errors.join("\n"))
}

#[tauri::command]
async fn search_albums(query: String, page: u32, app: tauri::AppHandle) -> Result<Vec<Album>, String> {
    let page = page.max(1);
    let encoded_query = urlencoding::encode(query.trim());
    let path = format!("/search/index.php?q={encoded_query}&m=&f=_all&s=create_time_DESC&p={page}");
    fetch_albums(path, app).await
}

fn parse_album_tags(html: &str, base_url: &str) -> Vec<Tag> {
    let document = Html::parse_document(html);
    let tag_sel = Selector::parse("a.tagshow").ok();
    let Some(sel) = tag_sel else { return vec![] };
    document.select(&sel).filter_map(|el| {
        let href = el.value().attr("href")?;
        let name = el.text().collect::<String>().trim().to_string();
        if name.is_empty() || href.is_empty() { return None; }
        Some(Tag { name, path: normalize_url(base_url, href) })
    }).collect()
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
                let max_page = parse_album_max_page(&first_html);
                let mut photos = parse_album_photos(&first_html, base_url)?;

                if max_page > 1 {
                    // Fetch remaining pages CONCURRENTLY
                    let mut handles = Vec::new();
                    for page in 2..=max_page {
                        let bu = base_url.to_string();
                        let a = aid.clone();
                        handles.push(tauri::async_runtime::spawn(async move {
                            let page_path = format!("/photos-index-page-{page}-aid-{a}.html");
                            let page_url = build_url(&bu, &page_path)?;
                            let html = fetch_page(page_url, None).await?;
                            parse_album_photos(&html, &bu)
                        }));
                    }
                    for handle in handles {
                        match handle.await {
                            Ok(Ok(mut page_photos)) => photos.append(&mut page_photos),
                            Ok(Err(e)) => errors.push(e),
                            Err(e) => errors.push(format!("并发任务失败: {e}")),
                        }
                    }
                }

                let tags = parse_album_tags(&first_html, base_url);
                let mut seen = HashSet::new();
                photos.retain(|photo| seen.insert(photo.id.clone()));
                return Ok(AlbumDetail { photos, tags });
            }
            Err(error) => errors.push(format!("{base_url}: {error}")),
        }
    }

    Err(errors.join("\n"))
}

/// Search albums by tag (clicking a tag in reader view)
#[tauri::command]
async fn search_tag(tag: String, app: tauri::AppHandle) -> Result<Vec<Album>, String> {
    let encoded = urlencoding::encode(&tag);
    let path = format!("/albums-index-tag-{encoded}.html");
    fetch_albums(path, app).await
}

#[tauri::command]
async fn fetch_photo_image(page_url: String, album_url: Option<String>, _app: tauri::AppHandle) -> Result<PhotoImage, String> {
    let mut errors = Vec::new();

    for base_url in BASE_URLS {
        let url = build_url(base_url, &page_url)?;
        let referer = album_url.as_deref().or(Some(base_url));

        match fetch_page(url, referer).await.and_then(|html| parse_photo_image(&html, base_url)) {
            Ok(photo) => return Ok(photo),
            Err(error) => errors.push(format!("{base_url}: {error}")),
        }
    }

    Err(errors.join("\n"))
}

#[tauri::command]
async fn fetch_image_data_url(url: String, referer: Option<String>) -> Result<ImageData, String> {
    let url = clean_url_value(&url);
    let host = reqwest::Url::parse(&url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_default();
    let allowed = is_allowed_wnacg_host(&host)
        || host.starts_with("img")
        || host.starts_with("t.")
        || host.starts_with("cdn")
        || host.starts_with("pic")
        || host.starts_with("photo")
        || host.starts_with("static")
        || host == "qy0.ru"
        || host.ends_with(".qy0.ru")
        || BASE_URLS.iter().any(|base_url| url.starts_with(base_url));

    if !allowed {
        return Err("不允许加载非 WNACG 图片域名".to_string());
    }

    let (content_type, bytes) = fetch_binary(url, referer).await?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);

    Ok(ImageData {
        data_url: format!("data:{content_type};base64,{encoded}"),
    })
}

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fetch_albums,
            search_albums,
            search_tag,
            fetch_album_photos,
            fetch_photo_image,
            fetch_image_data_url
        ])
        .setup(|app| {
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

            let _tray = TrayIconBuilder::new()
                .icon(tray_icon_image())
                .icon_as_template(true)
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
                        app.state::<Arc<AtomicBool>>().store(true, Ordering::Relaxed);
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
                        toggle_main_window(&tray.app_handle());
                    }
                })
                .build(app)?;

            app.manage(is_quitting);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main_window(app);
            }
            let _ = app;
        });
}
