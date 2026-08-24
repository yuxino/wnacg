<div align="center">
  <br>
  <img src="public/brand/kiri-icon-256.png" width="112" alt="wnacg">
  <h1>wnacg</h1>
  <p><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
  <p>一个更舒服的 wnacg 桌面阅读器，带本地 OCR 与漫画翻译。</p>
</div>

> 18+。仓库仅提供源码，不包含第三方内容或安装包。

## 功能

- 分类、关键词、标签搜索，封面默认模糊
- 连续、单页与双页阅读，支持左右翻页、全屏、缩放和多窗口
- 本地 OCR：Apple Vision + `comic-text-detector` + `manga-ocr`
- DeepSeek 漫画翻译：支持竖排日文、气泡内排版与预翻译

基于 Tauri 2，界面使用 TypeScript，抓取与图片代理在 Rust 侧完成。

## 本地运行

需要 [Node.js](https://nodejs.org/)、[Rust](https://www.rust-lang.org/tools/install) 和 [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)。macOS 使用本地 OCR 时还需要 Xcode Command Line Tools。

```bash
git clone https://github.com/yuxino/wnacg.git
cd wnacg
npm install
npm run tauri dev
```

打包：

```bash
npm run tauri build
```

DeepSeek 密钥可在应用的阅读设置中配置，并安全保存在 macOS 钥匙串。旧版的 `config.json` 或 `DEEPSEEK_API_KEY` 环境变量会在首次读取时自动迁移。

## 说明

项目依赖上游站点，页面改版后可能失效。请自行遵守所在地法律与站点规则，Issue、提交和截图中不要包含露骨内容。
