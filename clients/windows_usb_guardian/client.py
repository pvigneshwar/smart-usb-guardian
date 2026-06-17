from __future__ import annotations

import getpass
import json
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Optional

import requests


SERVER_URL = "https://smart-usbguardian.netlify.app/api"
ID_FILE_NAME = "usb_guardian.id"
VAULT_FILE_NAME = "secure_data.hc"
VERACRYPT_PORTABLE_FOLDER = "VeraCryptPortable"
VERACRYPT_EXE_NAME = "VeraCrypt.exe"
MINIMUM_VAULT_BYTES = 1024 * 1024


def app_folder() -> Path:
    """Return the folder containing the script or packaged executable."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def pause() -> None:
    try:
        input("\nPress Enter to exit...")
    except EOFError:
        pass


def print_header() -> None:
    print("=" * 56)
    print("Open Secure USB - Smart USB Guardian")
    print("=" * 56)


def print_security_notice() -> None:
    print()
    print("SECURITY NOTICE")
    print("This registered security application records the application-open")
    print("time, host account/device details, available location information,")
    print("and tamper state in the owner's security dashboard.")
    print()


def read_usb_identity() -> Optional[Dict[str, str]]:
    id_path = app_folder() / ID_FILE_NAME

    if not id_path.exists():
        print("ERROR: usb_guardian.id is missing.")
        print("Register this USB using the owner dashboard and copy the new")
        print("usb_guardian.id file into the pendrive root.")
        return None

    try:
        with id_path.open("r", encoding="utf-8") as file:
            data = json.load(file)

        required_fields = [
            "device_uid",
            "device_name",
            "owner",
            "login_username",
        ]
        missing_fields = [
            field for field in required_fields if not str(data.get(field, "")).strip()
        ]

        if missing_fields:
            print("ERROR: usb_guardian.id is missing required fields.")
            print("Missing:", ", ".join(missing_fields))
            return None

        return {
            "device_uid": str(data["device_uid"]).strip(),
            "device_name": str(data["device_name"]).strip(),
            "owner": str(data["owner"]).strip(),
            "login_username": str(data["login_username"]).strip(),
        }

    except json.JSONDecodeError:
        print("ERROR: Invalid JSON inside usb_guardian.id")
        return None
    except Exception as error:
        print(f"ERROR: Cannot read usb_guardian.id: {error}")
        return None


def post_json(endpoint: str, payload: Dict[str, Any], timeout: int = 15) -> Dict[str, Any]:
    try:
        response = requests.post(
            f"{SERVER_URL}{endpoint}",
            json=payload,
            timeout=timeout,
        )
        try:
            data = response.json()
        except Exception:
            data = {
                "success": False,
                "message": "Invalid security service response",
                "raw": response.text,
            }
        data["_http_status"] = response.status_code
        return data

    except requests.exceptions.ConnectionError:
        return {
            "success": False,
            "message": "Security service is unreachable",
        }
    except requests.exceptions.Timeout:
        return {
            "success": False,
            "message": "Security service did not respond in time",
        }
    except Exception as error:
        return {
            "success": False,
            "message": "Request failed",
            "reason": str(error),
        }


def get_json(endpoint: str, timeout: int = 15) -> Dict[str, Any]:
    try:
        response = requests.get(f"{SERVER_URL}{endpoint}", timeout=timeout)
        try:
            data = response.json()
        except Exception:
            data = {
                "success": False,
                "message": "Invalid security service response",
                "raw": response.text,
            }
        data["_http_status"] = response.status_code
        return data
    except requests.exceptions.RequestException:
        return {
            "success": False,
            "message": "Security service is unreachable",
        }


def local_tamper_status() -> tuple[str, list[str]]:
    base = app_folder()
    missing_files: list[str] = []

    if not (base / ID_FILE_NAME).is_file():
        missing_files.append(ID_FILE_NAME)
    vault_path = base / VAULT_FILE_NAME
    if not vault_path.is_file():
        missing_files.append(VAULT_FILE_NAME)

    statuses: list[str] = []
    if ID_FILE_NAME in missing_files:
        statuses.append("TAMPER_IDENTITY_MISSING")
    if VAULT_FILE_NAME in missing_files:
        statuses.append("TAMPER_VAULT_MISSING")
    elif vault_path.stat().st_size < MINIMUM_VAULT_BYTES:
        statuses.append("TAMPER_VAULT_INVALID_SIZE")

    return (",".join(statuses) or "OK", missing_files)


def host_payload(device: Dict[str, str]) -> Dict[str, Any]:
    tamper_status, missing_files = local_tamper_status()
    host_user = getpass.getuser()
    host_device = socket.gethostname()
    return {
        "device_uid": device["device_uid"],
        "device_name": device["device_name"],
        "owner": device["owner"],
        "login_username": device["login_username"],
        "windows_user": host_user,
        "computer_name": host_device,
        "host_user": host_user,
        "host_device": host_device,
        "host_platform": "Windows",
        "tamper_status": tamper_status,
        "missing_files": missing_files,
    }


def report_application_opened(device: Dict[str, str]) -> None:
    """Report a visible application-opened event without blocking authentication."""
    result = post_json("/device/opened", host_payload(device), timeout=12)
    if result.get("success") is True:
        print("Security session recorded.")
    else:
        print("Security session could not be synchronized.")
        print("Authentication can still be attempted while the network is checked.")


def check_device_registration(device: Dict[str, str]) -> None:
    result = get_json(f"/device/check/{device['device_uid']}")
    if result.get("registered") is not True:
        print("WARNING: This USB is not registered or cannot be verified.")
        print("The secure vault will remain closed unless authentication succeeds.")
        print()


def find_veracrypt_exe() -> Optional[Path]:
    base = app_folder()
    possible_paths = [
        base / VERACRYPT_PORTABLE_FOLDER / VERACRYPT_EXE_NAME,
        Path(r"C:\Program Files\VeraCrypt\VeraCrypt.exe"),
        Path(r"C:\Program Files (x86)\VeraCrypt\VeraCrypt.exe"),
    ]
    for path in possible_paths:
        if path.exists():
            return path
    return None


def open_veracrypt_vault() -> None:
    base = app_folder()
    vault_path = base / VAULT_FILE_NAME
    veracrypt_exe = find_veracrypt_exe()

    print()
    print("-" * 48)
    print("Secure Vault")
    print("-" * 48)

    if not vault_path.exists():
        print("Secure vault file not found.")
        print(f"Expected file: {vault_path}")
        return

    if veracrypt_exe is None:
        print("VeraCrypt is not installed on this computer.")
        print("Install VeraCrypt to open the encrypted vault.")
        return

    try:
        print("Opening the encrypted vault...")
        print("Enter the vault password only in the VeraCrypt window.")
        subprocess.Popen([str(veracrypt_exe), str(vault_path)])
    except Exception as error:
        print(f"Failed to open the encrypted vault: {error}")


def print_usb_details(device: Dict[str, str]) -> None:
    print_header()
    print_security_notice()
    print(f"Device UID     : {device['device_uid']}")
    print(f"USB Name       : {device['device_name']}")
    print(f"Owner          : {device['owner']}")
    print(f"Login Username : {device['login_username']}")
    print()


def print_result(result: Dict[str, Any]) -> None:
    success = result.get("success") is True

    print()
    print("=" * 32)
    print("ACCESS GRANTED" if success else "ACCESS DENIED")
    print("=" * 32)
    print()

    if not success:
        print(f"Reason         : {result.get('reason') or result.get('message')}")

    print(f"Device UID     : {result.get('device_uid')}")
    print(f"USB Name       : {result.get('device_name')}")
    print(f"Owner          : {result.get('owner')}")
    print(f"Login Username : {result.get('login_username')}")
    print(f"Host User      : {result.get('windows_user')}")
    print(f"Host Device    : {result.get('computer_name')}")
    print(f"Location       : {result.get('location')}")
    print(f"Latitude       : {result.get('latitude')}")
    print(f"Longitude      : {result.get('longitude')}")
    print(f"Time           : {result.get('time')}")
    print(f"Connection     : {result.get('connection')}")
    print(f"Access Status  : {result.get('access_status')}")
    print(f"Tamper Status  : {result.get('tamper_status')}")


def login(device: Dict[str, str]) -> None:
    check_device_registration(device)
    print(f"Username      : {device['login_username']}")

    password = getpass.getpass("Password      : ")
    if not password:
        print()
        print("ACCESS DENIED")
        print("Reason: Password is required.")
        return

    payload = {
        **host_payload(device),
        "password": password,
    }

    print()
    print("Verifying secure access...")
    result = post_json("/device/login", payload)
    print_result(result)

    if result.get("success") is True:
        open_veracrypt_vault()
    else:
        print()
        print("The encrypted vault remains closed.")


def main() -> None:
    try:
        device = read_usb_identity()
        if device is None:
            pause()
            return

        print_usb_details(device)
        report_application_opened(device)
        print()
        login(device)

    except KeyboardInterrupt:
        print()
        print("Operation cancelled by user.")
    except Exception as error:
        print()
        print("Unexpected error occurred.")
        print(f"Reason: {type(error).__name__}: {error}")
    finally:
        pause()


if __name__ == "__main__":
    main()
