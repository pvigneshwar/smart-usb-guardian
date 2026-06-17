# Smart USB Guardian 3D UI Update

## What changed

- Converted the login screen into a full 3D project experience.
- Added an interactive 3D Guardian core to the dashboard.
- Added mission, protection-layer and platform cards.
- Added a complete Project Overview page.
- Redesigned dashboard cards, settings, downloads and account panels.
- Replaced visible API/backend/hosting language with project and protection language.
- Preserved account login, USB registration, devices, logs, alerts, downloads and account deletion.

## Main files

- `site/index.html`
- `site/three-d.css`
- `site/experience.js`
- `site/app.js`
- `site/service-worker.js`
- `site/manifest.webmanifest`

## Deploy

Copy the update into the project, then run:

```powershell
cd D:\projects\smrtusb\SmartUSBGuardianNetlifyOnly
git add .
git commit -m "Add 3D project interface"
git push origin main
```

Netlify will deploy the GitHub commit automatically. After deployment, use `Ctrl + Shift + R` once to load the new service-worker cache.

## Visibility note

The visible website no longer displays hosting, storage or API configuration. Browser developer tools can still reveal network routes because every web application must send requests to its services. Real protection comes from authenticated routes and owner-level authorization, not from hiding an endpoint label.
