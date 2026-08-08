//! 本地漫画 OCR 助手（日文竖排优先）。
//!
//! 从 stdin 逐行读取 JSON 请求,每行一个:
//!   {"id": 1, "data": "<base64 图片>", "withText": true, "threshold": 0.30}
//! 向 stdout 逐行输出 JSON 结果:
//!   {"id": 1, "regions": [{"text":"...","x":0.1,"y":0.2,"w":0.5,"h":0.05}]}
//! 坐标为图片归一化坐标(0~1),原点在左上角。
//!
//! 检测使用 comic-text-detector(Manga109 训练,同时支持竖排/横排文字),
//! 文字识别使用 manga-ocr-2025(deit-tiny 编码器 + BERT 解码器,支持縦書き)。

use base64::Engine;
use image::imageops::FilterType;
use ort::session::Session;
use ort::value::Tensor as OrtTensor;
use serde::{Deserialize, Serialize};
use std::env;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;
use std::sync::Mutex;

const DET_SIZE: u32 = 1024;
const OCR_SIZE: u32 = 224;
const DECODER_START_TOKEN_ID: i64 = 2;
const EOS_TOKEN_ID: i64 = 3;
const MAX_DECODE_STEPS: usize = 50;
const NMS_THRESHOLD: f32 = 0.45;
const DEFAULT_CONFIDENCE: f32 = 0.30;
const LOW_CONFIDENCE: f32 = 0.15;
const MAX_BOXES: usize = 60;
const MAX_TEXT_BOXES: usize = 24;
const MIN_BOX_SIDE: f32 = 8.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: u64,
    data: String,
    #[serde(default)]
    with_text: bool,
    #[serde(default)]
    threshold: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Region {
    text: String,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    regions: Option<Vec<Region>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone)]
struct DetBox {
    cx: f32,
    cy: f32,
    w: f32,
    h: f32,
    confidence: f32,
    class: usize,
}

fn models_dir() -> String {
    env::var("WNACG_OCR_MODELS_DIR").unwrap_or_else(|_| {
        let home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
        format!("{home}/Library/Application Support/wnacg/ocr-models")
    })
}

fn load_session(path: &Path, optimize: bool) -> Result<Session, String> {
    if optimize {
        Session::builder()
            .map_err(|e| format!("SessionBuilder: {e}"))?
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
            .map_err(|e| format!("set optimization: {e}"))?
            .commit_from_file(path)
            .map_err(|e| format!("无法加载模型 {}: {e}", path.display()))
    } else {
        Session::builder()
            .map_err(|e| format!("SessionBuilder: {e}"))?
            .commit_from_file(path)
            .map_err(|e| format!("无法加载模型 {}: {e}", path.display()))
    }
}

// ── 文字区域检测 (comic-text-detector) ────────────────────────────────────

struct Detector {
    session: Session,
}

impl Detector {
    fn new(models: &Path) -> Result<Self, String> {
        Ok(Self {
            session: load_session(&models.join("comic-text-detector.onnx"), true)?,
        })
    }

    fn detect(&mut self, img: &image::DynamicImage, confidence: f32) -> Result<Vec<DetBox>, String> {
        let (orig_w, orig_h) = (img.width() as f32, img.height() as f32);
        let w_ratio = orig_w / DET_SIZE as f32;
        let h_ratio = orig_h / DET_SIZE as f32;
        let resized = img
            .resize_exact(DET_SIZE, DET_SIZE, FilterType::CatmullRom)
            .to_rgb8();

        let n = (DET_SIZE * DET_SIZE) as usize;
        let mut data = vec![0f32; 3 * n];
        for y in 0..DET_SIZE as usize {
            for x in 0..DET_SIZE as usize {
                let p = resized.get_pixel(x as u32, y as u32);
                data[y * DET_SIZE as usize + x] = p[0] as f32 / 255.0;
                data[n + y * DET_SIZE as usize + x] = p[1] as f32 / 255.0;
                data[2 * n + y * DET_SIZE as usize + x] = p[2] as f32 / 255.0;
            }
        }

        let tensor = OrtTensor::<f32>::from_array(
            ([1usize, 3, DET_SIZE as usize, DET_SIZE as usize], data),
        )
        .map_err(|e| format!("detector input: {e}"))?;
        let outputs = self
            .session
            .run(ort::inputs!["images" => tensor])
            .map_err(|e| format!("detector run: {e}"))?;
        let (shape, blk) = outputs["blk"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("detector output: {e}"))?;
        let n_rows = shape.get(1).copied().unwrap_or(0) as usize;
        let stride = 7usize;

        let mut raw: Vec<DetBox> = Vec::new();
        for i in 0..n_rows {
            let off = i * stride;
            let conf = blk[off + 4];
            if conf < confidence {
                continue;
            }
            let class = if blk[off + 6] > blk[off + 5] { 1 } else { 0 };
            raw.push(DetBox {
                cx: blk[off] * w_ratio,
                cy: blk[off + 1] * h_ratio,
                w: blk[off + 2] * w_ratio,
                h: blk[off + 3] * h_ratio,
                confidence: conf,
                class,
            });
        }

        let mut kept = Vec::new();
        for class in 0..=1 {
            let mut class_boxes: Vec<DetBox> =
                raw.iter().filter(|b| b.class == class).cloned().collect();
            class_boxes.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
            for box_ in class_boxes {
                if kept.iter().any(|k| iou(k, &box_) >= NMS_THRESHOLD) {
                    continue;
                }
                kept.push(box_);
            }
        }

        kept.sort_by(|a, b| {
            a.cy
                .partial_cmp(&b.cy)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.cx.partial_cmp(&b.cx).unwrap_or(std::cmp::Ordering::Equal))
        });
        kept.truncate(MAX_BOXES);
        Ok(kept)
    }
}

fn iou(a: &DetBox, b: &DetBox) -> f32 {
    let ax0 = a.cx - a.w / 2.0;
    let ay0 = a.cy - a.h / 2.0;
    let ax1 = a.cx + a.w / 2.0;
    let ay1 = a.cy + a.h / 2.0;
    let bx0 = b.cx - b.w / 2.0;
    let by0 = b.cy - b.h / 2.0;
    let bx1 = b.cx + b.w / 2.0;
    let by1 = b.cy + b.h / 2.0;
    let ix = (ax1.min(bx1) - ax0.max(bx0)).max(0.0);
    let iy = (ay1.min(by1) - ay0.max(by0)).max(0.0);
    let intersection = ix * iy;
    let union = a.w * a.h + b.w * b.h - intersection;
    if union <= 0.0 {
        0.0
    } else {
        intersection / union
    }
}

// ── 日文文字识别 (manga-ocr-2025) ────────────────────────────────────────

struct MangaOcr {
    encoder: Mutex<Session>,
    decoder: Mutex<Session>,
    vocab: Vec<String>,
}

impl MangaOcr {
    fn new(models: &Path) -> Result<Self, String> {
        let encoder = load_session(&models.join("encoder_model.onnx"), false)?;
        let decoder = load_session(&models.join("decoder_model.onnx"), false)?;
        let vocab = std::fs::read_to_string(models.join("vocab.txt"))
            .map_err(|e| format!("无法读取词表: {e}"))?;
        Ok(Self {
            encoder: Mutex::new(encoder),
            decoder: Mutex::new(decoder),
            vocab: vocab.lines().map(str::to_owned).collect(),
        })
    }

    fn recognize(&self, crop: &image::DynamicImage) -> Result<String, String> {
        let (enc_seq_len, hidden_dim, enc_hidden) = {
            let gray = crop
                .grayscale()
                .resize_exact(OCR_SIZE, OCR_SIZE, FilterType::Triangle)
                .to_rgb8();
            let mut data = vec![0f32; 3 * (OCR_SIZE * OCR_SIZE) as usize];
            for y in 0..OCR_SIZE as usize {
                for x in 0..OCR_SIZE as usize {
                    let p = gray.get_pixel(x as u32, y as u32);
                    data[y * OCR_SIZE as usize + x] =
                        (p[0] as f32 / 255.0 - 0.5) / 0.5;
                    data[(OCR_SIZE * OCR_SIZE) as usize + y * OCR_SIZE as usize + x] =
                        (p[1] as f32 / 255.0 - 0.5) / 0.5;
                    data[2 * (OCR_SIZE * OCR_SIZE) as usize + y * OCR_SIZE as usize + x] =
                        (p[2] as f32 / 255.0 - 0.5) / 0.5;
                }
            }
            let tensor = OrtTensor::<f32>::from_array(
                ([1usize, 3, OCR_SIZE as usize, OCR_SIZE as usize], data),
            )
            .map_err(|e| format!("encoder input: {e}"))?;
            let mut enc = self
                .encoder
                .lock()
                .map_err(|_| "encoder lock poisoned".to_string())?;
            let out = enc
                .run(ort::inputs!["pixel_values" => tensor])
                .map_err(|e| format!("encoder run: {e}"))?;
            let (shape, data) = out["last_hidden_state"]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("encoder output: {e}"))?;
            (shape[1] as usize, shape[2] as usize, data.to_vec())
        };

        let mut ids: Vec<i64> = vec![DECODER_START_TOKEN_ID];
        for _ in 0..MAX_DECODE_STEPS {
            let seq_len = ids.len();
            let mut dec = self
                .decoder
                .lock()
                .map_err(|_| "decoder lock poisoned".to_string())?;
            let out = dec
                .run(ort::inputs![
                    "input_ids" =>
                        OrtTensor::<i64>::from_array(([1usize, seq_len], ids.clone()))
                            .map_err(|e| format!("decoder input: {e}"))?,
                    "encoder_hidden_states" =>
                        OrtTensor::<f32>::from_array(
                            ([1usize, enc_seq_len, hidden_dim], enc_hidden.clone()),
                        )
                        .map_err(|e| format!("decoder hidden: {e}"))?
                ])
                .map_err(|e| format!("decoder run: {e}"))?;
            let (shape, logits) = out["logits"]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("decoder output: {e}"))?;
            let vocab_size = shape[2] as usize;
            let last_start = (seq_len - 1) * vocab_size;
            let last = &logits[last_start..last_start + vocab_size];
            let lp = log_softmax(last);
            let lp = apply_no_repeat_ngram(&ids, lp);
            let token = argmax(&lp) as i64;
            if token == EOS_TOKEN_ID {
                break;
            }
            ids.push(token);
        }

        Ok(self.decode(&ids[1..]))
    }

    fn decode(&self, ids: &[i64]) -> String {
        let mut out = String::new();
        for &id in ids {
            let uid = id as usize;
            if uid < 15 {
                continue;
            }
            if let Some(tok) = self.vocab.get(uid) {
                out.push_str(tok.trim_start_matches("##"));
            }
        }
        out
    }
}

fn log_softmax(logits: &[f32]) -> Vec<f32> {
    let max = logits.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let sum: f32 = logits.iter().map(|&x| (x - max).exp()).sum();
    let log_z = sum.ln() + max;
    logits.iter().map(|&x| x - log_z).collect()
}

fn apply_no_repeat_ngram(ids: &[i64], mut log_probs: Vec<f32>) -> Vec<f32> {
    const N: usize = 3;
    if ids.len() < N - 1 || N < 2 {
        return log_probs;
    }
    let prefix = &ids[ids.len() - (N - 1)..];
    for i in 0..ids.len().saturating_sub(N - 1) {
        if &ids[i..i + N - 1] == prefix {
            let token = ids[i + N - 1] as usize;
            if token < log_probs.len() {
                log_probs[token] = f32::NEG_INFINITY;
            }
        }
    }
    log_probs
}

fn argmax(values: &[f32]) -> usize {
    values
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(i, _)| i)
        .unwrap_or(0)
}

// ── 主流程 ────────────────────────────────────────────────────────────────

fn process(
    detector: &mut Detector,
    ocr: &Option<MangaOcr>,
    req: &Request,
) -> Response {
    let bytes = match base64::engine::general_purpose::STANDARD.decode(&req.data) {
        Ok(bytes) => bytes,
        Err(err) => {
            return Response {
                id: req.id,
                regions: None,
                error: Some(format!("图片数据解码失败: {err}")),
            }
        }
    };
    let mut img = match image::load_from_memory(&bytes) {
        Ok(img) => img,
        Err(err) => {
            return Response {
                id: req.id,
                regions: None,
                error: Some(format!("图片格式无法识别: {err}")),
            }
        }
    };
    let (orig_w, orig_h) = (img.width() as f32, img.height() as f32);

    let mut confidence = req.threshold.unwrap_or(DEFAULT_CONFIDENCE);
    let mut boxes = match detector.detect(&img, confidence) {
        Ok(boxes) => boxes,
        Err(err) => {
            return Response {
                id: req.id,
                regions: None,
                error: Some(err),
            }
        }
    };
    if boxes.len() < 3 && confidence > LOW_CONFIDENCE {
        confidence = LOW_CONFIDENCE;
        if let Ok(retry) = detector.detect(&img, confidence) {
            boxes = retry;
        }
    }

    let mut regions: Vec<Region> = Vec::with_capacity(boxes.len());
    let text_count = if req.with_text {
        boxes.len().min(MAX_TEXT_BOXES)
    } else {
        0
    };
    for (i, box_) in boxes.iter().enumerate() {
        let x0 = (box_.cx - box_.w / 2.0).max(0.0);
        let y0 = (box_.cy - box_.h / 2.0).max(0.0);
        let x1 = (box_.cx + box_.w / 2.0).min(orig_w);
        let y1 = (box_.cy + box_.h / 2.0).min(orig_h);
        if x1 - x0 < MIN_BOX_SIDE || y1 - y0 < MIN_BOX_SIDE {
            continue;
        }
        let mut text = String::new();
        if i < text_count {
            if let Some(ocr) = ocr {
                let crop = img.crop(
                    x0 as u32,
                    y0 as u32,
                    (x1 - x0) as u32,
                    (y1 - y0) as u32,
                );
                if let Ok(recognized) = ocr.recognize(&crop) {
                    text = recognized.trim().to_string();
                }
            }
        }
        regions.push(Region {
            text,
            x: (x0 / orig_w).clamp(0.0, 1.0),
            y: (y0 / orig_h).clamp(0.0, 1.0),
            w: ((x1 - x0) / orig_w).clamp(0.0, 1.0),
            h: ((y1 - y0) / orig_h).clamp(0.0, 1.0),
        });
    }

    Response {
        id: req.id,
        regions: Some(regions),
        error: None,
    }
}

fn main() {
    let models_dir = models_dir();
    let models = Path::new(&models_dir);
    let mut detector = match Detector::new(models) {
        Ok(detector) => detector,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    };
    let mut ocr: Option<MangaOcr> = None;

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = BufWriter::new(stdout);
    for line in BufReader::new(stdin.lock()).lines() {
        let Ok(line) = line else { break };
        let Ok(req) = serde_json::from_str::<Request>(&line) else {
            continue;
        };
        if req.with_text && ocr.is_none() {
            ocr = MangaOcr::new(models).ok();
        }
        let response = process(&mut detector, &ocr, &req);
        if let Ok(json) = serde_json::to_string(&response) {
            let _ = writeln!(out, "{json}");
            let _ = out.flush();
        }
    }
}
