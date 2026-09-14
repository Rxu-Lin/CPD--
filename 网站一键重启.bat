@echo off
setlocal
chcp 65001 >nul
title CPD AI Website Restart

cd /d "%~dp0"

echo ========================================
echo Restarting the CPD AI website...
echo ========================================

for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":5174" ^| findstr "LISTENING"') do (
  echo Stopping the old service, PID: %%P
  taskkill /PID %%P /F >nul 2>&1
)

timeout /t 1 /nobreak >nul

if not exist "package.json" (
  echo.
  echo Startup failed: package.json was not found.
  echo Keep this script in the website project folder.
  echo.
  pause
  exit /b 1
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo.
  echo Startup failed: npm was not found. Install Node.js first.
  echo.
  pause
  exit /b 1
)

echo Starting the new service...
start "CPD AI Website Server" cmd /k "cd /d ""%~dp0"" && npm.cmd run dev -- --host 127.0.0.1 --port 5174"

timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:5174/"

echo.
echo Website started: http://127.0.0.1:5174/
echo Keep the new "CPD AI Website Server" window open.
timeout /t 2 /nobreak >nul

endlocal
exit /b 0
