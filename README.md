<div align="center">
  <img src="src-tauri/icons/icon.png" width="88" alt="wnacg">
  <h1>wnacg</h1>
  <p>为桌面重新做的 WNACG 阅读器</p>
  <p>
    <a href="https://github.com/yuxino/wnacg/releases/latest"><strong>下载 wnacg</strong></a>
  </p>
</div>

<br>

![wnacg 的连续阅读页，图片已隐藏](docs/images/wnacg-reader-masked.jpg)

<br>

wnacg 把作品浏览、搜索和阅读整理进一个安静的桌面窗口。

从分类或关键词找到作品，点开后直接连续阅读。应用会记住阅读位置和显示偏好；想把一本作品留在旁边，也可以在独立窗口中打开。

> 截图中的封面已隐藏。项目面向成年人，请只在符合当地法律及内容来源条款的前提下使用。

<table>
  <tr>
    <td><img src="docs/images/wnacg-library-masked.jpg" alt="wnacg 的作品列表，封面已隐藏"></td>
  </tr>
  <tr>
    <td align="center">搜索、分类和翻页都在同一个窗口里</td>
  </tr>
</table>

## 开始使用

1. 从 [Releases](https://github.com/yuxino/wnacg/releases/latest) 下载适合系统的安装包
2. 打开应用，选择分类或搜索关键词
3. 点击作品封面开始阅读

如果页面暂时无法载入，可以点击右上角的刷新按钮。站点镜像或网络环境变化时，内容可能短暂不可用。

## 为阅读留出空间

- 瀑布流连续阅读，点击图片可以放大查看
- 调整内容宽度、图片间距、主题和预加载数量
- 全屏阅读与图片缩放
- 自动记录最近阅读位置
- 作品可在独立窗口中打开
- 菜单栏常驻，关闭窗口后可快速回来

阅读设置和进度保存在本机。应用不要求注册账号，也不提供或托管内容；列表、详情和图片来自第三方站点。

## 使用提示

- 在列表底部继续向下滚动，会自动加载更多作品
- 点击标签可以查看同类作品
- 阅读时按空格键可以继续向下翻页
- 关闭窗口不会退出应用；需要完全退出时请使用菜单栏图标

<details>
<summary>从源码构建</summary>

需要 [Node.js](https://nodejs.org/)、[Rust](https://www.rust-lang.org/tools/install)，以及 [Tauri 2 的系统依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
git clone https://github.com/yuxino/wnacg.git
cd wnacg
npm install
npm run tauri dev
```

构建安装包：

```bash
npm run tauri build
```

</details>

## 参与开发

欢迎提交 [Issue](https://github.com/yuxino/wnacg/issues) 和 Pull Request。请勿在 Issue、PR 或截图中上传露骨内容。
