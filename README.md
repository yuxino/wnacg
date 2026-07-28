<div align="center">
  <img src="src-tauri/icons/icon.png" width="112" alt="wnacg 图标">
  <h1>wnacg</h1>
  <p><strong>为桌面重新整理的安静阅读体验</strong></p>
  <p>
    Tauri 2 · TypeScript · Rust
  </p>
  <p>
    <a href="#从源码构建">从源码构建</a>
    · <a href="#功能">功能</a>
    · <a href="#使用边界">使用边界</a>
  </p>
</div>

<br>

![wnacg 的连续阅读页，图片已隐藏](docs/images/wnacg-reader-masked.jpg)

wnacg 把浏览、搜索和连续阅读收进一个桌面窗口。它会记住阅读位置与显示偏好，也可以把作品放进独立窗口，留在手边慢慢看。

> **仅限成年人。** 本项目只提供源码，用于编程学习与技术研究；不提供安装包，也不托管任何第三方内容。截图中的封面与阅读内容均已隐藏。

## 功能

<table>
  <tr>
    <td width="33%">
      <strong>快速找到内容</strong><br><br>
      分类、关键词搜索、标签跳转和连续加载集中在同一处。
    </td>
    <td width="33%">
      <strong>专注连续阅读</strong><br><br>
      调整宽度、间距、主题和预加载策略，点击图片即可放大。
    </td>
    <td width="33%">
      <strong>保持本地与轻量</strong><br><br>
      阅读设置和最近进度保存在本机，不要求注册账号。
    </td>
  </tr>
</table>

![wnacg 的作品列表，封面已隐藏](docs/images/wnacg-library-masked.jpg)

### 阅读体验

- 瀑布流连续阅读与全屏查看
- 图片缩放、进度提示和失败重试
- 阅读位置自动记录
- 作品可在独立窗口中打开
- 菜单栏常驻，关闭窗口后可以快速回来

## 从源码构建

需要 [Node.js](https://nodejs.org/)、[Rust](https://www.rust-lang.org/tools/install)，以及 [Tauri 2 的系统依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
git clone https://github.com/yuxino/wnacg.git
cd wnacg
npm install
npm run tauri dev
```

构建当前平台的应用：

```bash
npm run tauri build
```

> 仓库不发布预编译安装包。构建与运行前，请先确认自己已年满 18 周岁并理解下方的使用边界。

## 使用提示

- 在列表底部继续滚动会自动加载更多内容
- 点击标签可以查找同类内容
- 阅读时按空格键可以继续向下翻页
- 页面暂时无法载入时，可以点击右上角的刷新按钮
- 关闭窗口不会退出应用；需要完全退出时请使用菜单栏图标

## 使用边界

<details>
<summary><strong>使用前请阅读：仅限 18 周岁以上使用者</strong></summary>

<br>

- 本项目仅供学习与技术研究，不鼓励、不协助传播违法或侵权内容
- 未满 18 周岁者不得下载、构建、运行或以其他方式使用本项目
- 使用者应自行确认其行为符合所在地法律、内容来源条款及相关平台规则
- 不得使用本项目访问、保存或传播涉及未成年人的性内容、非自愿私密内容或其他违法内容
- 项目不提供、不上传、不托管第三方作品；内容由使用者所访问的第三方来源提供
- 第三方内容可能受到著作权及其他权利保护；请勿复制、再分发或用于商业用途
- 项目维护者无法控制第三方来源的可用性、安全性与内容，也不对使用者的具体行为背书

免责声明不能替代法律。若你无法判断某项使用是否合法，请停止使用并咨询所在地的专业人士。

</details>

## 参与开发

欢迎提交 [Issue](https://github.com/yuxino/wnacg/issues) 和 Pull Request。请勿在 Issue、PR 或截图中上传露骨内容。
