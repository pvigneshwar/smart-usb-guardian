@echo off
setlocal
cd /d "%~dp0"

set "PYTHON_EXE=C:\Users\zumakazuu\AppData\Local\Programs\Python\Python313\python.exe"

if not exist "%PYTHON_EXE%" (
    echo Python not found at:
    echo %PYTHON_EXE%
    echo Edit PYTHON_EXE in build_monitor.bat if your Python path is different.
    pause
    exit /b 1
)

"%PYTHON_EXE%" -m pip install --upgrade pyinstaller
"%PYTHON_EXE%" -m PyInstaller --clean --noconfirm --onefile --name USBMonitor usb_monitor.py

if not exist "dist\USBMonitor.exe" (
    echo Build failed.
    pause
    exit /b 1
)

copy /Y "dist\USBMonitor.exe" "USBMonitor.exe" >nul
echo.
echo Build completed:
echo %CD%\USBMonitor.exe
pause
