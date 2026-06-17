@echo off
setlocal
set "PYTHON_EXE=python"

%PYTHON_EXE% -m pip install --upgrade pip
%PYTHON_EXE% -m pip install requests pyinstaller
%PYTHON_EXE% -m PyInstaller --clean --noconfirm --onefile --name "Open Secure USB" client.py

if exist "dist\Open Secure USB.exe" (
    copy /Y "dist\Open Secure USB.exe" "Open Secure USB.exe" >nul
    echo.
    echo Build complete: Open Secure USB.exe
) else (
    echo Build failed.
    exit /b 1
)

pause
