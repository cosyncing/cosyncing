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
import java.util.concurrent.CancellationException
import java.util.concurrent.Executors

/** Application-scoped request: an activity can be recreated while DocumentsUI is open. */
internal object FileExport {
    private data class Request(
        val id: Int,
        val code: Int,
        val source: File,
        val name: String,
        val result: MethodChannel.Result,
        @Volatile var canceled: Boolean = false,
        var copying: Boolean = false,
    )
    private var nextCode = 48127
    private val canceledCodes = mutableSetOf<Int>()
    private var activity = WeakReference<Activity>(null)
    private var pending: Request? = null
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    val isPending: Boolean get() = pending?.canceled == false

    fun attach(host: Activity) { activity = WeakReference(host) }
    fun detach(host: Activity) {
        if (activity.get() === host) {
            // Rotation transfers the pending result to the replacement host.
            // Finishing the task cancels it, even if Android sends no result.
            if (!host.isChangingConfigurations) cancel()
            activity.clear()
        }
    }

    fun cancel(requestId: Int? = null) {
        val request = pending ?: return
        if (requestId != null && request.id != requestId) return
        request.canceled = true
        // Keep Dart's queue occupied until a canceled copy has closed its
        // streams and removed the partial document. A later save may overwrite
        // the same URI, so cleanup must finish before that save can start.
        if (request.copying) return
        pending = null
        canceledCodes.add(request.code)
        try {
            @Suppress("DEPRECATION")
            activity.get()?.finishActivity(request.code)
        } catch (_: Exception) { }
        request.result.success(null)
    }

    fun saveAs(context: Context, call: MethodCall, result: MethodChannel.Result) {
        if (pending != null) {
            result.error("busy", "Another save is already in progress.", null)
            return
        }
        val host = activity.get()
        if (host == null || host.isFinishing || host.isDestroyed || !host.hasWindowFocus()) {
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
        // A late result from a canceled picker cannot complete a newer save.
        val code = nextCode++
        if (nextCode > 65534) nextCode = 48127
        canceledCodes.remove(code)
        val request = Request(call.argument<Int>("requestId") ?: code, code, source, name, result)
        pending = request
        try {
            @Suppress("DEPRECATION")
            host.startActivityForResult(
                Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = call.argument<String>("mimeType")?.takeIf { it.isNotBlank() }
                        ?: "application/octet-stream"
                    putExtra(Intent.EXTRA_TITLE, name)
                }, request.code,
            )
        } catch (error: Exception) {
            pending = null
            result.error("no_activity", error.message, null)
        }
    }

    fun onActivityResult(context: Context, code: Int, resultCode: Int, data: Intent?) {
        if (canceledCodes.remove(code)) {
            data?.data?.let { uri -> executor.execute { deletePartial(context, uri) } }
            return
        }
        val request = pending ?: return
        if (code != request.code || request.copying) return
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) {
            pending = null
            request.result.success(null)
            return
        }
        request.copying = true
        // Retain only the application context, never the activity, during I/O.
        executor.execute {
            try {
                FileInputStream(request.source).use { input ->
                    if (request.canceled) throw CancellationException()
                    val output = context.contentResolver.openOutputStream(uri, "wt")
                        ?: throw IllegalStateException("The destination could not be opened.")
                    output.use {
                        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                        while (true) {
                            if (request.canceled) throw CancellationException()
                            val count = input.read(buffer)
                            if (count < 0) break
                            it.write(buffer, 0, count)
                        }
                    }
                }
                val name = try {
                    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                        ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
                } catch (_: Exception) { null }
                main.post {
                    if (request.canceled) {
                        executor.execute {
                            deletePartial(context, uri)
                            main.post {
                                if (pending === request) {
                                    pending = null
                                    request.result.success(null)
                                }
                            }
                        }
                    } else if (pending === request) {
                        pending = null
                        request.result.success(mapOf("uri" to uri.toString(), "displayName" to (name ?: request.name)))
                    }
                }
            } catch (error: Exception) {
                deletePartial(context, uri)
                main.post {
                    if (pending === request) {
                        pending = null
                        if (request.canceled) request.result.success(null)
                        else request.result.error("write_failed", error.message, null)
                    }
                }
            }
        }
    }

    private fun deletePartial(context: Context, uri: android.net.Uri) {
        try { DocumentsContract.deleteDocument(context.contentResolver, uri) } catch (_: Exception) { }
    }
}
