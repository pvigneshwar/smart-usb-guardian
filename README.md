# Smart USB Guardian — Vault-only activation-alert edition

This project converts the original FastAPI + SQLite + WebSocket deployment into a single Netlify project:

- Static owner dashboard: Netlify CDN
- API: Netlify Functions
- Persistent application data: site-wide Netlify Blobs
- Dashboard updates: 5-second polling
- Owner activation alerts: in-dashboard toast and browser notification
- Vault-only pendrive layout: one visible launcher plus encrypted storage
- EXE/APK downloads: Netlify static files

The old Render backend is not required.

## Important architecture change

The Python FastAPI files are retained only in the original backup project. This converted project uses:

- `netlify/functions/api.mjs` for accounts, devices, USB login, connection events, logs, deletion and download redirects
- `netlify/lib/` for password security, response handling and Netlify Blobs access
- `site/` for the deployable website
- `clients/` for Windows and Android source code configured for `https://smart-usbguardian.netlify.app/api`

Netlify Functions do not maintain a persistent WebSocket server. The dashboard polls the API every five seconds.

## Project structure

```text
SmartUSBGuardianNetlifyOnly/
├── site/
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── config.js
│   ├── service-worker.js
│   ├── assets/
│   └── downloads/
├── netlify/
│   ├── functions/api.mjs
│   └── lib/
├── clients/
│   ├── windows_usb_guardian/
│   ├── windows_usb_monitor/
│   └── android/
├── .github/workflows/build-clients.yml
├── netlify.toml
├── package.json
└── BUILD_CLIENTS_LOCALLY.bat
```

## Deploy to Netlify

### 1. Create a new GitHub repository

Do not deploy this conversion by drag-and-drop because Netlify must install dependencies and deploy Functions.

```powershell
cd D:\projects\smrtusb\SmartUSBGuardianNetlifyOnly
git init
git add .
git commit -m "Convert Smart USB Guardian to Netlify only"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/smart-usb-guardian-netlify.git
git push -u origin main
```

### 2. Connect the repository to the existing Netlify site

In Netlify:

```text
Project configuration
→ Build & deploy
→ Continuous deployment
→ Link repository
```

Select the new repository.

Use:

```text
Build command: npm run build
Publish directory: site
Functions directory: netlify/functions
```

These values are already present in `netlify.toml`.

### 3. Deploy

Trigger a production deploy. After it finishes, open:

```text
https://smart-usbguardian.netlify.app/health
```

Expected response:

```json
{
  "message": "Smart USB Guardian Netlify API running",
  "version": "4.1.0-netlify",
  "storage": "Netlify Blobs",
  "realtime_mode": "polling-with-owner-alerts"
}
```

### 4. Create a new owner account

The Netlify Blobs stores are new. Existing SQLite accounts and USB records are not automatically copied.

Open the site, choose **Sign up**, and register the USB again to generate a new `usb_guardian.id`.

## Build the Windows and Android clients

The uploaded source is already configured for:

```text
https://smart-usbguardian.netlify.app/api
```

### Automatic GitHub build

Open the GitHub repository:

```text
Actions
→ Build Smart USB Guardian clients
→ Run workflow
```

The workflow builds and commits these files into `site/downloads/`:

- `Open Secure USB.exe`
- `USBGuardian.exe` (compatibility copy)
- `USBMonitor.exe`
- `USBGuardianMobile.apk`
- `Smart_USB_Guardian_One_Click_Setup.zip`
- `Smart_USB_Guardian_Windows_Client.zip`
- `build-manifest.json`

The generated commit triggers a new Netlify deploy.

Repository workflow permissions must permit write access:

```text
GitHub repository
→ Settings
→ Actions
→ General
→ Workflow permissions
→ Read and write permissions
```

### Local Windows build

Run:

```text
BUILD_CLIENTS_LOCALLY.bat
```

This builds the three core client files. The GitHub workflow also creates the ZIP packages.

## USB setup after migration

1. Create an owner account on the Netlify website.
2. Register the pendrive again.
3. Download the new `usb_guardian.id`.
4. Download the newly built Windows client package.
5. Place these in the pendrive root:

```text
Open Secure USB.exe
usb_guardian.id
secure_data.hc
```

6. Install the newly built USB Monitor on every Windows host.
7. Install the newly built APK on Android.

Old EXE/APK builds still point to Render and must not be reused.

Run `tools\PREPARE_VAULT_ONLY_USB.cmd` after downloading the new executable, identity file, and creating the VeraCrypt container. The script copies and verifies the three required files, removes only known obsolete launch files, and can hide the identity and vault from the normal File Explorer view.

## Storage note

This version uses Netlify Blobs instead of SQLite. The stores use strong consistency for account, device, event and connection operations. The design is suitable for this college project and moderate usage. It is not a replacement for a relational database for high-volume production workloads.

## Security notes

- Owner and USB passwords use PBKDF2-HMAC-SHA256 with random salts.
- Session tokens are random and only SHA-256 token hashes are stored.
- Owner records are scoped by the authenticated user ID.
- `usb_guardian.id` never contains a password.
- VeraCrypt remains responsible for file encryption.

## Optional: import the old SQLite records

For a small existing database, export it locally:

```powershell
python tools\export_sqlite.py `
  D:\projects\smrtusb\app1_owner\backend\usb_guardian.db `
  --output netlify-migration.json
```

In Netlify, add a temporary environment variable:

```text
MIGRATION_SECRET = create-a-long-random-secret
```

Redeploy, then upload the export:

```powershell
$headers = @{ "x-migration-secret" = "create-a-long-random-secret" }
Invoke-RestMethod `
  -Method Post `
  -Uri "https://smart-usbguardian.netlify.app/admin/import" `
  -Headers $headers `
  -ContentType "application/json" `
  -InFile ".\netlify-migration.json"
```

Remove `MIGRATION_SECRET` from Netlify and redeploy immediately after the import. Netlify Functions have a request-size limit, so this one-time endpoint is intended only for a small college-project database.

## 3D interface edition

The owner website now includes an immersive 3D security interface with:

- a 3D USB login experience,
- a rotating Guardian security core,
- perspective and mouse-tilt cards,
- a project overview page with problem, solution, components and workflow,
- project-focused dashboard content,
- user-facing preferences and downloads,
- no API, hosting provider, storage engine or deployment details shown in the visible interface.

Technical endpoints remain part of the application source and browser network traffic because the website must communicate with its services. Hiding labels in the interface is not a security control; authentication and authorization remain responsible for protecting data.

## Pendrive activation alerts

A registered USB now creates a dedicated activation event in two situations:

1. `USBMonitor.exe` detects that the pendrive was inserted.
2. Someone manually opens `Open Secure USB.exe` on a Windows computer without the monitor.

The owner portal checks for new activation events every five seconds. When **Pendrive activation alerts** is enabled, it displays an in-dashboard alert. After the owner grants browser notification permission, it also displays a Windows/browser notification while the dashboard or installed PWA is running. If the portal is closed, the activation remains stored and is shown when the owner opens the portal again.

This is not independent GPS tracking. The USB still requires a connected host, internet access, and either the monitor or manual application launch to report the activation.

## Vault-only public layout

The recommended pendrive root is:

```text
Open Secure USB.exe
usb_guardian.id
secure_data.hc
```

Keep every private document inside `secure_data.hc`. Do not allocate literally 100% of the filesystem to the container; leave approximately 512 MB for the launcher, identity file, filesystem metadata, and safe updates. Hiding `usb_guardian.id` and `secure_data.hc` improves the normal File Explorer presentation but is not a security control. VeraCrypt encryption is the protection layer.
