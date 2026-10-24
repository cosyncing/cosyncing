package com.cosyncing.client

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.Executors

/** Android host/provider adapter; pending saves belong to the application. */
internal object FileExport {
    private var activity = WeakReference<Activity>(null)
    private var resumed = false
    private var finishRequested = false
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val session = DocumentExportSession(
        executeIo = { executor.execute(it) },
        postMain = { main.post(it) },
        onIdle = { releaseFinishedEngineWhenIdle() },
    )

    val isPending: Boolean get() = session.isPending

    fun attach(host: Activity, restored: Boolean) {
        // The new host did not launch the old picker, so there is none to close.
        session.hostStarted(restored, launcherGone = activity.get() == null)
        activity = WeakReference(host)
        resumed = false
        finishRequested = false
    }
    fun resume(host: Activity) { if (activity.get() === host) resumed = true }
    fun pause(host: Activity) { if (activity.get() === host) resumed = false }
    fun detach(host: Activity) {
        if (activity.get() === host) {
            resumed = false
            finishRequested = host.isFinishing
            closePicker(session.detach(host.isFinishing))
            activity.clear()
        }
    }

    fun cancel(requestId: Int? = null) { closePicker(session.cancel(requestId)) }

    private fun closePicker(code: Int?) {
        if (code == null) return
        try {
            @Suppress("DEPRECATION")
            activity.get()?.finishActivity(code)
        } catch (_: Exception) { }
    }

    fun saveAs(context: Context, call: MethodCall, result: MethodChannel.Result) {
        if (session.isPending) {
            result.error("busy", "Another save is already in progress.", null)
            return
        }
        val host = activity.get()
        if (host == null || host.isFinishing || host.isDestroyed || !resumed) {
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
        val code = session.begin(call.argument<Int>("requestId"), source, name, object : DocumentExportReply {
            override fun success(value: Map<String, String>?) { result.success(value) }
            override fun error(code: String, message: String?) { result.error(code, message, null) }
        }) ?: return
        try {
            @Suppress("DEPRECATION")
            host.startActivityForResult(
                Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = call.argument<String>("mimeType")?.takeIf { it.isNotBlank() }
                        ?: "application/octet-stream"
                    putExtra(Intent.EXTRA_TITLE, name)
                }, code,
            )
        } catch (error: Exception) { session.launchFailed(code, error.message) }
    }

    fun onActivityResult(context: Context, code: Int, resultCode: Int, data: Intent?) {
        val pickedUri = data?.data
        val application = context.applicationContext
        val document = if (resultCode != Activity.RESULT_OK || pickedUri == null) null else object : ExportDocument {
            override val uri: String = pickedUri.toString()
            override fun open() = application.contentResolver.openOutputStream(pickedUri, "wt")
                ?: throw IllegalStateException("The destination could not be opened.")
            override fun displayName(): String? = application.contentResolver.query(
                pickedUri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null,
            )?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
        }
        session.result(code, document)
    }

    private fun releaseFinishedEngineWhenIdle() {
        // Run after Activity.onDestroy. A replacement host cancels this release.
        main.post {
            if (finishRequested && activity.get() == null && !session.isPending &&
                !BackgroundConnectionService.isRunning && !UpdateDownloadService.isActive) {
                RetainedEngine.engine?.destroy()
            }
        }
    }
}
