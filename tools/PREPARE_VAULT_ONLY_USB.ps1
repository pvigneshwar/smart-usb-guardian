[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$UsbDrive,

    [Parameter(Mandatory = $false)]
    [string]$GuardianExe,

    [Parameter(Mandatory = $false)]
    [string]$IdentityFile,

    [Parameter(Mandatory = $false)]
    [string]$VaultFile,

    [Parameter(Mandatory = $false)]
    [bool]$HideSupportFiles = $true
)

$ErrorActionPreference = "Stop"

function Resolve-UsbRoot {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        $Value = Read-Host "Enter the pendrive drive letter, for example E:"
    }

    $Value = $Value.Trim().TrimEnd("\")
    if ($Value -notmatch '^[A-Za-z]:$') {
        throw "Use a drive letter in the form E:"
    }

    $root = "$Value\"
    if (-not (Test-Path -LiteralPath $root)) {
        throw "The drive $root is not available."
    }

    $systemRoot = [System.IO.Path]::GetPathRoot($env:SystemRoot).TrimEnd("\")
    if ($Value.ToUpperInvariant() -eq $systemRoot.ToUpperInvariant()) {
        throw "Refusing to use the Windows system drive."
    }

    return $root
}

function Find-NewestIdentity {
    $candidates = Get-ChildItem -LiteralPath "$env:USERPROFILE\Downloads" -Filter "usb_guardian*.id" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
    return $candidates | Select-Object -First 1
}

function Find-GuardianExecutable {
    $candidates = @(
        (Join-Path $PSScriptRoot "Open Secure USB.exe"),
        (Join-Path (Split-Path $PSScriptRoot -Parent) "site\downloads\Open Secure USB.exe"),
        (Join-Path (Split-Path $PSScriptRoot -Parent) "site\downloads\USBGuardian.exe"),
        (Join-Path "$env:USERPROFILE\Downloads" "Open Secure USB.exe"),
        (Join-Path "$env:USERPROFILE\Downloads" "USBGuardian.exe")
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

$usbRoot = Resolve-UsbRoot -Value $UsbDrive
$requiredGuardianName = "Open Secure USB.exe"
$requiredIdentityName = "usb_guardian.id"
$requiredVaultName = "secure_data.hc"

if ([string]::IsNullOrWhiteSpace($GuardianExe)) {
    $GuardianExe = Find-GuardianExecutable
}
if ([string]::IsNullOrWhiteSpace($GuardianExe) -or -not (Test-Path -LiteralPath $GuardianExe -PathType Leaf)) {
    throw "Open Secure USB.exe was not found. Download or build the updated Windows client first."
}

if ([string]::IsNullOrWhiteSpace($IdentityFile)) {
    $existingIdentity = Join-Path $usbRoot $requiredIdentityName
    if (Test-Path -LiteralPath $existingIdentity -PathType Leaf) {
        $IdentityFile = $existingIdentity
    } else {
        $newestIdentity = Find-NewestIdentity
        if ($null -ne $newestIdentity) {
            $IdentityFile = $newestIdentity.FullName
        }
    }
}
if ([string]::IsNullOrWhiteSpace($IdentityFile) -or -not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
    throw "usb_guardian.id was not found. Register the USB and download its identity file first."
}

$destinationVault = Join-Path $usbRoot $requiredVaultName
if ([string]::IsNullOrWhiteSpace($VaultFile)) {
    if (Test-Path -LiteralPath $destinationVault -PathType Leaf) {
        $VaultFile = $destinationVault
    } else {
        $VaultFile = Read-Host "Enter the full path to secure_data.hc"
    }
}
if ([string]::IsNullOrWhiteSpace($VaultFile) -or -not (Test-Path -LiteralPath $VaultFile -PathType Leaf)) {
    $drive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($usbRoot.Substring(0,2))'" -ErrorAction SilentlyContinue
    if ($drive) {
        $reserveBytes = 512MB
        $recommendedBytes = [Math]::Max(0, [int64]$drive.FreeSpace - $reserveBytes)
        $recommendedMiB = [Math]::Floor($recommendedBytes / 1MB)
        Write-Host ""
        Write-Host "Create a VeraCrypt container named secure_data.hc before continuing." -ForegroundColor Yellow
        Write-Host "Recommended maximum size with about 512 MB left for the app and filesystem: $recommendedMiB MiB"
    }
    throw "secure_data.hc was not found."
}

Write-Host "Preparing vault-only USB at $usbRoot" -ForegroundColor Cyan

$destinationGuardian = Join-Path $usbRoot $requiredGuardianName
$destinationIdentity = Join-Path $usbRoot $requiredIdentityName

Copy-Item -LiteralPath $GuardianExe -Destination $destinationGuardian -Force

$resolvedIdentitySource = (Resolve-Path -LiteralPath $IdentityFile).Path
$resolvedIdentityDestination = [System.IO.Path]::GetFullPath($destinationIdentity)
if ($resolvedIdentitySource -ne $resolvedIdentityDestination) {
    Copy-Item -LiteralPath $resolvedIdentitySource -Destination $destinationIdentity -Force
}

$resolvedVaultSource = (Resolve-Path -LiteralPath $VaultFile).Path
$resolvedVaultDestination = [System.IO.Path]::GetFullPath($destinationVault)
if ($resolvedVaultSource -ne $resolvedVaultDestination) {
    Copy-Item -LiteralPath $resolvedVaultSource -Destination $destinationVault -Force
}

# Remove only known obsolete launch files. No personal data is deleted.
@("USBGuardian.exe", "launcher.bat", "autorun.inf") | ForEach-Object {
    $oldPath = Join-Path $usbRoot $_
    if (Test-Path -LiteralPath $oldPath -PathType Leaf) {
        Remove-Item -LiteralPath $oldPath -Force
    }
}

if ($HideSupportFiles) {
    & attrib.exe +h +s $destinationIdentity
    & attrib.exe +h +s $destinationVault
} else {
    & attrib.exe -h -s $destinationIdentity
    & attrib.exe -h -s $destinationVault
}

$required = @($destinationGuardian, $destinationIdentity, $destinationVault)
$missing = $required | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }
if ($missing.Count -gt 0) {
    throw "Preparation failed because required files are missing: $($missing -join ', ')"
}

$allowedNames = @($requiredGuardianName, $requiredIdentityName, $requiredVaultName, "System Volume Information")
$extraItems = Get-ChildItem -LiteralPath $usbRoot -Force -ErrorAction SilentlyContinue |
    Where-Object { $allowedNames -notcontains $_.Name }

Write-Host ""
Write-Host "Vault-only USB preparation completed." -ForegroundColor Green
Write-Host "Required root files:"
Write-Host "  $requiredGuardianName"
Write-Host "  $requiredIdentityName"
Write-Host "  $requiredVaultName"

if ($HideSupportFiles) {
    Write-Host "The identity and encrypted vault are hidden from the normal File Explorer view."
}

if ($extraItems.Count -gt 0) {
    Write-Host ""
    Write-Host "Other items are still present. They were not deleted for safety:" -ForegroundColor Yellow
    $extraItems | ForEach-Object { Write-Host "  $($_.Name)" }
    Write-Host "Move any private files into secure_data.hc, verify them, and remove the public copies manually."
}

Write-Host ""
Write-Host "Activation behaviour:"
Write-Host "  - With USBMonitor installed: insertion is reported and the app opens automatically."
Write-Host "  - Without USBMonitor: opening Open Secure USB.exe manually reports APPLICATION OPENED."
Write-Host "  - The owner portal shows the activation alert on its next refresh."
