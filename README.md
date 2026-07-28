# wnacg

wnacg 的桌面客户端。

<img src="docs/images/wnacg-mascot.png" width="180" alt="wnacg 看板娘">

分类、关键词和标签都能搜。点进去以后直接往下看，阅读位置和显示设置会存在本机。

> 仅限成年人使用。仓库只有源码，没有安装包。

## 截图

![作品列表，封面已做高斯模糊](docs/images/wnacg-library-masked.jpg)

![连续阅读页，图片已做高斯模糊](docs/images/wnacg-reader-masked.jpg)

## 运行

需要 [Node.js](https://nodejs.org/)、[Rust](https://www.rust-lang.org/tools/install) 和 [Tauri 2 的系统依赖](https://v2.tauri.app/start/prerequisites/)。

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

项目用 Tauri 2，前端是 TypeScript，抓取和图片代理在 Rust 里。

## 说明

仓库里没有第三方内容，也不会替你上传或者保存。用的时候自己看所在地法律和站点规则；侵权内容别存、别传，涉及未成年人或非自愿私密内容的东西更不要碰。

上游改版以后项目可能会坏。有问题可以开 Issue，想改直接提 PR。Issue、提交和截图里不要放露骨内容。
