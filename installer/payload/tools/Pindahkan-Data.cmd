@echo off
setlocal
rem Minta hak administrator satu kali saja. "--elevated" mencegah pengulangan bila pemeriksaan hak keliru
rem (pemeriksaan lewat layanan Server keliru bila layanan itu mati, jadi dipakai fltmc).
if /i "%~1"=="--elevated" goto run
fltmc >nul 2>&1 && goto run
echo Meminta hak administrator ...
set "SELF=%~f0"
powershell -NoProfile -Command "Start-Process -FilePath '%SELF:'=''%' -ArgumentList '--elevated' -Verb RunAs"
exit /b
:run
echo Uptime Access Control T2 - pindahkan data dari Kuma lama
echo.
"%~dp0..\node\node.exe" "%~dp0cli.js" migrate %*
echo.
pause
