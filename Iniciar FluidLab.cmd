@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao foi encontrado. Instale Node.js 18 ou superior para abrir o FluidLab.
  pause
  exit /b 1
)
node serve.mjs 8777 --open
pause
