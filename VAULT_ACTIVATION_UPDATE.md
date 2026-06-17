# Vault-only USB and owner activation alerts

## What changed

- The Windows launcher reports `APPLICATION_OPENED` as soon as it starts.
- The Windows Monitor and Android connection report create `PENDRIVE_ACTIVATED` only on a new connection transition, not on every heartbeat.
- The owner dashboard displays an activation toast and optional browser/system notification.
- Repeated monitor heartbeats do not create repeated owner notifications.
- The public USB package uses the friendly launcher name `Open Secure USB.exe`.
- A preparation tool verifies the final three-file pendrive root.
- Large vault hashing was removed from the monitor because repeatedly hashing a nearly full USB container would be extremely slow. Missing or invalid vault checks remain.

## Final pendrive root

```text
Open Secure USB.exe
usb_guardian.id
secure_data.hc
```

The preparation tool hides `usb_guardian.id` and `secure_data.hc` by default, so a normal File Explorer view mainly presents the launcher. Hidden attributes do not provide encryption and can be reversed. The actual private-file protection comes from the VeraCrypt container.

## Prepare the pendrive

After the GitHub client build completes, download the Windows USB package and the identity file. Create `secure_data.hc` with VeraCrypt, extract the package, and double-click:

```text
PREPARE_VAULT_ONLY_USB.cmd
```

The tool asks for the USB drive letter and locates the newest downloaded `usb_guardian.id`. It never deletes unknown personal files. It reports any extra public files so you can move them into the vault and remove the verified public copies manually.

## Enable owner notifications

1. Deploy the updated website and function.
2. Open the owner portal and sign in.
3. Open **Preferences & Account**.
4. Keep **Pendrive activation alerts** enabled.
5. Select **Enable device notifications** and allow browser permission.
6. Keep automatic updates enabled.

The portal refreshes every five seconds. Browser/system notifications are immediate while the portal or installed PWA is running. When it is closed, activation records remain stored and the owner is alerted on the next portal opening. True push while every browser process is closed would require a separate Web Push subscription and push-delivery configuration.

## Test without USB Monitor

1. Keep the owner portal open.
2. Insert the prepared USB into a Windows computer without USBMonitor installed.
3. Manually open `Open Secure USB.exe`.
4. Within approximately five seconds, the owner portal should show an application-opened activation alert.
5. The access log should show `APPLICATION OPENED`.

## Test with USB Monitor

1. Install the newly built monitor.
2. Keep the owner portal open.
3. Insert the prepared USB.
4. The monitor reports `PENDRIVE ACTIVATED` and launches the Guardian application.
5. The application-open event is stored, but its duplicate owner notification is suppressed because the monitor already reported the activation.
