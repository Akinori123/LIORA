@echo off
chcp 65001 >nul
title LIORA Desktop

echo Iniciando janela da LIORA...

if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app="http://localhost:3000" --window-size=1280,820
    goto :done
)

if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app="http://localhost:3000" --window-size=1280,820
    goto :done
)

start http://localhost:3000

:done
exit
