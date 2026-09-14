# Codex 接手说明

## 当前版本

- 项目：AI 画布工作台 / CPD AI 无限画布网站。
- 打包时间（北京时间）：20260914-012642。
- 当前分支：codex/update-online-20260826。
- 最近提交：6a1518b60a189832f0aed9fb5ee006e277c59919。
- 此包包含上述提交之后的全部本地修改和未跟踪工作文件；实际功能以 src 等当前工作文件为准。
- 原有旧版迁移说明保存在 交接资料/原迁移说明（历史参考）.md；新设备操作以 迁移到新设备.md 为准。

## 项目结构

- React + TypeScript + Vite，React Flow 无限画布；GSAP 动画；Three.js 3D 场景。
- src/App.tsx、src/App.css：主工作台、节点、生成流程、API 设置、历史记录、项目导入导出。
- src/SketchStudio.tsx、src/sketchDocument.ts：手绘画板、图层与可编辑文档。
- src/Model3DStudio.tsx、src/model3dSceneStore.ts：3D 编辑和 IndexedDB 持久化。
- src/canvasMediaClipboard.ts、src/workflowPrompts.ts：媒体复制粘贴与节点提示词。
- vite.config.ts：同域生成 API 代理、项目 ZIP 打包导入、素材缓存及开发/生产服务插件。
- server.mjs：通过 Vite preview 启动生产服务，默认端口 4173。
- scripts/start-server.mjs：Windows 后台一键启动；开发访问地址为 http://127.0.0.1:5174/ 。
- tests/：现有剪贴板、3D 存储、手绘画板、提示词工作流测试。

## 验证与注意事项

- 原目录已用 Node v24.18.0 / npm 11.16.0 执行 npm run build 成功。
- 原目录执行 node --test tests/*.test.mjs：31 项通过、0 项失败、2 项因可选像素模块/本地集成测试环境未启用而跳过。
- 构建提示部分 JavaScript 块超过 500 kB，不影响本次构建完成。
- 在全新解压目录中执行 npm ci --no-audit --no-fund（安装 119 个包）和 npm run build，均成功。
- Git 完整性检查通过；将迁移副本中的长 Git 引用路径改为 packed-refs，并启用 core.longpaths，全部原有 Git 引用与提交保持一致。
- 每个 ZIP 文件内容均按 SHA-256 校验；完整验证记录见包内 交接资料/打包验证记录.md。
- 网站需要 Node 服务提供 API 代理；不能将其当作纯静态页面运行。
- package.json 的最低 Node 范围较宽；本次依赖中的 Vite 要求 ^20.19.0 || >=22.12.0。迁移统一使用 Node 24.x。
- API 密钥由用户在浏览器设置中填写。界面支持本地模拟模式，可在没有密钥时检查流程。

## 打包时 Git 工作区状态

~~~text
M README.md
 M package-lock.json
 M package.json
 M src/App.css
 M src/App.tsx
 M src/Model3DStudio.css
 M src/Model3DStudio.tsx
 M src/model3dSceneStore.ts
 M vite.config.ts
 M 提示词.md
?? api-mode-comparison.png
?? api-mode-implementation.png
?? qa-clipboard-paste-reference.png
?? qa-generation-9x16-corners-detail.png
?? qa-generation-9x16-corners.png
?? qa-implementation-outpaint.png
?? qa-node-model-menu-expanded-detail.png
?? qa-node-model-menu-expanded-full.png
?? qa-node-model-menu-expanded-matching.png
?? qa-node-model-menu-expanded-zoomed-detail.png
?? qa-node-model-menu-expanded-zoomed.png
?? qa-node-model-select-dark-centered.png
?? qa-node-model-select-detail.png
?? qa-node-model-settings-image.png
?? qa-node-model-settings.png
?? scripts/
?? src/SketchStudio.css
?? src/SketchStudio.tsx
?? src/canvasMediaClipboard.ts
?? src/sketchDocument.ts
?? src/workflowPrompts.ts
?? tests/
?? 一键启动服务器.bat
?? 网站一键重启.bat
~~~

迁移包另外补充 AGENTS.md、Codex接手说明.md、交接资料及新版迁移到新设备.md，因此解压后的 git status 会多出交接文件变化。这些交接文档仅写入迁移副本，原项目未被修改。
