package com.cosyncing.client

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileInputStream
import java.lang.ref.WeakReference
import java.util.concurrent.Executors

/** Application-scoped request: an activity can be recreated while DocumentsUI is open. */
internal object FileExport {
    private const val requestCode = 48127
    private data class Request(val source: File, val name: String, val result: MethodChannel.Result)
    private var activity = WeakReference<Activity>(null)
    private var pending: Request? = null
    private var copying = false
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    val isPending: Boolean get() = pending != null

    fun attach(host: Activity) { activity = WeakReference(host) }
    fun detach(host: Activity) { if (activity.get() === host) activity.clear() }

    fun saveAs(context: Context, call: MethodCall, result: MethodChannel.Result) {
        if (pending != null) {
            result.error("busy", "Another save is already in progress.", null)
            return
        }
        val host = activity.get()
        if (host == null || host.isFinishing || host.isDestroyed) {
            result.error("no_activity", "Open the app before saving a file.", null)
            return
        }
        val source = try {
            val path = call.argument<String>("sourcePath")
                ?: throw IllegalArgumentException("Source path is missing.")
            val file = File(path).canonicalFile
            val allowed = listOf(context.cacheDir, context.filesDir).any { root ->
                file.path.startsWith(root.canonicalPath + File.separator)
            }
            require(allowed && file.isFile) { "Source must be a cached app file." }
            file
        } catch (error: Exception) {
            result.error("invalid_source", error.message, null)
            return
        }
        val name = call.argument<String>("suggestedName")?.takeIf { it.isNotBlank() } ?: source.name
        pending = Request(source, name, result)
        try {
            @Suppress("DEPRECATION")
            host.startActivityForResult(
                Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = call.argument<String>("mimeType")?.takeIf { it.isNotBlank() }
                        ?: "application/octet-stream"
                    putExtra(Intent.EXTRA_TITLE, name)
                }, requestCode,
            )
        } catch (error: Exception) {
            pending = null
            result.error("no_activity", error.message, null)
        }
    }

    fun onActivityResult(context: Context, code: Int, resultCode: Int, data: Intent?) {
        if (code != requestCode || copying) return
        val request = pending ?: return
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) {
            pending = null
            request.result.success(null)
            return
        }
        copying = true
        // Retain only the application context, never the activity, during I/O.
        executor.execute {
            try {
                FileInputStream(request.source).use { input ->
                    val output = context.contentResolver.openOutputStream(uri, "wt")
                        ?: throw IllegalStateException("The destination could not be opened.")
                    output.use { input.copyTo(it) }
                }
                val name = try {
                    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                        ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
                } catch (_: Exception) { null }
                main.post {
                    pending = null
                    copying = false
                    request.result.success(mapOf("uri" to uri.toString(), "displayName" to (name ?: request.name)))
                }
            } catch (error: Exception) {
                try { DocumentsContract.deleteDocument(context.contentResolver, uri) } catch (_: Exception) { }
                main.post {
                    pending = null
                    copying = false
                    request.result.error("write_failed", error.message, null)
                }
            }
        }
    }
}
