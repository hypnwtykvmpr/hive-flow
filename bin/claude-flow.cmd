@echo off
setlocal enabledelayedexpansion

:: Claude-Flow Windows Dispatcher
set VERSION=2.0.0-alpha.73

:: Get the directory where this script is located
set SCRIPT_DIR=%~dp0
set ROOT_DIR=%SCRIPT_DIR%..

:: Show help if no arguments provided
if "%~1"=="" (
    set "ARGS=--help"
) else (
    set "ARGS=%*"
)

:: Check for version flag
if "%~1"=="--version" (
    echo v%VERSION%
    exit /b 0
)
if "%~1"=="-v" (
    echo v%VERSION%
    exit /b 0
)

:: Try to use the JavaScript CLI directly
if exist "%ROOT_DIR%\src\cli\simple-cli.js" (
    node "%ROOT_DIR%\src\cli\simple-cli.js" %ARGS%
    exit /b %ERRORLEVEL%
)

:: Fallback: try with tsx if available
where tsx >nul 2>&1
if %ERRORLEVEL% == 0 (
    if exist "%ROOT_DIR%\src\cli\simple-cli.ts" (
        tsx "%ROOT_DIR%\src\cli\simple-cli.ts" %ARGS%
        exit /b %ERRORLEVEL%
    )
)

:: No runtime available
echo Claude-Flow v%VERSION% - Advanced AI Agent Orchestration System
echo.
echo Error: No compatible runtime found.
echo.
echo To install and run:
echo   1. Ensure Node.js is installed
echo   2. Run: npm install -g tsx
echo   3. Run: claude-flow ^<command^>
echo.
echo Documentation: https://github.com/ruvnet/claude-code-flow
exit /b 1