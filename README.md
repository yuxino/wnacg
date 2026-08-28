<div align="center">
  <br>
  <img src="src-tauri/icons/kiri/128x128@2x.png" width="112" alt="wnacg">
  <h1>wnacg</h1>
  <p><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
  <p>一个更舒服的 wnacg 桌面阅读器，带本地 OCR 与漫画翻译。</p>
</div>

> 18+。仓库和安装包不包含第三方漫画、图片内容或 OCR 模型权重。自动构建的安装包（如有）以 [Releases](https://github.com/yuxino/wnacg/releases) 为准；当前未做平台公证或商店签名。

## 功能

- 分类、关键词与标签搜索，封面加载完成后直接清晰展示
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

DeepSeek 密钥可在应用的阅读设置中配置，并安全保存在 macOS 钥匙串。旧版 `config.json` 只会在密钥成功写入并回读确认后清除明文字段；`DEEPSEEK_API_KEY` 仅作为兼容输入。Windows 版目前不能从界面安全保存密钥。

漫画 OCR 模型不随安装包分发。首次启用会下载约 224 MiB 固定版本模型，并在本机用 Rust 编译辅助程序，因此安装版也需要 Rust 工具链；编译成功后会清理临时 Cargo 产物，只长期保留模型和精简后的辅助程序缓存。Apple Vision OCR 仅适用于 macOS，首次编译助手还需要 Xcode Command Line Tools。

当前仓库未附项目级开源许可证，OCR 模型及训练数据的许可也尚未完成正式分发审查。自动下载不等同于已取得再分发授权，正式发布前需要逐项确认。

## 说明

项目依赖上游站点，页面改版后可能失效。请自行遵守所在地法律与站点规则，Issue、提交和截图中不要包含露骨内容。
