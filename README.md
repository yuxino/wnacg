<table>
  <tr>
    <td width="34%" align="center">
      <img src="docs/images/wnacg-mascot.png" width="250" alt="wnacg 看板娘">
    </td>
    <td width="66%">
      <h1>wnacg</h1>
      <p><strong>把 wnacg 搬到桌面上。</strong></p>
      <p>平时看 wnacg 总得在浏览器里开一堆页面，索性给自己写了个桌面版。</p>
      <p><a href="#自己构建">怎么跑起来</a> · <a href="#使用边界">使用前看看</a></p>
    </td>
  </tr>
</table>

现在能翻列表、搜作品，也能直接连续阅读。没有账号，阅读位置和显示设置都存在本机。

> 这个项目只适合成年人。仓库只放源码，不提供安装包。下面的截图已经做了高斯模糊。

## 长什么样

先在列表里找。可以按分类翻，也可以直接搜关键词；滚到底会继续加载。

![作品列表，封面已做高斯模糊](docs/images/wnacg-library-masked.jpg)

点开一本之后就是连续阅读。工具栏里可以调宽度、间距、背景和预加载，也可以单独开一个窗口放在旁边。

![连续阅读页，图片已做高斯模糊](docs/images/wnacg-reader-masked.jpg)

## 现在有这些

- 分类、关键词和标签搜索
- 连续阅读、全屏、缩放和失败重试
- 阅读位置与显示偏好自动保存
- 独立阅读窗口
- macOS 菜单栏常驻

没有账号系统，也没有服务端。前端是 TypeScript，抓取和图片代理在 Rust 里，外面套了一层 Tauri 2。

## 自己构建

先准备好 [Node.js](https://nodejs.org/)、[Rust](https://www.rust-lang.org/tools/install) 和 [Tauri 2 需要的系统依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
git clone https://github.com/yuxino/wnacg.git
cd wnacg
npm install
npm run tauri dev
```

需要打包时：

```bash
npm run tauri build
```

仓库不会发布预编译版本。想试的话，请自己看过代码再构建。

## 使用边界

<details>
<summary>使用前请读一下</summary>

<br>

- 仅限 18 周岁以上使用者
- 这个项目只用于学习和技术研究，不应用来传播违法或侵权内容
- 请自行确认使用行为符合所在地法律、内容来源条款和平台规则
- 不得访问、保存或传播涉及未成年人的性内容、非自愿私密内容及其他违法内容
- 项目不提供、不上传、不托管第三方作品
- 第三方内容可能受著作权保护，请勿复制、再分发或用于商业用途
- 上游站点的内容和可用性不受本项目控制

如果拿不准某种用法是否合法，就不要使用。

</details>

## 参与开发

Issue 和 Pull Request 都欢迎。请不要在讨论、提交或截图里上传露骨内容。
