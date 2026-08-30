# Windows OCR 初始化修复

## 已证实的问题

Windows 安装包此前没有漫画 OCR helper。用户第一次开启日文 OCR 时，应用会在本机调用 Cargo 编译 helper，因此没有 Rust 工具链的普通用户必然失败。中文优先模式实际依赖 Apple Vision，也不应在 Windows 上尝试调用 `swiftc`。

模型缓存原先位于 `%LOCALAPPDATA%\\wnacg\\ocr-models`，与 Windows 默认的按用户安装目录重叠，更新或卸载可能把约 224 MiB 模型一起清掉。前端还在每次进程启动时无条件显示“首次下载”，即使后端只是重新计算模型哈希，也会让用户误以为正在重复下载。

## 采用的方案

Windows 构建先生成 release helper，并把微软官方 CPU 版 ONNX Runtime 与 VC++ app-local 运行库一起作为 Tauri resource 打进 MSI/NSIS。运行库资产固定版本与 SHA-256，并随包保留许可证和第三方声明。CPU 包不依赖 DirectML，避免额外约 18 MiB 文件和更高的 Windows 版本要求。运行时直接使用安装包资源；正式版不再要求用户安装 Rust。模型不进入安装包，继续在首次使用时下载。

Windows 模型目录迁到应用标识符隔离的 `%LOCALAPPDATA%\\com.yuxino.wnacg\\ocr-models`，首次运行兼容迁移旧缓存。每个应用进程只做一次完整 SHA-256 校验；文件通过校验就直接复用，只有缺失、损坏或版本变化时才重新下载。检查阶段与真正的下载阶段使用不同进度文案，不再把校验误报成下载。

模型下载改为应用内 HTTPS 流式下载：保留 `.part`、使用 Range 续传、限制来源与精确大小、下载完成后校验 SHA-256，再原子安装。初始化通过事件报告检查、迁移、下载、校验和完成状态，前端用同一个通知展示真实总进度。

## 验证边界

本地验证覆盖模型完整性、损坏重验、断点状态与前端构建；Windows CI 必须实际构建 helper，启动它以证明依赖可加载，并从 MSI 文件表确认 helper、运行库和许可证都已入包。CI 与 PE 检查能证明 x64 构建和打包链，不能代替独立 Windows 设备上的完整图片 OCR 验收。
