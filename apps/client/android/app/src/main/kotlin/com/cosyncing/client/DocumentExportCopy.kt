package com.cosyncing.client

import java.io.File
import java.io.FileInputStream
import java.io.OutputStream
import java.util.concurrent.CancellationException

/**
 * Streams a cached source into a user-selected document. The destination may
 * already belong to the user: cancellation/failure must never delete it.
 * Opening a destination can truncate it, so validate/open the source first.
 */
internal fun copyExportDocument(
    source: File,
    openDestination: () -> OutputStream,
    isCanceled: () -> Boolean,
    beforeDestinationOpen: () -> Unit = {},
) {
    fun checkCanceled() {
        if (isCanceled()) throw CancellationException()
    }
    checkCanceled()
    FileInputStream(source).use { input ->
        checkCanceled()
        // Commit cancellation before a provider can truncate the destination.
        // Once committed, finish the copy even if the caller goes away.
        beforeDestinationOpen()
        openDestination().use { output ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                output.write(buffer, 0, count)
            }
        }
    }
}

/** The document provider offers write/name capabilities, never deletion. */
internal interface ExportDocument {
    val uri: String
    fun open(): OutputStream
    fun displayName(): String?
}

internal interface DocumentExportReply {
    fun success(value: Map<String, String>?)
    fun error(code: String, message: String?)
}

/** Application-lifetime save flow, independently exercisable from Android UI. */
internal class DocumentExportSession(
    private val executeIo: (() -> Unit) -> Unit,
    private val postMain: (() -> Unit) -> Unit,
    private val onIdle: () -> Unit,
) {
    private data class Request(
        val id: Int,
        val code: Int,
        val source: File,
        val name: String,
        val reply: DocumentExportReply,
        @Volatile var canceled: Boolean = false,
        var copying: Boolean = false,
        var writing: Boolean = false,
    )
    private var pending: Request? = null
    private var nextCode = 48127
    val isPending: Boolean get() = pending != null

    fun begin(id: Int?, source: File, name: String, reply: DocumentExportReply): Int? {
        if (pending != null) {
            reply.error("busy", "Another save is already in progress.")
            return null
        }
        val code = nextCode++
        if (nextCode > 65534) nextCode = 48127
        pending = Request(id ?: code, code, source, name, reply)
        return code
    }

    /** Returns a picker to close; copies retain pending until streams close. */
    fun cancel(id: Int? = null): Int? {
        val request = pending ?: return null
        if (id != null && request.id != id) return null
        synchronized(request) {
            if (request.writing) return null
            request.canceled = true
        }
        if (request.copying) return null
        pending = null
        try { request.reply.success(null) } finally { onIdle() }
        return request.code
    }

    fun detach(finishing: Boolean): Int? = if (finishing) cancel() else null

    /**
     * Android returns a picker result only to a recreation of the activity that
     * launched it. A fresh host started after that activity was destroyed (its
     * task removed while the process lived on) can never receive it, so end
     * the waiting request as dismissed instead of refusing every later save as
     * busy. A committed write still finishes and replies with its receipt.
     */
    fun hostStarted(restored: Boolean, launcherGone: Boolean): Int? =
        if (!restored && launcherGone) cancel() else null

    fun launchFailed(code: Int, message: String?) {
        val request = pending?.takeIf { it.code == code } ?: return
        pending = null
        try { request.reply.error("no_activity", message) } finally { onIdle() }
    }

    fun result(code: Int, document: ExportDocument?) {
        val request = pending ?: return
        // A canceled/older picker has no authority over a later request or URI.
        if (request.code != code || request.copying) return
        if (document == null) {
            request.copying = true
            // Android resumes the host after onActivityResult returns. Reply
            // on the next main-loop turn so a queued save sees that lifecycle
            // update, rather than silently dropping its offer while paused.
            postMain {
                if (pending === request) {
                    pending = null
                    try { request.reply.success(null) } finally { onIdle() }
                }
            }
            return
        }
        request.copying = true
        executeIo {
            var failure: Exception? = null
            var name: String? = null
            try {
                copyExportDocument(
                    request.source,
                    document::open,
                    isCanceled = { request.canceled },
                    beforeDestinationOpen = {
                        synchronized(request) {
                            if (request.canceled) throw CancellationException()
                            request.writing = true
                        }
                    },
                )
                if (!request.canceled) name = try { document.displayName() } catch (_: Exception) { null }
            } catch (error: Exception) {
                failure = error
            }
            postMain complete@{
                if (pending !== request) return@complete
                pending = null
                val error = failure
                try {
                    if (request.canceled) request.reply.success(null)
                    else if (error != null) request.reply.error("write_failed", error.message ?: error.toString())
                    else request.reply.success(mapOf("uri" to document.uri, "displayName" to (name ?: request.name)))
                } finally { onIdle() }
            }
        }
    }
}
