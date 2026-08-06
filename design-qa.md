# Design QA

Source visual truth: the current AI canvas workbench at `http://127.0.0.1:5174/`, captured before the outpaint node was added.

Comparison evidence:

- Source screenshot: `D:\Codex-CPD无限画布网站\AI网站开发\qa-source-current.png`
- Implementation screenshot: `D:\Codex-CPD无限画布网站\AI网站开发\qa-implementation-outpaint-final.png`
- Side-by-side comparison: `D:\Codex-CPD无限画布网站\AI网站开发\qa-outpaint-comparison.png`
- Canvas menu verification: `D:\Codex-CPD无限画布网站\AI网站开发\qa-canvas-menu-ai-outpaint.png`
- Viewport: 1935 × 1280 px.

## Visual fidelity

- Layout and spacing: the new 410 px outpaint node follows the existing workflow-node shell, header rhythm, 12 px content gutters, 8–10 px control spacing, 14 px card radius, and canvas connection pattern.
- Typography: labels, metadata, textarea copy, buttons, and pixel outputs reuse the workbench's existing small-scale hierarchy and neutral system font stack without clipping.
- Colors and surfaces: the node keeps the existing dark navy-black surface, metallic neutral border, restrained white/gray states, and the existing canvas grid. No new decorative palette or unrelated visual language was introduced.
- Icons: the Lucide Expand icon matches the stroke weight and optical size of the existing Image, Brush, Upload, and Delete icons.
- Image treatment: the source image is displayed at its exact protected rectangle; the generated result fills only the target canvas behind it. The original is composited back at native protected coordinates after generation.
- Copy: all controls are concise and standalone: `AI 扩图`, `扩展范围`, `原图保护区`, four-direction pixel values, ratio presets, `恢复默认`, and `运行扩图` accessibility label.

## Interaction and state checks

- Right-clicking the blank canvas shows `AI扩图` as the fourth creation action; image nodes no longer expose a right-click outpaint action.
- Creating an outpaint node from the canvas menu produces an independent node, and connecting an image automatically synchronizes its protected region and pixel dimensions.
- Default prompt is prefilled and editable; `恢复默认` restores it.
- Ratio presets verified: `9:16` produced 456 × 811 px from the test source.
- Boundary dragging verified: moving the right handle changed 456 × 811 px to 461 × 811 px and activated `自由` mode.
- All four edges and four corners are present as semantic buttons with accessible labels and resize cursors.
- Target dimensions are capped at 4096 px on the longest edge.
- Local mock generation completed without an error, kept the result in the outpaint node, protected the source rectangle, and added a successful generation-history entry.
- The original GrsAI API mode was restored after the safe local test.
- Empty, generating, completed, invalid-range, and generation-error paths are implemented.
- Reduced-motion behavior remains unchanged because the new interaction does not add decorative motion.

## Quality checks

- Browser console errors: none.
- Production build: passed.
- Lint: passed.
- Invalid model sizes and unsupported reference-image formats are rejected before an upstream request; upstream 400 responses now preserve their concrete error message and request summary.
- No actionable P0, P1, or P2 visual or functional findings remain for this scoped feature.

final result: passed
