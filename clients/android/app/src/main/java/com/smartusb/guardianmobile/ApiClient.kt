package com.smartusb.guardianmobile

import android.os.Build
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

object ApiClient {
    private val executor = Executors.newCachedThreadPool()
    private val mainHandler = Handler(Looper.getMainLooper())

    fun registerUsb(
        deviceName: String,
        owner: String,
        loginUsername: String,
        password: String,
        callback: (Result<JSONObject>) -> Unit,
    ) {
        val payload = JSONObject().apply {
            put("device_name", deviceName)
            put("owner", owner)
            put("login_username", loginUsername)
            put("password", password)
        }
        post("/device/register", payload, callback)
    }

    fun login(
        identity: UsbIdentity,
        password: String,
        location: HostLocation,
        tamperStatus: String,
        callback: (Result<JSONObject>) -> Unit,
    ) {
        val payload = basePayload(identity, location).apply {
            put("password", password)
            put("tamper_status", tamperStatus)
        }
        post("/device/login", payload, callback)
    }

    fun connection(
        identity: UsbIdentity,
        connection: String,
        location: HostLocation,
        tamperStatus: String,
        missingFiles: List<String> = emptyList(),
        callback: (Result<JSONObject>) -> Unit = {},
    ) {
        val payload = basePayload(identity, location).apply {
            put("connection", connection)
            put("tamper_status", tamperStatus)
            put("missing_files", org.json.JSONArray(missingFiles))
        }
        post("/device/connection", payload, callback)
    }

    private fun basePayload(identity: UsbIdentity, location: HostLocation): JSONObject {
        val hostDevice = "Android | ${Build.MANUFACTURER} ${Build.MODEL}".trim()
        return identity.toJson().apply {
            // Keep the legacy Windows field names for the shared Windows/Android backend.
            put("windows_user", "Android User")
            put("computer_name", hostDevice)
            put("host_user", "Android User")
            put("host_device", hostDevice)
            put("host_platform", "Android ${Build.VERSION.RELEASE}")
            location.putInto(this)
        }
    }

    private fun post(path: String, payload: JSONObject, callback: (Result<JSONObject>) -> Unit) {
        executor.execute {
            val result = runCatching {
                val connection = (URL(Config.SERVER_URL + path).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 15000
                    readTimeout = 15000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                }

                connection.outputStream.bufferedWriter(Charsets.UTF_8).use { it.write(payload.toString()) }
                val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
                val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                val json = if (body.isBlank()) JSONObject() else JSONObject(body)
                json.put("_http_status", connection.responseCode)
                connection.disconnect()
                json
            }
            mainHandler.post { callback(result) }
        }
    }
}
