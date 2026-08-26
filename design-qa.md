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

---

# Design QA — generation-node model selector styling

Source visual truth: `C:\\Users\\Administrator\\AppData\\Local\\Temp\\codex-clipboard-6697cc15-7294-4c04-ab56-051447cd5fc8.png`.

Implementation evidence:

- Full browser capture: `D:\\Codex-CPD无限画布网站\\AI网站开发\\qa-node-model-select-dark-centered.png`
- Focused selector capture: `D:\\Codex-CPD无限画布网站\\AI网站开发\\qa-node-model-select-detail.png`
- Source pixels: 248 × 252 px.
- Implementation full-view pixels/CSS viewport: 1969 × 1272 px at device scale factor 1.
- Focused implementation pixels: 340 × 160 px.
- State: dark canvas, API Mart image workflow, idle image-generation node with its model selector visible.
- Full-view comparison evidence: source and implementation were opened together in one comparison input; the updated selector remains visually subordinate to the node while clearly distinct from the header surface.
- Focused comparison evidence: the source crop and the 340 × 160 implementation crop were compared together to verify control color, centering, border, radius, and typography.

**Findings**

- No actionable P0, P1, or P2 differences remain for the requested selector treatment.
- Fonts and typography: the existing compact node type is preserved; selected text and menu options are centered with the same weight and truncation behavior.
- Spacing and layout rhythm: selector height remains 27 px, padding is symmetrical, and the field remains aligned with the node icon and delete action.
- Colors and visual tokens: the selector uses `#10161e`, darker than the node's navy surface; hover/focus uses `#0c1118`, and menu options use `#0d131b`.
- Image quality and assets: no raster or icon asset changes were required; the existing icon treatment is preserved.
- Copy and content: model names and ordering are unchanged.

**Interaction checks**

- Hover and focus states retain the existing interaction behavior with a restrained light border and focus halo.
- Disabled state remains visible and uses the existing wait cursor while generation is running.
- Browser console errors: none.
- Production build: passed.
- Lint: passed.

**Follow-up Polish**

- Native operating-system select popovers are not included in page screenshots; their option background, foreground, and centered alignment are explicitly set in CSS and inherit dark color-scheme rendering.

final result: passed

---

# Design QA — node-local model and output controls

Source visual truth: the user's annotated browser screenshot for the current canvas generation node (`browser:Selected browser region`, 1969 × 1272 px).

Implementation evidence:

- Image workflow: `D:\\Codex-CPD无限画布网站\\AI网站开发\\qa-node-model-settings-image.png`
- Video workflow: `D:\\Codex-CPD无限画布网站\\AI网站开发\\qa-node-model-settings.png`
- Browser viewport: 1969 × 1272 px.
- State: API Mart mode, idle generation nodes, connected reference and prompt nodes.

## Visual fidelity

- The model selector now occupies the requested upper-left header position inside image and video generation nodes.
- The selector reuses the existing dark node surface, compact typography, border radius, icon rhythm, and restrained hover/focus treatment.
- Image output clarity is presented directly below the preview as compact 1K/2K/4K choices, before the aspect-ratio controls.
- Video output resolution and duration remain inside the video node and update when the selected video model changes.
- The API settings modal no longer duplicates API Mart model and clarity controls; connection mode, API key, response parsing, and request-template fields remain available.

## Interaction and state checks

- Switching the image node from Nano Banana Pro to Seedream 5.0 Lite updated its supported clarity choices to 2K/3K/4K.
- Switching the video node to MiniMax H3 updated its supported output choices to 768P/2K and reset duration to the model default.
- Each image/video node retains its own selected model and output setting instead of being overwritten by the global API configuration on render.
- Image generation requests now use the node-local model and clarity.
- Video generation requests now use the node-local model, resolution, and duration.
- Selectors and output controls are disabled while their node is generating.

## Quality checks

- Browser console errors: none.
- Production build: passed.
- Lint: passed.
- No actionable P0, P1, or P2 visual or functional findings remain for this scoped change.

final result: passed

---

# Design QA — expandable generation-node model menu

Source visual truth: `C:\\Users\\Administrator\\AppData\\Local\\Temp\\codex-clipboard-725c484b-3ba4-4a92-8095-bf0c0b9c94ad.png`.

Implementation evidence:

- Full browser capture: `D:\\Codex-CPD无限画布网站\\AI网站开发\\qa-node-model-menu-expanded-zoomed.png`
- Focused matching-state capture: `D:\\Codex-CPD无限画布网站\\AI网站开发\\qa-node-model-menu-expanded-matching.png`
- Source pixels: 349 × 266 px.
- Implementation full-view pixels/CSS viewport: 1969 × 1272 px at device scale factor 1.
- Focused implementation pixels: 419 × 350 px; the canvas was zoomed for a readable control-level comparison.
- State: API Mart image-generation node, GPT Image 2 selected, model menu expanded.
- Full-view comparison evidence: the expanded menu overlays the node preview without changing node size, obscuring persistent controls, or being clipped by the node shell.
- Focused comparison evidence: source and implementation matching-state crops were opened together in one comparison input; both show the selected model in the fixed-size trigger and the full centered list directly beneath it.

**Findings**

- No actionable P0, P1, or P2 differences remain for the requested interaction.
- Fonts and typography: model names use the existing node font family and remain centered, readable, and unwrapped.
- Spacing and layout rhythm: the trigger preserves its collapsed dimensions; the menu expands downward with consistent row heights and retracts after selection.
- Colors and visual tokens: the menu remains in the node's dark tonal family, with the current model highlighted in the reference blue.
- Image quality and assets: the existing Lucide chevron is used and rotates to communicate expanded/collapsed state; no raster assets were introduced.
- Copy and content: all configured image and video model names remain unchanged.

**Interaction checks**

- Clicking the image model field opens the complete image-model list.
- Selecting GPT Image 2 changes the node model and immediately removes the listbox; `aria-expanded` returns to `false`.
- Clicking a control outside the menu closes it without changing the selected model.
- The same open/select/auto-close behavior was verified on the video node with MiniMax H3.
- Escape and generation-start close paths are implemented, and the trigger is disabled while generating.
- Browser console errors: none.
- Production build: passed.
- Lint: passed.

**Follow-up Polish**

- No P3 follow-up is required for this scoped change.

final result: passed
