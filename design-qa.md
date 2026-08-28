# API 模式下拉框视觉检查

- Source visual truth: `C:\Users\Administrator\AppData\Local\Temp\codex-clipboard-47be2ffe-f4ef-4845-b0e8-49a945f135a5.png`
- Implementation screenshot: `D:\Codex-CPD无限画布网站\AI网站开发\api-mode-implementation.png`
- Focused comparison: `D:\Codex-CPD无限画布网站\AI网站开发\api-mode-comparison.png`
- Browser viewport: 1969 × 1272 CSS px
- Source pixels: 506 × 274 px
- Implementation modal capture: 720 × 437 px at device scale 1
- Focused comparison normalization: implementation control crop 242 × 170 px, scaled to 390 × 274 px beside the 506 × 274 px source
- State: API 设置窗口打开，模式菜单展开，本地模拟为当前选项

## Full-view comparison evidence

`api-mode-implementation.png` shows the complete API settings dialog. The custom menu remains inside the dialog layout, all four options are visible, and the footer is not covered or clipped.

## Focused region comparison evidence

`api-mode-comparison.png` places the supplied source and the rendered mode control together. The implementation replaces the browser-native gray popup with a deeper `#0b1016` menu, uses the API modal's strong border token, preserves the existing cyan focus ring, and uses a restrained dark selected row.

## Required fidelity surfaces

- Fonts and typography: Existing application font, size, weight, line height, and single-line labels are preserved. No wrapping or truncation is visible.
- Spacing and layout rhythm: The control keeps the existing field height and radius. The expanded menu uses 4 px inset padding, 2 px row gaps, and pushes the modal layout instead of overlapping its footer.
- Colors and visual tokens: Menu border uses `var(--line-strong)`. The menu background is intentionally darker than the API modal while keeping foreground contrast and the existing accent focus state.
- Image quality and asset fidelity: No new raster or decorative assets are required for this control. The existing Lucide chevron/check icons render sharply.
- Copy and content: All four API mode labels match the existing application copy.

## Comparison history

- First rendered pass — P2: the absolutely positioned menu was clipped by the modal's scroll boundary in the shorter local-simulation state.
- Fix: changed the menu to participate in layout flow so the modal expands while the menu is open.
- Post-fix evidence: `api-mode-implementation.png` shows the complete four-option menu and unobstructed footer; `api-mode-comparison.png` confirms the requested darker palette and matching border treatment.

## Interaction and runtime checks

- Opened the API settings dialog.
- Expanded the API mode control and verified four visible options.
- Selected the current option and verified the menu automatically collapsed.
- Lint and production build passed.
- Browser console check found only the local Vite HMR WebSocket reconnect warning; no application runtime error was introduced.

## Findings

No actionable P0, P1, or P2 differences remain for the requested color and border adjustment.

## Follow-up polish

No required P3 changes.

final result: passed
