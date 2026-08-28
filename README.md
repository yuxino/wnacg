<div align="center">
  <br>
  <img src="src-tauri/icons/kiri/128x128@2x.png" width="112" alt="wnacg">
  <h1>wnacg</h1>
  <p><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
  <p>一个面向 WNACG 的桌面漫画阅读器，提供专注阅读、本地 OCR 与可选翻译；应用界面目前仅提供简体中文。</p>
</div>

> 18+。仓库和安装包不包含第三方漫画、图片内容或 OCR 模型权重。请从 [Releases](https://github.com/yuxino/wnacg/releases) 下载 macOS Apple Silicon 或 Windows x64 安装包；暂未提供 Intel Mac 或 Linux 安装包。macOS 包只有 ad-hoc 签名且未经公证，Windows 包未做代码签名。

## 功能

- 按分类浏览和关键词搜索，并从作品信息继续浏览分类、作者（上传者）与标签
- 连续、单页和双页阅读，支持键盘翻页、全屏、缩放和独立阅读窗口
- 本地 OCR：中文优先使用 Apple Vision，日文优先使用 `comic-text-detector` 与 `manga-ocr`
- 可选 DeepSeek 翻译：翻译识别出的日文对话与标题，并在图片上排版和预翻译

基于 Tauri 2 构建。

## 本地运行

需要 [Node.js](https://nodejs.org/)、[Rust](https://www.rust-lang.org/tools/install) 和 [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
git clone https://github.com/yuxino/wnacg.git
cd wnacg
npm ci
npm run tauri dev
```

打包：

```bash
npm run tauri build
```

DeepSeek 翻译是可选云端功能：启用后，待翻译的文字与标题会发送给 DeepSeek，图片不会发送；原文与译文缓存在本机。密钥在 macOS 保存到钥匙串，非 macOS 请使用 `DEEPSEEK_API_KEY`，因为界面暂不支持安全保存。

OCR 在本机运行。首次启用日文漫画 OCR 会从 Hugging Face 下载约 224 MiB 固定版本模型，并用 Rust 编译辅助程序；Apple Vision 仅适用于 macOS，首次使用还需要 Xcode Command Line Tools。

仓库暂未附项目级开源许可证；OCR 模型及训练数据也尚未完成正式分发许可审查。自动下载不等同于取得再分发授权。

## 说明

项目会连接 WNACG 及其图片域名，并依赖上游页面结构；站点改版后功能可能失效。请自行遵守所在地法律与站点规则，Issue、提交和截图中不要包含露骨内容。
