@echo off
chcp 65001 >nul
title Cap nhat TikTok Shop Clip Viewer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\cap-nhat.ps1"
echo.
pause
