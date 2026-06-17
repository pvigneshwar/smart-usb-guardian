from __future__ import annotations

import ctypes
import getpass
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional


SERVER_URL = "https://smart-usbguardian.netlify.app/api"
SCAN_INTERVAL_SECONDS = 2
HEARTBEAT_INTERVAL_SECONDS = 10
LOCATION_REFRESH_SECONDS = 120

USB_APP_NAMES = ("Open Secure USB.exe", "USBGuardian.exe")
PRIMARY_USB_APP_NAME = USB_APP_NAMES[0]
ID_FILE_NAME = "usb_guardian.id"
VAULT_FILE_NAME = "secure_data.hc"

DRIVE_REMOVABLE = 2
DRIVE_FIXED = 3

_location_cache: Dict[str, Any] = {
    "updated_at": 0.0,
    "latitude": None,
    "longitude": None,
    "city": None,
    "country": None,
}


def log(message: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def get_drive_type(root: str) -> int:
    try:
        return int(ctypes.windll.kernel32.GetDriveTypeW(root))
    except Exception:
        return 0


def available_drives() -> list[Path]:
    drives: list[Path] = []
    system_drive = os.environ.get("SystemDrive", "C:").upper()

    for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        drive_name = f"{letter}:"
        root = f"{drive_name}\\"

        if drive_name.upper() == system_drive:
            continue

        if not os.path.exists(root):
            continue

        drive_type = get_drive_type(root)
        if drive_type in (DRIVE_REMOVABLE, DRIVE_FIXED):
            drives.append(Path(root))

    return drives


def read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        with path.open("r", encoding="utf-8") as file:
            value = json.load(file)
        return value if isinstance(value, dict) else None
    except Exception as error:
        log(f"Cannot read {path}: {error}")
        return None


def find_usb_app(drive: Path) -> Optional[Path]:
    for name in USB_APP_NAMES:
        candidate = drive / name
        if candidate.is_file():
            return candidate
    return None


def vault_size(path: Path) -> Optional[int]:
    try:
        return path.stat().st_size
    except Exception:
        return None


def build_device_info(drive: Path) -> Optional[Dict[str, Any]]:
    id_path = drive / ID_FILE_NAME

    # A valid identity file is the primary detection condition.
    if not id_path.exists():
        return None

    identity = read_json(id_path)
    if not identity:
        return None

    device_uid = str(identity.get("device_uid", "")).strip()
    if not device_uid:
        log(f"Ignoring {drive}: device_uid is missing from {ID_FILE_NAME}")
        return None

    exe_path = find_usb_app(drive)
    vault_path = drive / VAULT_FILE_NAME

    missing_files: list[str] = []
    if exe_path is None:
        missing_files.append(PRIMARY_USB_APP_NAME)
    if not vault_path.exists():
        missing_files.append(VAULT_FILE_NAME)

    tamper_status = "OK"
    if PRIMARY_USB_APP_NAME in missing_files:
        tamper_status = "TAMPER_APP_MISSING"
    elif VAULT_FILE_NAME in missing_files:
        tamper_status = "TAMPER_VAULT_MISSING"
    elif vault_path.exists() and (vault_size(vault_path) or 0) < 1024 * 1024:
        tamper_status = "TAMPER_VAULT_INVALID_SIZE"

    return {
        "drive": drive,
        "exe_path": exe_path or (drive / PRIMARY_USB_APP_NAME),
        "app_name": exe_path.name if exe_path else PRIMARY_USB_APP_NAME,
        "id_path": id_path,
        "vault_path": vault_path,
        "device_uid": device_uid,
        "device_name": str(identity.get("device_name") or "Unknown USB").strip(),
        "owner": str(identity.get("owner") or "Unknown").strip(),
        "login_username": str(identity.get("login_username") or "-").strip(),
        "missing_files": missing_files,
        "tamper_status": tamper_status,
        "vault_size": vault_size(vault_path) if vault_path.exists() else None,
    }


def scan_guardian_usb_devices() -> Dict[str, Dict[str, Any]]:
    devices: Dict[str, Dict[str, Any]] = {}

    for drive in available_drives():
        info = build_device_info(drive)
        if info:
            devices[info["device_uid"]] = info

    return devices


def _powershell_location() -> Dict[str, Any]:
    """
    Try Windows Location Service.

    This returns latitude and longitude only when Windows Location is enabled
    and desktop apps are allowed to use it. Failure is non-fatal.
    """
    script = r'''
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Devices.Geolocation.Geolocator,Windows.Devices.Geolocation,ContentType=WindowsRuntime]
$geo = New-Object Windows.Devices.Geolocation.Geolocator
$geo.DesiredAccuracy = [Windows.Devices.Geolocation.PositionAccuracy]::High

$method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
        $_.Name -eq "AsTask" -and
        $_.IsGenericMethod -and
        $_.GetParameters().Count -eq 1
    } |
    Select-Object -First 1

$operation = $geo.GetGeopositionAsync()
$task = $method.MakeGenericMethod([Windows.Devices.Geolocation.Geoposition]).Invoke($null, @($operation))
if (-not $task.Wait(12000)) { throw "Location request timed out" }
$position = $task.Result.Coordinate.Point.Position
@{
    latitude = [double]$position.Latitude
    longitude = [double]$position.Longitude
} | ConvertTo-Json -Compress
'''

    powershell = os.path.join(
        os.environ.get("SystemRoot", r"C:\Windows"),
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    )

    completed = subprocess.run(
        [
            powershell,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ],
        capture_output=True,
        text=True,
        timeout=18,
        creationflags=(
            subprocess.CREATE_NO_WINDOW
            if hasattr(subprocess, "CREATE_NO_WINDOW")
            else 0
        ),
    )

    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "Windows location unavailable")

    payload = json.loads(completed.stdout.strip())
    return {
        "latitude": float(payload["latitude"]),
        "longitude": float(payload["longitude"]),
        "city": None,
        "country": None,
    }


def get_host_location() -> Dict[str, Any]:
    now = time.time()
    if now - float(_location_cache["updated_at"]) < LOCATION_REFRESH_SECONDS:
        return dict(_location_cache)

    try:
        result = _powershell_location()
        _location_cache.update(result)
        _location_cache["updated_at"] = now
        log(
            "Windows location captured: "
            f"{result['latitude']}, {result['longitude']}"
        )
    except Exception as error:
        _location_cache.update(
            {
                "updated_at": now,
                "latitude": None,
                "longitude": None,
                "city": None,
                "country": None,
            }
        )
        log(f"Precise Windows location unavailable: {error}")

    return dict(_location_cache)


def post_connection(info: Dict[str, Any], connection: str) -> bool:
    location = get_host_location()

    payload = {
        "device_uid": info["device_uid"],
        "device_name": info.get("device_name"),
        "owner": info.get("owner"),
        "login_username": info.get("login_username"),
        "windows_user": getpass.getuser(),
        "computer_name": socket.gethostname(),
        "host_user": getpass.getuser(),
        "host_device": socket.gethostname(),
        "host_platform": "Windows",
        "latitude": location.get("latitude"),
        "longitude": location.get("longitude"),
        "city": location.get("city"),
        "country": location.get("country"),
        "connection": connection,
        "connection_status": connection,
        "tamper_status": info.get("tamper_status") or "OK",
        "missing_files": info.get("missing_files") or [],
    }

    request = urllib.request.Request(
        f"{SERVER_URL}/device/connection",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=7) as response:
            response_body = response.read().decode("utf-8", errors="replace")
            log(
                f"Reported {connection} for {info['device_uid']} "
                f"- HTTP {response.status}"
            )

            try:
                result = json.loads(response_body)
                event = result.get("event") or result
                log(
                    "Stored location: "
                    f"{event.get('latitude')}, {event.get('longitude')}"
                )
            except Exception:
                pass

            return 200 <= response.status < 300

    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        log(
            f"Backend rejected {connection} for {info['device_uid']} "
            f"- HTTP {error.code}: {body}"
        )
        return False
    except Exception as error:
        log(f"Backend report failed: {type(error).__name__}: {error}")
        return False


def launch_usb_app(info: Dict[str, Any]) -> bool:
    exe_path: Path = info["exe_path"]
    drive: Path = info["drive"]

    # USB files may take a few seconds to become readable after insertion.
    for _ in range(15):
        if exe_path.is_file():
            break
        time.sleep(1)

    if not exe_path.is_file():
        log(f"Auto-launch failed: {exe_path} does not exist")
        return False

    try:
        creation_flags = 0
        if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
            creation_flags |= subprocess.CREATE_NEW_PROCESS_GROUP
        if hasattr(subprocess, "CREATE_NEW_CONSOLE"):
            creation_flags |= subprocess.CREATE_NEW_CONSOLE

        process = subprocess.Popen(
            [str(exe_path)],
            cwd=str(drive),
            shell=False,
            creationflags=creation_flags,
        )
        log(
            f"Auto-launched {info.get('app_name', PRIMARY_USB_APP_NAME)} for {info['device_uid']} "
            f"(PID {process.pid})"
        )
        return True

    except Exception as first_error:
        log(f"Direct launch failed: {first_error}")

        try:
            os.startfile(str(exe_path))  # type: ignore[attr-defined]
            log(f"Auto-launched {info.get('app_name', PRIMARY_USB_APP_NAME)} using Windows Shell")
            return True
        except Exception as second_error:
            log(
                "Auto-launch failed. Confirm the EXE is trusted/unblocked and "
                f"Windows SmartScreen did not block it: {second_error}"
            )
            return False


def run_monitor() -> None:
    log("Smart USB Guardian Windows Monitor started")
    log(f"Backend: {SERVER_URL}")
    log(
        f"Waiting for a USB containing {ID_FILE_NAME}, {PRIMARY_USB_APP_NAME}, "
        f"and {VAULT_FILE_NAME}"
    )

    tracked: Dict[str, Dict[str, Any]] = {}
    pending_disconnects: Dict[str, Dict[str, Any]] = {}

    while True:
        try:
            current = scan_guardian_usb_devices()
            current_uids = set(current)
            tracked_uids = set(tracked)
            now = time.time()

            for uid in current_uids - tracked_uids:
                info = current[uid]
                log(f"USB detected: {uid} at {info['drive']}")

                if info["missing_files"]:
                    log("Missing files: " + ", ".join(info["missing_files"]))

                post_connection(info, "CONNECTED")
                launched = launch_usb_app(info)

                tracked[uid] = {
                    **info,
                    "last_heartbeat": now,
                    "launched": launched,
                }
                pending_disconnects.pop(uid, None)

            for uid in current_uids & tracked_uids:
                info = current[uid]
                previous = tracked[uid]
                heartbeat_due = (
                    now - float(previous.get("last_heartbeat", 0))
                    >= HEARTBEAT_INTERVAL_SECONDS
                )
                tamper_changed = info.get("tamper_status") != previous.get("tamper_status")

                # Retry launch while the same insertion is present if the first
                # attempt failed because the USB was not fully ready.
                launched = bool(previous.get("launched"))
                if not launched and info["exe_path"].is_file():
                    launched = launch_usb_app(info)

                if heartbeat_due or tamper_changed:
                    post_connection(info, "CONNECTED")
                    tracked[uid] = {
                        **info,
                        "last_heartbeat": now,
                        "launched": launched,
                    }
                else:
                    previous.update(info)
                    previous["launched"] = launched

            for uid in tracked_uids - current_uids:
                info = tracked.pop(uid)
                log(f"USB removed/ejected: {uid}")
                if not post_connection(info, "DISCONNECTED"):
                    pending_disconnects[uid] = info

            for uid in list(pending_disconnects):
                if post_connection(pending_disconnects[uid], "DISCONNECTED"):
                    pending_disconnects.pop(uid, None)

            time.sleep(SCAN_INTERVAL_SECONDS)

        except KeyboardInterrupt:
            log("Monitor stopped by user")
            for info in tracked.values():
                post_connection(info, "DISCONNECTED")
            break
        except Exception as error:
            log(f"Monitor loop error: {type(error).__name__}: {error}")
            time.sleep(SCAN_INTERVAL_SECONDS)


if __name__ == "__main__":
    if os.name != "nt":
        print("USBMonitor is intended for Windows only.")
        sys.exit(1)

    run_monitor()
