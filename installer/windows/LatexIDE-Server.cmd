@echo off
rem Eigener Server auf diesem Rechner (Installer-Option "Eigener Server").
rem Einstellungen (Admin, Datenordner, Port) stehen in .env im App-Ordner.
setlocal

set "APPDIR=%~dp0"
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"

set "PATH=%APPDIR%\node;%LOCALAPPDATA%\LatexIDE\texlive\2025\bin\windows;%PATH%"
if "%PORT%"=="" set "PORT=3077"

start "LatexIDE Server" /min "%APPDIR%\node\node.exe" "%APPDIR%\server\index.js"

timeout /t 3 /nobreak >nul
start "" "http://localhost:%PORT%"

endlocal
