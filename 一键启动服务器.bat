@echo off
setlocal
chcp 65001 >nul
title AI Website Launcher
where node.exe >nul 2>&1
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 后重试。
  pause
  exit /b 1
)
node.exe "%~dp0scripts\start-server.mjs" %*
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
exit /b 0
