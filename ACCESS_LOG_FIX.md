# Smart USB Guardian access-log display fix

This update fixes missing or misleading values in the access-log table.

## Fixed fields

- Login Username now appears for connection events.
- Connection displays the recorded event state instead of only the latest device state.
- Access Status displays `NO LOGIN ATTEMPT` for monitor-only connection events.
- Tamper displays `OK` when no tamper issue was reported.
- Location falls back to latitude/longitude when city and country are unavailable.
- New records can use Netlify request geography as a city/country fallback.
- The access-log table is widened so status and action columns remain available through horizontal scrolling.
- Service-worker cache is bumped to `smart-usb-guardian-3d-v2`.

## Apply

Run from the extracted patch folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\APPLY_LOG_DISPLAY_FIX.ps1
```

Then:

```powershell
cd D:\projects\smrtusb\SmartUSBGuardianNetlifyOnly
npm run check
npm run build
git add .
git commit -m "Fix missing access log fields"
git push origin main
```

After Netlify deploys, open the site and press `Ctrl + Shift + R`.
