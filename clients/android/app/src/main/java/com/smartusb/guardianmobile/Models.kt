package com.smartusb.guardianmobile

import org.json.JSONObject

data class UsbIdentity(
    val deviceUid: String,
    val deviceName: String,
    val owner: String,
    val loginUsername: String,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("device_uid", deviceUid)
        put("device_name", deviceName)
        put("owner", owner)
        put("login_username", loginUsername)
    }

    companion object {
        fun fromJson(json: JSONObject): UsbIdentity {
            val identity = UsbIdentity(
                deviceUid = json.optString("device_uid").trim(),
                deviceName = json.optString("device_name").trim(),
                owner = json.optString("owner").trim(),
                loginUsername = json.optString("login_username").trim(),
            )
            require(identity.deviceUid.isNotBlank()) { "device_uid is missing" }
            require(identity.deviceName.isNotBlank()) { "device_name is missing" }
            require(identity.owner.isNotBlank()) { "owner is missing" }
            require(identity.loginUsername.isNotBlank()) { "login_username is missing" }
            return identity
        }
    }
}

data class HostLocation(
    val latitude: Double? = null,
    val longitude: Double? = null,
    val city: String = "Unknown",
    val country: String = "Unknown",
    val ip: String? = null,
) {
    fun displayText(): String = "$city, $country"

    fun putInto(json: JSONObject) {
        if (latitude != null) json.put("latitude", latitude)
        if (longitude != null) json.put("longitude", longitude)
        json.put("city", city)
        json.put("country", country)
        if (!ip.isNullOrBlank()) json.put("ip", ip)
    }
}
