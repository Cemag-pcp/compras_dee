@echo off
setlocal

cd /d "%~dp0"

echo === Atualizando repositorio local ===
git pull
if errorlevel 1 (
    echo Falha ao atualizar o repositorio.
    pause
    exit /b 1
)

cd playwright-innovaro

echo.
echo === Instalando dependencias ===
call npm install
if errorlevel 1 (
    echo Falha ao instalar dependencias.
    pause
    exit /b 1
)

call npx playwright install chromium
if errorlevel 1 (
    echo Falha ao instalar o navegador do Playwright.
    pause
    exit /b 1
)

echo.
echo === Rodando automacao principal ===
call npm run start:v2

echo.
echo === Finalizado ===
pause
