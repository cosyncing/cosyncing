package com.cosyncing.client

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.ArrayDeque
import java.io.FilterOutputStream
import java.io.IOException
import java.io.OutputStream

/** Executes the production native copy path with filesystem-backed documents. */
class DocumentExportFlowTest {
    @get:Rule val files = TemporaryFolder()

    @Test fun existingDocumentSurvivesFailuresBeforeDestinationOpen() {
        val source = files.newFile("source.md").apply { writeText("downloaded bytes") }
        val target = files.newFile("report.md").apply { writeText("owner's existing file") }
        for (reason in listOf("cancel", "missing-source", "provider-refused")) {
            var opens = 0
            try {
                copyExportDocument(
                    if (reason == "missing-source") files.root.resolve("gone.md") else source,
                    openDestination = {
                        opens++
                        throw IOException("Provider refused before opening the document")
                    },
                    isCanceled = { reason == "cancel" },
                )
                fail("The interrupted export must not succeed")
            } catch (_: Exception) { }
            assertEquals(if (reason == "provider-refused") 1 else 0, opens)
            assertTrue(target.exists())
            assertEquals("owner's existing file", target.readText())
        }
    }

    @Test fun writeFailureClosesTheStreamWithoutDeletingTheSelectedDocument() {
        val source = files.newFile("large.md").apply { writeBytes(ByteArray(32000) { 42 }) }
        val target = files.newFile("write-failed.md").apply { writeText("existing content") }
        var closed = false
        try {
            copyExportDocument(source, openDestination = {
                object : FilterOutputStream(target.outputStream()) {
                    override fun write(bytes: ByteArray, offset: Int, count: Int) {
                        out.write(bytes, offset, count)
                        throw IOException("Provider write failed")
                    }
                    override fun close() { closed = true; super.close() }
                }
            }, isCanceled = { false })
            fail("The failed write must not succeed")
        } catch (_: IOException) { }
        assertTrue(closed)
        assertTrue(target.exists())
        assertTrue(target.length() in 1 until source.length())
    }

    @Test fun successfulExportStreamsTheWholeFileAndClosesTheDestination() {
        val payload = ByteArray(32000) { (it % 251).toByte() }
        val source = files.newFile("审阅意见.md").apply { writeBytes(payload) }
        val target = files.newFile("saved.md")
        var writes = 0
        var largestWrite = 0
        var closed = false
        copyExportDocument(
            source,
            openDestination = {
                object : OutputStream() {
                    private val output = target.outputStream()
                    override fun write(value: Int) { output.write(value) }
                    override fun write(bytes: ByteArray, offset: Int, count: Int) {
                        writes++
                        largestWrite = maxOf(largestWrite, count)
                        output.write(bytes, offset, count)
                    }
                    override fun close() { closed = true; output.close() }
                }
            },
            isCanceled = { false },
        )
        assertTrue(closed)
        assertTrue(writes > 1)
        assertTrue(largestWrite < payload.size)
        assertArrayEquals(payload, target.readBytes())
    }

    @Test fun canceledLateAnswersAndMissingSourcesPreserveAnExistingDocument() {
        val source = files.newFile("cached.md").apply { writeText("new bytes") }
        val target = Target(files.newFile("existing.md").apply { writeText("original bytes") })
        val flow = Flow()
        val canceled = Reply()
        val first = flow.session.begin(1, source, source.name, canceled)!!
        assertEquals(first, flow.session.cancel(1))
        flow.session.result(first, target)
        assertTrue(flow.io.isEmpty())
        assertEquals(listOf<Map<String, String>?>(null), canceled.values)
        val failed = Reply()
        val second = flow.session.begin(2, source, source.name, failed)!!
        flow.session.result(first, target)
        assertTrue(flow.session.isPending)
        assertTrue(flow.io.isEmpty())
        source.delete()
        flow.session.result(second, target)
        flow.io.removeFirst().invoke()
        flow.main.removeFirst().invoke()
        assertEquals(listOf("write_failed"), failed.errors)
        assertEquals(0, target.opens)
        assertTrue(target.file.exists())
        assertEquals("original bytes", target.file.readText())
    }

    @Test fun nonFinishingRecreationRetainsTheRequestAndFinishingCancelsIt() {
        val source = files.newFile("recreated-source.md").apply { writeText("saved bytes") }
        val target = Target(files.newFile("recreated-target.md"))
        val flow = Flow()
        val reply = Reply()
        val code = flow.session.begin(1, source, source.name, reply)!!
        assertNull(flow.session.detach(finishing = false))
        assertTrue(flow.session.isPending)
        assertTrue(reply.values.isEmpty())
        flow.session.result(code, target)
        flow.io.removeFirst().invoke()
        assertTrue(flow.session.isPending)
        flow.main.removeFirst().invoke()
        assertEquals(target.uri, reply.values.single()!!["uri"])
        assertEquals("saved bytes", target.file.readText())
        val canceled = Reply()
        val next = flow.session.begin(2, source, source.name, canceled)!!
        assertEquals(next, flow.session.detach(finishing = true))
        flow.session.result(next, target)
        assertEquals(1, target.opens)
        assertFalse(flow.session.isPending)
        assertEquals(listOf<Map<String, String>?>(null), canceled.values)
        val blocked = Reply()
        val blockedCode = flow.session.begin(3, source, source.name, blocked)!!
        flow.session.launchFailed(blockedCode, "Android blocked the picker")
        assertEquals(listOf("no_activity"), blocked.errors)
        assertFalse(flow.session.isPending)
        val recovery = flow.session.begin(4, source, source.name, Reply())
        assertNotNull(recovery)
        flow.session.cancel(4)
    }

    @Test fun cancelAndHostFinishAfterOpeningAllowTheWholeCopyToFinish() {
        val source = files.newFile("commit-source.md").apply { writeBytes(ByteArray(32000) { 42 }) }
        for (reason in listOf("cancel", "finish", "write-failed")) {
            val flow = Flow()
            val target = Target(files.newFile("$reason-target.md"))
            target.afterWrite = {
                assertNull(if (reason == "finish") flow.session.detach(finishing = true) else flow.session.cancel(1))
                if (reason == "write-failed") throw IOException("Provider write failed")
            }
            val reply = Reply()
            val code = flow.session.begin(1, source, source.name, reply)!!
            flow.session.result(code, target)
            flow.io.removeFirst().invoke()
            assertTrue(target.closed)
            assertTrue(flow.session.isPending)
            assertTrue(reply.values.isEmpty())
            assertEquals(0, flow.idle)
            flow.main.removeFirst().invoke()
            assertFalse(flow.session.isPending)
            assertEquals(1, flow.idle)
            if (reason == "write-failed") {
                assertEquals(listOf("write_failed"), reply.errors)
                assertTrue(reply.values.isEmpty())
            } else {
                assertEquals(target.uri, reply.values.single()!!["uri"])
                assertArrayEquals(source.readBytes(), target.file.readBytes())
            }
        }
    }

    @Test fun cancellationBeforeTheWriteCommitPreservesOriginalContents() {
        val source = files.newFile("uncommitted-source.md").apply { writeText("new bytes") }
        val target = Target(files.newFile("uncommitted-target.md").apply { writeText("original bytes") })
        val flow = Flow()
        val reply = Reply()
        val code = flow.session.begin(1, source, source.name, reply)!!
        flow.session.result(code, target)
        flow.session.cancel(1)
        assertTrue(flow.session.isPending)
        flow.io.removeFirst().invoke()
        flow.main.removeFirst().invoke()
        assertEquals(0, target.opens)
        assertEquals("original bytes", target.file.readText())
        assertEquals(listOf<Map<String, String>?>(null), reply.values)
    }

    @Test fun dismissedPickerRepliesAfterTheHostsResumeTurn() {
        val source = files.newFile("dismissed-source.md").apply { writeText("bytes") }
        val flow = Flow()
        val reply = Reply()
        val code = flow.session.begin(1, source, source.name, reply)!!
        flow.session.result(code, null)
        assertTrue(flow.session.isPending)
        assertTrue(reply.values.isEmpty())
        // Android performs onResume before the posted main-loop callback.
        flow.main.removeFirst().invoke()
        assertFalse(flow.session.isPending)
        assertEquals(listOf<Map<String, String>?>(null), reply.values)
        assertNotNull(flow.session.begin(2, source, source.name, Reply()))
        flow.session.cancel(2)
    }

    private class Reply : DocumentExportReply {
        val values = mutableListOf<Map<String, String>?>()
        val errors = mutableListOf<String>()
        override fun success(value: Map<String, String>?) { values.add(value) }
        override fun error(code: String, message: String?) { errors.add(code) }
    }

    private class Flow {
        val io = ArrayDeque<() -> Unit>()
        val main = ArrayDeque<() -> Unit>()
        var idle = 0
        val session = DocumentExportSession({ io.addLast(it) }, { main.addLast(it) }, { idle++ })
    }

    private class Target(val file: java.io.File) : ExportDocument {
        override val uri = "content://test/${file.name}"
        var opens = 0
        var closed = false
        var afterWrite: (() -> Unit)? = null
        override fun displayName() = file.name
        override fun open(): OutputStream {
            opens++
            return object : FilterOutputStream(file.outputStream()) {
                override fun write(bytes: ByteArray, offset: Int, count: Int) {
                    out.write(bytes, offset, count)
                    afterWrite?.invoke()
                }
                override fun close() { closed = true; super.close() }
            }
        }
    }

}
