@echo off
cd /d "%~dp0"
set "NEED="
if not exist node_modules set "NEED=1"
if not exist node_modules\.package-lock.json set "NEED=1"
rem Neue Abhaengigkeiten nach einem Update: package-lock.json juenger als node_modules\.package-lock.json
if not defined NEED for /f %%i in ('powershell -NoProfile -Command "if ((Get-Item package-lock.json).LastWriteTime -gt (Get-Item node_modules\.package-lock.json).LastWriteTime) {1}"') do set "NEED=1"
if defined NEED (
  echo Installiere Abhaengigkeiten...
  call npm ci
)
call npm start
