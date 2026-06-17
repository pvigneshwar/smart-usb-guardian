@echo off
setlocal
cd /d "%~dp0"

python -m pip install --upgrade pyinstaller requests

pushd clients\windows_usb_guardian
python -m PyInstaller --clean --noconfirm --onefile --name "Open Secure USB" client.py
if errorlevel 1 exit /b 1
popd

pushd clients\windows_usb_monitor
python -m PyInstaller --clean --noconfirm --onefile --noconsole --name USBMonitor usb_monitor.py
if errorlevel 1 exit /b 1
popd

pushd clients\android
call gradlew.bat --no-daemon clean assembleDebug
if errorlevel 1 exit /b 1
popd

copy /Y "clients\windows_usb_guardian\dist\Open Secure USB.exe" "site\downloads\Open Secure USB.exe"
copy /Y "clients\windows_usb_guardian\dist\Open Secure USB.exe" "site\downloads\USBGuardian.exe"
copy /Y "clients\windows_usb_monitor\dist\USBMonitor.exe" "site\downloads\USBMonitor.exe"
copy /Y "clients\android\app\build\outputs\apk\debug\app-debug.apk" "site\downloads\USBGuardianMobile.apk"

echo.
echo Core clients were built and copied to site\downloads.
echo Use tools\PREPARE_VAULT_ONLY_USB.ps1 to prepare the pendrive root.
pause
