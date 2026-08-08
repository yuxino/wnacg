import Foundation
import AppKit
import Vision

// 本地 OCR 助手:从 stdin 逐行读取 JSON 请求,每行一个:
//   {"id": 1, "data": "<base64 图片>", "languages": ["ja-JP", ...], "minimumTextHeight": 0.002}
// 向 stdout 逐行输出 JSON 结果:
//   {"id": 1, "regions": [{"text":"...","x":0.1,"y":0.2,"w":0.5,"h":0.05}]}
//   {"id": 1, "error": "..."}
// 坐标为图片归一化坐标(0~1),原点在左上角。
// Vision 的 VNRecognizeTextRequest 不识别竖排文字(漫画常见的縦書き),
// 因此对原图与逆/顺时针各 90° 三个方向各识别一次,把旋转方向的框换算回原图坐标,
// 再按置信度与 IoU 去重合并。

struct Request: Decodable {
    let id: Int
    let data: String
    let languages: [String]?
    let minimumTextHeight: Double?
    let orientations: [Int]?
}

struct Region: Encodable {
    let text: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

struct Candidate {
    let text: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    let confidence: Double
    let orientation: Int
}

struct Response: Encodable {
    let id: Int
    let regions: [Region]?
    let error: String?
}

func process(_ req: Request) -> Response {
    guard let data = Data(base64Encoded: req.data) else {
        return Response(id: req.id, regions: nil, error: "图片数据解码失败")
    }
    guard let image = NSImage(data: data),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return Response(id: req.id, regions: nil, error: "图片格式无法识别")
    }

    // turns: 0 = 原图, 1 = 逆时针 90°, 3 = 顺时针 90°
    let orientations = req.orientations ?? [0, 1, 3]
    let minimumTextHeight = Float(req.minimumTextHeight ?? 0.002)
    let languages = req.languages ?? ["ja-JP", "zh-Hans", "zh-Hant", "en-US"]

    var candidates: [Candidate] = []
    for turns in orientations {
        let image = (turns % 4 + 4) % 4 == 0 ? cgImage : rotateCGImage(cgImage, quarterTurns: turns)

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.minimumTextHeight = minimumTextHeight
        request.recognitionLanguages = languages

        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            continue
        }

        for obs in request.results ?? [] {
            guard let top = obs.topCandidates(1).first else { continue }
            let bb = obs.boundingBox
            let rx = Double(bb.origin.x)
            let ry = Double(1.0 - bb.origin.y - bb.size.height)
            let rw = Double(bb.size.width)
            let rh = Double(bb.size.height)

            var x = rx, y = ry, w = rw, h = rh
            let turn = (turns % 4 + 4) % 4
            if turn == 1 {
                // 逆时针 90°:原图 x = 1-(y'+h'), y = x', w = h', h = w'
                x = 1.0 - (ry + rh)
                y = rx
                w = rh
                h = rw
            } else if turn == 3 {
                // 顺时针 90°:原图 x = y', y = 1-(x'+w'), w = h', h = w'
                x = ry
                y = 1.0 - (rx + rw)
                w = rh
                h = rw
            }
            x = min(max(x, 0), 1)
            y = min(max(y, 0), 1)
            w = min(max(w, 0), 1 - x)
            h = min(max(h, 0), 1 - y)
            candidates.append(Candidate(
                text: top.string,
                x: x, y: y, w: w, h: h,
                confidence: Double(obs.confidence),
                orientation: turn
            ))
        }
    }

    let regions = mergeCandidates(candidates)
    return Response(id: req.id, regions: regions, error: nil)
}

func rotateCGImage(_ image: CGImage, quarterTurns: Int) -> CGImage {
    let turns = ((quarterTurns % 4) + 4) % 4
    guard turns != 0 else { return image }
    let w = image.width, h = image.height
    let size = turns % 2 == 0 ? CGSize(width: w, height: h) : CGSize(width: h, height: w)
    let colorSpace = image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!
    guard let ctx = CGContext(data: nil, width: Int(size.width), height: Int(size.height),
                              bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return image }
    ctx.translateBy(x: size.width / 2, y: size.height / 2)
    ctx.rotate(by: CGFloat(turns) * .pi / 2)
    ctx.translateBy(x: -CGFloat(w) / 2, y: -CGFloat(h) / 2)
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage() ?? image
}

func mergeCandidates(_ candidates: [Candidate]) -> [Region] {
    let sorted = candidates.sorted {
        if $0.confidence != $1.confidence {
            return $0.confidence > $1.confidence
        }
        return $0.orientation == 0 && $1.orientation != 0
    }

    var kept: [Candidate] = []
    for candidate in sorted {
        var duplicate = false
        for existing in kept {
            let intersectionWidth = min(existing.x + existing.w, candidate.x + candidate.w) - max(existing.x, candidate.x)
            let intersectionHeight = min(existing.y + existing.h, candidate.y + candidate.h) - max(existing.y, candidate.y)
            if intersectionWidth <= 0 || intersectionHeight <= 0 { continue }
            let intersection = intersectionWidth * intersectionHeight
            let union = existing.w * existing.h + candidate.w * candidate.h - intersection
            if union > 0 && intersection / union > 0.35 {
                duplicate = true
                break
            }
        }
        if !duplicate {
            kept.append(candidate)
        }
    }

    return kept
        .sorted { $0.y < $1.y || ($0.y == $1.y && $0.x < $1.x) }
        .map { Region(text: $0.text, x: $0.x, y: $0.y, w: $0.w, h: $0.h) }
}

while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let req = try? JSONDecoder().decode(Request.self, from: data) else {
        continue
    }
    let resp = process(req)
    let encoder = JSONEncoder()
    if let out = try? encoder.encode(resp), let str = String(data: out, encoding: .utf8) {
        print(str)
        fflush(stdout)
    }
}
