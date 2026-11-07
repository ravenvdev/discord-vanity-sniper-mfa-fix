@echo off
chcp 65001 > nul
cd /d "%~dp0"
title Vanity Sniper — 7/24 Watchdog
if not exist logs mkdir logs

:loop
echo.
echo ============================================================
echo [%date% %time%] Sniper baslatiliyor...
echo ============================================================
echo.
node sniper.js auto 2>&1
set EXIT=%ERRORLEVEL%
echo.
echo [%date% %time%] Sniper cikti (exit %EXIT%). 5 sn sonra yeniden baslatiliyor...
echo [%date% %time%] exit=%EXIT% >> logs\restarts.log
timeout /t 5 /nobreak > nul
goto loop
