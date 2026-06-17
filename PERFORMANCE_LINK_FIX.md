# Performance and download-link fix

This edition keeps the 3D USB, shield, orbit, cube and glass-depth styling while reducing lag on Windows and Android.

## Performance changes

- Added automatic adaptive rendering for touch devices, low-memory devices, lower-core CPUs and small screens.
- Kept 3D objects visible in adaptive mode, but changed continuous movement to static 3D poses.
- Removed expensive full-page pointer repainting, permanent `will-change` layers, backdrop blur and blend-mode effects.
- Pauses 3D animation when a scene is outside the viewport or the app is in the background.
- Avoids rebuilding dashboard tables when polling returns unchanged data.
- Uses an 8-second mobile polling interval and a smaller mobile activity payload.
- Replaced the large embedded-image SVG logo with a compact vector logo and added 192 px and 512 px PWA icons.

## Broken-link and download changes

- Large EXE, APK and ZIP downloads now stream directly through the browser download manager instead of loading the whole file into JavaScript memory.
- The service worker no longer intercepts API calls or large downloads.
- Added a stable URL without spaces: `/downloads/Open_Secure_USB.exe`.
- Added Netlify MIME types and attachment headers for APK, EXE and ZIP files.
- The build validator now checks every local HTML asset and verifies that required client binaries are present and not empty.
- Updated PWA cache handling so one missing asset cannot prevent service-worker installation.

## Deploy

```powershell
cd D:\projects\smrtusb\smart-usb-guardian-netlify-main
git add .
git commit -m "Optimize 3D performance and fix download links"
git push origin main
```

After Netlify finishes deploying, open the site once and press `Ctrl + Shift + R` on Windows. On Android, close and reopen the installed PWA. If an old installed PWA remains stale, clear the site's cache once and reinstall it.
