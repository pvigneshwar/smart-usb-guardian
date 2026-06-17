@echo off
setlocal
cd /d "%~dp0"

if not exist "USBMonitor.exe" (
    echo USBMonitor.exe was not found in this folder.
    echo Run build_monitor.bat first.
    pause
    exit /b 1
)

set "INSTALL_DIR=%LOCALAPPDATA%\SmartUSBGuardian"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT=%STARTUP_DIR%\Smart USB Guardian Monitor.lnk"

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
copy /Y "USBMonitor.exe" "%INSTALL_DIR%\USBMonitor.exe" >nul

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$shell = New-Object -ComObject WScript.Shell;" ^
  "$shortcut = $shell.CreateShortcut('%SHORTCUT%');" ^
  "$shortcut.TargetPath = '%INSTALL_DIR%\USBMonitor.exe';" ^
  "$shortcut.WorkingDirectory = '%INSTALL_DIR%';" ^
  "$shortcut.Description = 'Smart USB Guardian automatic USB monitor';" ^
  "$shortcut.Save()"

start "" "%INSTALL_DIR%\USBMonitor.exe"

echo.
echo USB Monitor installed and started.
echo It will start automatically when this Windows user signs in.
echo Installed at: %INSTALL_DIR%\USBMonitor.exe
pause
