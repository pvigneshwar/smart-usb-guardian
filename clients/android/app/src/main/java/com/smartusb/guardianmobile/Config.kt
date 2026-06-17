package com.smartusb.guardianmobile

object Config {
    // Change this to the IPv4 address of the computer running App 1 backend.
    const val SERVER_URL = "https://smart-usbguardian.netlify.app/api"

    const val ID_FILE_NAME = "usb_guardian.id"
    val VAULT_FILE_NAMES = listOf("secure_data.hc", "secure_data.vc")
}
