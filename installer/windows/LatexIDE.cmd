@echo off
setlocal

set "APPDIR=%~dp0"
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"

set "PATH=%APPDIR%\node;%LOCALAPPDATA%\LatexIDE\texlive\2025\bin\windows;%PATH%"

if "%PORT%"=="" set "PORT=3178"
if "%LATEX_IDE_DATA%"=="" set "LATEX_IDE_DATA=%LOCALAPPDATA%\LatexIDE\data"

start "LatexIDE Server" /min "%APPDIR%\node\node.exe" "%APPDIR%\server\desktop.js"

timeout /t 2 /nobreak >nul
start "" "http://localhost:%PORT%"

endlocal
