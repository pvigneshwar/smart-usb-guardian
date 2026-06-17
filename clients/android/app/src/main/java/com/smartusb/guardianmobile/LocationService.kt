package com.smartusb.guardianmobile

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.location.Geocoder
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import androidx.core.content.ContextCompat
import java.util.Locale
import java.util.concurrent.Executors

class LocationService(private val activity: Activity) {
    private val executor = Executors.newSingleThreadExecutor()
    private val locationManager = activity.getSystemService(Context.LOCATION_SERVICE) as LocationManager

    fun hasPermission(): Boolean {
        return ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    }

    fun fetch(callback: (HostLocation) -> Unit) {
        if (!hasPermission()) {
            callback(HostLocation())
            return
        }

        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
        val lastKnown = providers.mapNotNull { provider ->
            runCatching { locationManager.getLastKnownLocation(provider) }.getOrNull()
        }.maxByOrNull { it.time }

        if (lastKnown != null && System.currentTimeMillis() - lastKnown.time < 10 * 60 * 1000) {
            reverseGeocode(lastKnown, callback)
            return
        }

        val provider = when {
            runCatching { locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) }.getOrDefault(false) -> LocationManager.NETWORK_PROVIDER
            runCatching { locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER) }.getOrDefault(false) -> LocationManager.GPS_PROVIDER
            else -> null
        }

        if (provider == null) {
            callback(lastKnown?.let { HostLocation(it.latitude, it.longitude) } ?: HostLocation())
            return
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                locationManager.getCurrentLocation(
                    provider,
                    CancellationSignal(),
                    activity.mainExecutor,
                ) { location ->
                    if (location != null) reverseGeocode(location, callback) else callback(HostLocation())
                }
            } else {
                val listener = object : LocationListener {
                    override fun onLocationChanged(location: Location) {
                        runCatching { locationManager.removeUpdates(this) }
                        reverseGeocode(location, callback)
                    }

                    @Deprecated("Deprecated in Android")
                    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
                    override fun onProviderEnabled(provider: String) = Unit
                    override fun onProviderDisabled(provider: String) = Unit
                }
                @Suppress("MissingPermission")
                locationManager.requestSingleUpdate(provider, listener, activity.mainLooper)
            }
        } catch (_: SecurityException) {
            callback(HostLocation())
        } catch (_: Exception) {
            callback(HostLocation())
        }
    }

    private fun reverseGeocode(location: Location, callback: (HostLocation) -> Unit) {
        executor.execute {
            val result = try {
                @Suppress("DEPRECATION")
                val address = Geocoder(activity, Locale.getDefault())
                    .getFromLocation(location.latitude, location.longitude, 1)
                    ?.firstOrNull()

                HostLocation(
                    latitude = location.latitude,
                    longitude = location.longitude,
                    city = address?.locality ?: address?.subAdminArea ?: address?.adminArea ?: "Unknown",
                    country = address?.countryName ?: "Unknown",
                )
            } catch (_: Exception) {
                HostLocation(location.latitude, location.longitude)
            }
            activity.runOnUiThread { callback(result) }
        }
    }
}
