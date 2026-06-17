package com.smartusb.guardianmobile

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import org.json.JSONObject

class UsbStorageReader(private val context: Context) {

    data class ReadResult(
        val identity: UsbIdentity,
        val vaultFile: DocumentFile?,
        val missingFiles: List<String>,
    )

    data class RootInspection(
        val root: DocumentFile,
        val identityFile: DocumentFile?,
        val vaultFile: DocumentFile?,
    )

    fun inspect(treeUri: Uri): RootInspection {
        val root = DocumentFile.fromTreeUri(context, treeUri)
            ?: error("Unable to open the selected USB folder")
        require(root.isDirectory) { "The selected item is not a folder" }

        val identityFile = findFileIgnoreCase(root, Config.ID_FILE_NAME)
        val vaultFile = Config.VAULT_FILE_NAMES.firstNotNullOfOrNull { findFileIgnoreCase(root, it) }
        return RootInspection(root, identityFile, vaultFile)
    }

    fun read(treeUri: Uri): ReadResult {
        val inspection = inspect(treeUri)
        val idFile = inspection.identityFile
            ?: error("${Config.ID_FILE_NAME} was not found in the selected USB root")

        val text = context.contentResolver.openInputStream(idFile.uri)?.bufferedReader()?.use { it.readText() }
            ?: error("Unable to read ${Config.ID_FILE_NAME}")

        val identity = UsbIdentity.fromJson(JSONObject(text))
        val missing = mutableListOf<String>()
        if (inspection.vaultFile == null) missing += "secure_data.hc"

        return ReadResult(identity, inspection.vaultFile, missing)
    }

    fun writeIdentity(treeUri: Uri, identity: UsbIdentity) {
        val inspection = inspect(treeUri)
        val target = inspection.identityFile
            ?: inspection.root.createFile("application/octet-stream", Config.ID_FILE_NAME)
            ?: error("Unable to create ${Config.ID_FILE_NAME} in the selected USB root")

        context.contentResolver.openOutputStream(target.uri, "rwt")?.bufferedWriter(Charsets.UTF_8).use { writer ->
            requireNotNull(writer) { "Unable to write ${Config.ID_FILE_NAME}" }
            writer.write(identity.toJson().toString(2))
            writer.flush()
        }

        // Verify that the identity can be read back from the USB.
        val verified = read(treeUri).identity
        require(verified == identity) { "USB identity verification failed after writing" }
    }

    private fun findFileIgnoreCase(root: DocumentFile, name: String): DocumentFile? {
        return root.listFiles().firstOrNull { it.name.equals(name, ignoreCase = true) }
    }
}
