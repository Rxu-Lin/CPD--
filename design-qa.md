# 多角度编辑器暗色模型菜单 Design QA

## Findings

- 无 P0 / P1 / P2 问题。
- 本轮只调整模型选择的展开层视觉与交互，没有改变模型来源、生成逻辑或编辑器布局。

## 对照证据

- source visual truth path: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-6fb28d7e-07e3-45cc-af95-ea8487a3033d.png`，687 × 413px，截图显示原生下拉菜单为白色，与暗色编辑器不一致。
- implementation screenshot path: Codex in-app Browser transient capture, QA URL `http://127.0.0.1:5174/?multi-angle-select-qa=1`（浏览器内截图已检查；临时 QA 入口已删除）。
- viewport: 1280 × 720；devicePixelRatio 1.5。
- source and implementation normalization: 源图是局部裁切；实现同时检查 1280 × 720 全弹窗和同一模型菜单区域，CSS 像素按 1.5 DPR 渲染，无额外缩放。
- state: 多角度编辑器打开，自定义视角 0° / 0°、中景，模型菜单展开，7 个 API Mart 图像模型可见。
- full-view comparison evidence: 完整弹窗截图确认暗色菜单没有改变预设、角度球、参考图、参数、摘要和底部操作的比例与位置。
- focused region comparison evidence: 源图与展开后的实现截图在同一次比较中并列检查；实现菜单背景为 `rgb(13, 19, 27)`，边框为 `rgba(205, 214, 224, 0.24)`，选中项为低亮度青色暗底。

## Fidelity Surfaces

- Fonts and typography: 沿用应用系统字体；菜单项 13px、560 字重，选中项 680 字重，长模型名保持单行可读。
- Spacing and layout rhythm: 触发框继续保持 42px 高与 9px 圆角；菜单间距 6px、内边距 4px、单项最小高度 36px，与现有模型菜单一致。
- Colors and visual tokens: 触发框与菜单均使用 `#0d131b` 深色表面；悬停为低对比白色叠层，选中项为 `rgba(97, 199, 232, 0.14)`，没有白色系统面板。
- Image quality and asset fidelity: 本轮没有新增或替换图片资产；参考图、网格和摄像机图标保持原样。
- Copy and content: 所有模型名称完整保留，当前视角摘要与生成按钮继续显示所选模型。

## 交互与状态测试

- 点击触发框后，深色菜单展开并正确标记 `Nano Banana Pro` 为当前选项。
- 点击 `GPT Image 2` 后，菜单收起，触发框和当前视角摘要同步更新。
- 菜单打开时按 Escape 只收起菜单，编辑器保持打开。
- 菜单使用 `listbox` / `option` 语义，触发按钮提供展开状态和当前模型描述。
- 控制台无 error 或 warning。

## Comparison History

- 初始问题（P2）：操作系统原生下拉展开层为白色，文字对比异常，与整个暗色弹窗明显割裂。
- 修复：替换为应用现有模型选择器同类的自定义暗色菜单，并增加暗色选中、悬停、滚动和键盘关闭状态。
- 修复后证据：展开状态截图与源图同次并列检查，白色面板已消失；完整弹窗无新增遮挡或布局回退。

## Verification

- `npm run build`: passed。
- `npm run lint`: passed。
- `node --test tests/*.test.mjs`: 32 passed, 0 failed, 2 skipped。

final result: passed
