# Kiri 品牌资产

wnacg 的品牌方向参考 mimi 的资产组织方式：固定角色母图、应用图标和产品状态图共用同一角色设定；极小尺寸的系统托盘继续使用独立的单色功能符号，不把复杂角色硬缩进去。

## 固定设定

- 成年 chibi 漫画看板娘 Kiri。
- 白色短发、右侧细辫与黑色小蝴蝶结。
- 淡紫色眼睛；其余以白、炭黑和中性灰为主。
- 一只黑色兔耳直立，另一只自然折下，作为最稳定的轮廓识别点。
- 始终与打开的漫画或翻译动作建立关系，不加入产品外的装饰主题。
- UI 保持克制的黑白体系；角色只承担品牌与空状态，不扩张成界面大面积主题色。

## 文件

- `kiri-master.png`：角色徽章母图，后续角色生成的唯一视觉参考。
- `kiri-app-icon-source.png`：带圆形透明边缘的桌面应用图标源图。
- `../../../public/brand/kiri-icon-128.png`：界面和 favicon 使用的小图。
- `../../../src-tauri/icons/kiri/128x128@2x.png`：README 与 Tauri 共用的 256 像素图标。
- `../../../src-tauri/icons/kiri/`：Tauri 桌面版其余 PNG、macOS ICNS 与 Windows ICO 派生图标。

## 生成方法

母图使用 OpenAI ImageGen 的生成模式建立；应用图标使用母图作为图像参考派生。核心提示词固定角色特征、黑白中性调、淡紫色小面积点缀、漫画阅读动作、无文字、无渐变。产品字标由界面排版完成，不让图像模型生成文字。

从仓库根目录重新生成桌面图标：

```bash
npm run tauri -- icon docs/brand/kiri/kiri-app-icon-source.png --output src-tauri/icons/kiri
```

命令会同时生成移动端和商店占位图；本项目只保留 `tauri.conf.json` 引用的桌面 PNG、ICNS 与 ICO 文件。
