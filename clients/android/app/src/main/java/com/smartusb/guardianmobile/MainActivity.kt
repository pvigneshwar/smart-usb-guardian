package com.smartusb.guardianmobile

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.storage.StorageManager
import android.provider.DocumentsContract
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.documentfile.provider.DocumentFile
import org.json.JSONObject
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

class MainActivity : AppCompatActivity() {
    private lateinit var statusText: TextView
    private lateinit var statusDetailText: TextView
    private lateinit var selectedRootText: TextView
    private lateinit var identityCard: LinearLayout
    private lateinit var loginSection: LinearLayout
    private lateinit var registrationCard: LinearLayout
    private lateinit var deviceUidText: TextView
    private lateinit var usbNameText: TextView
    private lateinit var ownerText: TextView
    private lateinit var loginUsernameText: TextView
    private lateinit var vaultStatusText: TextView
    private lateinit var passwordInput: EditText
    private lateinit var loginButton: Button
    private lateinit var selectUsbButton: Button
    private lateinit var registerModeButton: Button
    private lateinit var openVaultButton: Button
    private lateinit var registerDeviceNameInput: EditText
    private lateinit var registerOwnerInput: EditText
    private lateinit var registerUsernameInput: EditText
    private lateinit var registerPasswordInput: EditText
    private lateinit var registerConfirmPasswordInput: EditText
    private lateinit var registerButton: Button
    private lateinit var cancelRegistrationButton: Button
    private lateinit var logText: TextView

    private val prefs by lazy { getSharedPreferences("usb_guardian_mobile", MODE_PRIVATE) }
    private val storageReader by lazy { UsbStorageReader(this) }
    private val locationService by lazy { LocationService(this) }

    private var identity: UsbIdentity? = null
    private var selectedTreeUri: Uri? = null
    private var vaultFile: DocumentFile? = null
    private var missingFiles: List<String> = emptyList()
    private var pendingLogin = false
    private var pendingRegistrationSelection = false

    private val folderPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri == null) {
            appendLog("USB folder selection cancelled")
            return@registerForActivityResult
        }

        persistTreePermission(uri)
        selectedTreeUri = uri
        selectedRootText.text = "Selected USB root: $uri"

        if (pendingRegistrationSelection) {
            pendingRegistrationSelection = false
            prepareRegistration(uri)
        } else {
            loadExistingOrOfferRegistration(uri)
        }
    }

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (pendingLogin) {
            pendingLogin = false
            performLogin()
        }
    }

    private val uiDetachReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == UsbManager.ACTION_USB_DEVICE_DETACHED) {
                setStatus("USB disconnected", "The Android device reported that the OTG storage was removed.", false)
                loginButton.isEnabled = false
                openVaultButton.isEnabled = false
                appendLog("USB detached. DISCONNECTED is being reported by the background receiver.")
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        bindViews()
        bindActions()
        registerUiDetachReceiver()
        handleUsbIntent(intent)
        trySavedUsbRoot()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleUsbIntent(intent)
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(uiDetachReceiver) }
        super.onDestroy()
    }

    private fun bindViews() {
        statusText = findViewById(R.id.statusText)
        statusDetailText = findViewById(R.id.statusDetailText)
        selectedRootText = findViewById(R.id.selectedRootText)
        identityCard = findViewById(R.id.identityCard)
        loginSection = findViewById(R.id.loginSection)
        registrationCard = findViewById(R.id.registrationCard)
        deviceUidText = findViewById(R.id.deviceUidText)
        usbNameText = findViewById(R.id.usbNameText)
        ownerText = findViewById(R.id.ownerText)
        loginUsernameText = findViewById(R.id.loginUsernameText)
        vaultStatusText = findViewById(R.id.vaultStatusText)
        passwordInput = findViewById(R.id.passwordInput)
        loginButton = findViewById(R.id.loginButton)
        selectUsbButton = findViewById(R.id.selectUsbButton)
        registerModeButton = findViewById(R.id.registerModeButton)
        openVaultButton = findViewById(R.id.openVaultButton)
        registerDeviceNameInput = findViewById(R.id.registerDeviceNameInput)
        registerOwnerInput = findViewById(R.id.registerOwnerInput)
        registerUsernameInput = findViewById(R.id.registerUsernameInput)
        registerPasswordInput = findViewById(R.id.registerPasswordInput)
        registerConfirmPasswordInput = findViewById(R.id.registerConfirmPasswordInput)
        registerButton = findViewById(R.id.registerButton)
        cancelRegistrationButton = findViewById(R.id.cancelRegistrationButton)
        logText = findViewById(R.id.logText)
    }

    private fun bindActions() {
        selectUsbButton.setOnClickListener {
            pendingRegistrationSelection = false
            launchUsbFolderPicker()
        }
        registerModeButton.setOnClickListener {
            pendingRegistrationSelection = true
            launchUsbFolderPicker()
        }
        registerButton.setOnClickListener { registerUsbFromAndroid() }
        cancelRegistrationButton.setOnClickListener {
            registrationCard.visibility = View.GONE
            setStatus("Registration cancelled", "Select an existing registered USB or start registration again.", false)
        }
        loginButton.setOnClickListener { startLogin() }
        openVaultButton.setOnClickListener { openVault() }
    }

    private fun registerUiDetachReceiver() {
        val filter = IntentFilter(UsbManager.ACTION_USB_DEVICE_DETACHED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(uiDetachReceiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(uiDetachReceiver, filter)
        }
    }

    private fun handleUsbIntent(intent: Intent?) {
        if (intent?.action == UsbManager.ACTION_USB_DEVICE_ATTACHED) {
            setStatus("USB detected", "Choose Existing USB or Register New USB.", true)
            appendLog("USB_DEVICE_ATTACHED received")
            if (prefs.getString("tree_uri", null).isNullOrBlank()) {
                statusDetailText.postDelayed({ launchUsbFolderPicker() }, 450)
            }
        }
    }

    private fun launchUsbFolderPicker() {
        val storageManager = getSystemService(Context.STORAGE_SERVICE) as StorageManager
        val removable = storageManager.storageVolumes.firstOrNull { it.isRemovable && !it.isPrimary }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && removable != null) {
            val intent = removable.createOpenDocumentTreeIntent()
            @Suppress("DEPRECATION")
            val initialUri = intent.getParcelableExtra<Uri>(DocumentsContract.EXTRA_INITIAL_URI)
            folderPicker.launch(initialUri)
        } else {
            folderPicker.launch(null)
        }
    }

    private fun persistTreePermission(uri: Uri) {
        runCatching {
            contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        }
        prefs.edit().putString("tree_uri", uri.toString()).apply()
    }

    private fun trySavedUsbRoot() {
        val stored = prefs.getString("tree_uri", null) ?: return
        val uri = Uri.parse(stored)
        selectedTreeUri = uri
        selectedRootText.text = "Saved USB root: $uri"
        runCatching { loadExistingOrOfferRegistration(uri) }
    }

    private fun loadExistingOrOfferRegistration(uri: Uri) {
        try {
            val inspection = storageReader.inspect(uri)
            if (inspection.identityFile == null) {
                prepareRegistration(uri)
            } else {
                loadIdentity(uri, reportConnected = true)
            }
        } catch (error: Exception) {
            identity = null
            loginButton.isEnabled = false
            identityCard.visibility = View.GONE
            loginSection.visibility = View.GONE
            setStatus("Unable to open USB root", error.message ?: "Unknown error", false)
            appendLog("USB root error: ${error.message}")
        }
    }

    private fun prepareRegistration(uri: Uri) {
        try {
            val inspection = storageReader.inspect(uri)
            if (inspection.identityFile != null) {
                setStatus("USB already registered", "An existing usb_guardian.id was found. Loading it instead.", true)
                loadIdentity(uri, reportConnected = true)
                return
            }

            selectedTreeUri = uri
            identity = null
            vaultFile = inspection.vaultFile
            missingFiles = if (inspection.vaultFile == null) listOf("secure_data.hc") else emptyList()
            identityCard.visibility = View.GONE
            loginSection.visibility = View.GONE
            registrationCard.visibility = View.VISIBLE
            registerButton.isEnabled = true
            setStatus(
                "Register USB from Android",
                "Enter the owner and login details. The app will register the device and create usb_guardian.id in this USB root.",
                true,
            )
            appendLog("USB root is ready for registration")
        } catch (error: Exception) {
            setStatus("Registration unavailable", error.message ?: "Cannot write to selected USB root", false)
            appendLog("Registration preparation failed: ${error.message}")
        }
    }

    private fun registerUsbFromAndroid() {
        val uri = selectedTreeUri ?: run {
            toast("Select the USB root first")
            return
        }

        val deviceName = registerDeviceNameInput.text.toString().trim()
        val owner = registerOwnerInput.text.toString().trim()
        val username = registerUsernameInput.text.toString().trim()
        val password = registerPasswordInput.text.toString()
        val confirmPassword = registerConfirmPasswordInput.text.toString()

        if (deviceName.isBlank()) {
            registerDeviceNameInput.error = "USB name is required"
            return
        }
        if (owner.isBlank()) {
            registerOwnerInput.error = "Owner name is required"
            return
        }
        if (username.isBlank()) {
            registerUsernameInput.error = "Login username is required"
            return
        }
        if (password.length < 4) {
            registerPasswordInput.error = "Use at least 4 characters"
            return
        }
        if (password != confirmPassword) {
            registerConfirmPasswordInput.error = "Passwords do not match"
            return
        }

        registerButton.isEnabled = false
        setStatus("Registering USB", "Creating the backend registration and writing usb_guardian.id…", true)

        ApiClient.registerUsb(deviceName, owner, username, password) { result ->
            result.onSuccess { json ->
                val registered = json.optBoolean("registered", false)
                val httpStatus = json.optInt("_http_status", 0)
                if (!registered || httpStatus !in 200..299) {
                    registerButton.isEnabled = true
                    val reason = json.optString("reason", json.optString("message", "Registration failed"))
                    setStatus("Registration failed", reason, false)
                    appendLog("Registration rejected. HTTP $httpStatus: $reason")
                    return@onSuccess
                }

                try {
                    val identityJson = json.getJSONObject("usb_guardian_id")
                    val createdIdentity = UsbIdentity.fromJson(identityJson)
                    storageReader.writeIdentity(uri, createdIdentity)
                    clearRegistrationPasswords()
                    registrationCard.visibility = View.GONE
                    appendLog("Registered ${createdIdentity.deviceUid} and created ${Config.ID_FILE_NAME}")
                    setStatus("USB registration complete", "The USB is now registered for Windows and Android access.", true)
                    loadIdentity(uri, reportConnected = true)
                } catch (error: Exception) {
                    registerButton.isEnabled = true
                    setStatus(
                        "Registered, but identity write failed",
                        "The backend created the device, but Android could not write ${Config.ID_FILE_NAME}: ${error.message}",
                        false,
                    )
                    appendLog("IMPORTANT: Save this identity manually: ${json.optString("usb_guardian_id_text")}")
                }
            }.onFailure { error ->
                registerButton.isEnabled = true
                setStatus("Server unreachable", error.message ?: "Network error", false)
                appendLog("Registration request failed: ${error.message}")
            }
        }
    }

    private fun clearRegistrationPasswords() {
        registerPasswordInput.text?.clear()
        registerConfirmPasswordInput.text?.clear()
    }

    private fun loadIdentity(uri: Uri, reportConnected: Boolean) {
        try {
            val result = storageReader.read(uri)
            selectedTreeUri = uri
            identity = result.identity
            vaultFile = result.vaultFile
            missingFiles = result.missingFiles
            cacheIdentity(result.identity)

            registrationCard.visibility = View.GONE
            identityCard.visibility = View.VISIBLE
            loginSection.visibility = View.VISIBLE
            deviceUidText.text = "Device UID: ${result.identity.deviceUid}"
            usbNameText.text = "USB Name: ${result.identity.deviceName}"
            ownerText.text = "Owner: ${result.identity.owner}"
            loginUsernameText.text = "Login Username: ${result.identity.loginUsername}"
            vaultStatusText.text = if (result.vaultFile != null) {
                "VeraCrypt Vault: ${result.vaultFile.name}"
            } else {
                "VeraCrypt Vault: Missing (secure_data.hc)"
            }
            loginButton.isEnabled = true
            openVaultButton.isEnabled = false
            setStatus("Registered USB loaded", "Identity loaded. Enter the USB Guardian password.", true)
            appendLog("Loaded ${result.identity.deviceUid} from ${Config.ID_FILE_NAME}")

            if (reportConnected) reportConnection("CONNECTED")
        } catch (error: Exception) {
            identity = null
            loginButton.isEnabled = false
            identityCard.visibility = View.GONE
            loginSection.visibility = View.GONE
            setStatus("Unable to read USB identity", error.message ?: "Unknown error", false)
            appendLog("Identity error: ${error.message}")
        }
    }

    private fun cacheIdentity(value: UsbIdentity) {
        prefs.edit().putString("identity_json", value.toJson().toString()).apply()
    }

    private fun reportConnection(connection: String) {
        val currentIdentity = identity ?: return
        val tamper = if (vaultFile == null) "TAMPER_VAULT_MISSING" else "OK"
        locationService.fetch { location ->
            cacheLocation(location)
            ApiClient.connection(currentIdentity, connection, location, tamper, missingFiles) { result ->
                result.onSuccess {
                    appendLog("$connection reported. HTTP ${it.optInt("_http_status")}")
                }.onFailure {
                    appendLog("Could not report $connection: ${it.message}")
                }
            }
        }
    }

    private fun startLogin() {
        if (identity == null) {
            toast("Select a registered USB first")
            return
        }
        if (passwordInput.text.toString().isBlank()) {
            passwordInput.error = "Password is required"
            return
        }

        if (!locationService.hasPermission()) {
            pendingLogin = true
            permissionLauncher.launch(
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                )
            )
            return
        }
        performLogin()
    }

    private fun performLogin() {
        val currentIdentity = identity ?: return
        val password = passwordInput.text.toString()
        loginButton.isEnabled = false
        setStatus("Authenticating", "Collecting host location and reporting the access attempt…", true)

        locationService.fetch { location ->
            cacheLocation(location)
            val tamper = if (vaultFile == null) "TAMPER_VAULT_MISSING" else "OK"
            ApiClient.login(currentIdentity, password, location, tamper) { result ->
                loginButton.isEnabled = true
                result.onSuccess { json -> showLoginResult(json, location) }
                    .onFailure { error ->
                        setStatus("Server unreachable", error.message ?: "Network error", false)
                        appendLog("Login request failed: ${error.message}")
                    }
            }
        }
    }

    private fun showLoginResult(json: JSONObject, location: HostLocation) {
        val success = json.optBoolean("success", false)
        val status = json.optString("access_status", if (success) "GRANTED" else "DENIED")
        val reason = json.optString("reason", json.optString("message", "Unknown response"))
        if (success) {
            setStatus("ACCESS GRANTED", "${location.displayText()} • ${location.latitude ?: "-"}, ${location.longitude ?: "-"}", true)
            openVaultButton.isEnabled = vaultFile != null
        } else {
            setStatus("ACCESS DENIED", reason, false)
            openVaultButton.isEnabled = false
        }
        appendLog("$status | ${json.optString("time", "No timestamp")} | ${location.displayText()}")
    }

    private fun openVault() {
        val file = vaultFile ?: run {
            toast("secure_data.hc was not found")
            return
        }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(file.uri, "application/octet-stream")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
            startActivity(Intent.createChooser(intent, "Open VeraCrypt-compatible vault"))
        } catch (_: Exception) {
            toast("Install an Android app that supports VeraCrypt containers")
        }
    }

    private fun cacheLocation(location: HostLocation) {
        prefs.edit()
            .putString("last_city", location.city)
            .putString("last_country", location.country)
            .putString("last_latitude", location.latitude?.toString())
            .putString("last_longitude", location.longitude?.toString())
            .apply()
    }

    private fun setStatus(title: String, detail: String, positive: Boolean) {
        statusText.text = title
        statusText.setTextColor(ContextCompat.getColor(this, if (positive) R.color.green_500 else R.color.red_500))
        statusDetailText.text = detail
    }

    private fun appendLog(message: String) {
        val time = LocalDateTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss"))
        val previous = if (logText.text == "No events yet.") "" else logText.text.toString() + "\n"
        logText.text = previous + "[$time] $message"
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()
}
