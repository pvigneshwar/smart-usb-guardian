package com.smartusb.guardianmobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.hardware.usb.UsbManager
import org.json.JSONObject

class UsbDetachReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != UsbManager.ACTION_USB_DEVICE_DETACHED) return

        val prefs = context.getSharedPreferences("usb_guardian_mobile", Context.MODE_PRIVATE)
        val identityJson = prefs.getString("identity_json", null) ?: return
        val identity = runCatching { UsbIdentity.fromJson(JSONObject(identityJson)) }.getOrNull() ?: return

        val location = HostLocation(
            latitude = prefs.getString("last_latitude", null)?.toDoubleOrNull(),
            longitude = prefs.getString("last_longitude", null)?.toDoubleOrNull(),
            city = prefs.getString("last_city", "Unknown") ?: "Unknown",
            country = prefs.getString("last_country", "Unknown") ?: "Unknown",
        )

        val pending = goAsync()
        ApiClient.connection(
            identity = identity,
            connection = "DISCONNECTED",
            location = location,
            tamperStatus = "UNKNOWN_AFTER_DETACH",
        ) {
            pending.finish()
        }
    }
}
