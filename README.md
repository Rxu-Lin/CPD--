# AI 画布工作台

一个 React + Vite 实现的无限画布 AI 图像生成工作流。界面采用深色节点画布，支持提示词节点、参考图节点、生成结果节点，以及项目导入导出。

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Rxu-Lin/CPD--)

## 启动

Windows 用户可以直接双击 `一键启动服务器.bat`：自动安装缺失的依赖，在后台启动网站，并用默认浏览器打开 `http://127.0.0.1:5174/`。重复点击会打开已运行的网站，关闭启动窗口不会停止服务器。电脑重启后，再次双击即可启动。

启动日志保存在 `logs/server.stdout.log` 和 `logs/server.stderr.log`。首次使用需要安装 Node.js 并联网下载依赖。

也可以从终端启动：

```bash
npm install
npm run dev
```

如果 PowerShell 拦截 `npm.ps1`，使用：

```bash
npm.cmd run dev
```

## 生产部署

项目包含同域图像 API 代理，需要部署为 Node Web Service，不能只发布到静态网站托管。

```bash
npm ci
npm run build
npm start
```

生产服务会监听环境变量 `PORT`。仓库根目录的 `render.yaml` 可用于 Render Blueprint 一键部署。

## 已实现

- React Flow 无限节点画布
- 中文暗色工作台界面
- 点击图像 / 视频生成卡片显示加宽的悬浮面板，集中编辑提示词、模型、比例、清晰度并生成；点击空白处收起，支持 `@` 引用已连接素材和旧项目提示词迁移
- 上传参考图节点
- 选中生成结果后按 Ctrl+C / Ctrl+V、使用复制结果按钮，或按住 Alt 用鼠标左键拖动，可创建保留提示词的独立图片 / 视频素材副本
- 本地模拟生成模式，方便无 API 时测试流程
- 项目本地保存、打开、导入、导出
- 生成历史和提示词库
- 3D 场景通过 IndexedDB 保存，可恢复模型、颜色、构图与光照；旧版场景自动迁移。请使用同一浏览器和网站地址打开，需独立备份时导出到画板并保存项目包。

## API 接入

点击右上角“设置”：

- `本地模拟`：不需要 API Key，会生成占位预览图。

图像请求通过本站同域代理转发。API Key 仅保存在当前用户浏览器的 `localStorage`，不会写入项目文件或服务器配置。
