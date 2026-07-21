# AI 画布工作台

一个 React + Vite 实现的无限画布 AI 图像生成工作流。界面采用深色节点画布，支持提示词节点、参考图节点、生成结果节点，以及项目导入导出。

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Rxu-Lin/AI-)

## 启动

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
- 提示词生成节点和 AI 图像结果节点
- 上传参考图节点
- 本地模拟生成模式，方便无 API 时测试流程
- OpenAI 兼容图像接口配置
- 自定义 JSON API 请求体模板和响应路径
- 项目本地保存、打开、导入、导出
- 生成历史和提示词库

## API 接入

点击右上角“设置”：

- `本地模拟`：不需要 API Key，会生成占位预览图。
- `OpenAI 兼容`：默认请求 `POST /v1/images/generations`，读取 `data.0.url` 或 `data.0.b64_json`。
- `自定义 JSON API`：可配置请求体模板和图片响应路径。

图像请求通过本站同域代理转发。API Key 仅保存在当前用户浏览器的 `localStorage`，不会写入项目文件或服务器配置。
