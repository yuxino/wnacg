# wnacg

wnacg 的桌面阅读器，支持分类、搜索、标签、连续阅读和阅读进度保存。

<img src="docs/images/wnacg-mascot.png" width="180" alt="wnacg 看板娘">

没有账号，也没有自己的服务端。阅读位置和设置都存在本机。

> 18+。这里只放源码，不放安装包。截图也都糊过了。

## 截图

首页。左边选分类或者搜索，右边往下翻。

![作品列表，封面已做高斯模糊](docs/images/wnacg-library-masked.jpg)

点开以后就是一条往下看。宽度、间距、背景和预加载都能调，也可以扔到单独的窗口里。

![连续阅读页，图片已做高斯模糊](docs/images/wnacg-reader-masked.jpg)

## 有什么

- 分类、关键词、标签搜索
- 连续阅读、全屏和缩放
- 自动记住阅读位置和显示设置
- 独立阅读窗口
- macOS 菜单栏

壳是 Tauri 2，界面用 TypeScript，抓取和图片代理在 Rust 里。

## 本地跑

先装好 [Node.js](https://nodejs.org/)、[Rust](https://www.rust-lang.org/tools/install) 和 [Tauri 2 的系统依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
git clone https://github.com/yuxino/wnacg.git
cd wnacg
npm install
npm run tauri dev
```

自己打包：

```bash
npm run tauri build
```

我不会发预编译版本。真要用，先看看代码，再自己打。

## 先说好

<details>
<summary>点开看</summary>

<br>

这是个自用的学习项目，不是内容分发工具，只给成年人用。

- 仓库不提供、上传或托管第三方作品
- 请遵守所在地法律和上游站点的规则
- 不要访问、保存或传播涉及未成年人的性内容、非自愿私密内容，以及其他违法内容
- 第三方作品可能受著作权保护，不要拿去再分发或商用
- 上游改版或者挂了，这里也可能跟着不能用

</details>

## 改改看

Issue 和 PR 都可以。别往讨论、提交和截图里塞露骨内容就行。
