<div align="center">
  <br>
  <img src="public/brand/kiri-icon-256.png" width="112" alt="wnacg">
  <h1>wnacg</h1>
  <p><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
  <p>一个更舒服的 wnacg 桌面阅读器，带本地 OCR 与漫画翻译。</p>
</div>

> 18+。仓库仅提供源码，不包含第三方内容或安装包。

## 截图

![作品列表](docs/images/wnacg-library-masked.jpg)

![连续阅读](docs/images/wnacg-reader-masked.jpg)

![翻译前](docs/images/wnacg-translate-before.jpg)

![翻译后](docs/images/wnacg-translate-after.jpg)

## 功能

- 分类、关键词、标签搜索，封面默认模糊
- 连续阅读、全屏、缩放、多窗口，自动保存阅读位置
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

翻译功能读取 `~/Library/Application Support/wnacg/config.json` 中的 `deepseekApiKey`，也可以通过 `DEEPSEEK_API_KEY` 环境变量配置。

## 说明

项目依赖上游站点，页面改版后可能失效。请自行遵守所在地法律与站点规则，Issue、提交和截图中不要包含露骨内容。
