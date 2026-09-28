@echo off
rem Al Thob Al Arabi - run the warehouse app (API + web app), then open it in the browser.
rem Double-click this file. Keep this window open while you use the app; close it to stop.

chcp 65001 >nul
cd /d "%~dp0"
title Al Thob Al Arabi

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm is not installed. Install it once with:  npm i -g pnpm@9
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First run: installing dependencies, this takes a few minutes...
  call pnpm install
  if errorlevel 1 ( pause & exit /b 1 )
)

if not exist "backend\.env" (
  echo backend\.env is missing. Copy .env.example to backend\.env and fill in the Neon URLs.
  pause
  exit /b 1
)

echo.
echo   [1] Practice  - training database, safe to try anything  (recommended)
echo   [2] Real      - REAL stock: every movement is permanent
echo.
choice /c 12 /n /m "Choose 1 or 2: "
if errorlevel 2 goto real

set "SCRIPT=dev:practice"
echo.
echo Starting PRACTICE mode...
goto run

:real
echo.
echo *** REAL MODE: everything you record changes the real stock. ***
choice /c yn /n /m "Continue? (y/n): "
if errorlevel 2 exit /b 0
set "SCRIPT=dev"
echo Starting REAL mode...

:run
rem Open the browser once the servers have had time to start.
start "" /min cmd /c "timeout /t 12 /nobreak >nul & start "" http://localhost:5180"
call pnpm %SCRIPT%
pause
