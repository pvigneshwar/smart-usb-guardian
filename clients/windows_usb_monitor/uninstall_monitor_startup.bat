@echo off
setlocal
set "INSTALL_DIR=%LOCALAPPDATA%\SmartUSBGuardian"
set "SHORTCUT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Smart USB Guardian Monitor.lnk"

taskkill /IM USBMonitor.exe /F >nul 2>&1
del /Q "%SHORTCUT%" >nul 2>&1
rmdir /S /Q "%INSTALL_DIR%" >nul 2>&1

echo Smart USB Guardian Monitor was removed from startup.
pause
