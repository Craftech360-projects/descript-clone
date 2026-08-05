package com.jumpcut.android

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import android.webkit.JavascriptInterface
import android.widget.Toast
import java.net.HttpURLConnection
import java.net.URL

/**
 * The Android counterpart of the desktop shell's save dialog
 * (desktop/win/main.cjs installSaveDialog): gets the finished file OUT of the
 * app. Injected into the WebView as `window.JumpCutAndroid`; the web side
 * feature-detects it in apps/web/src/download.ts and prefers it over the
 * anchor-click that Android WebView silently drops.
 *
 * Everything lands in the system Downloads collection via MediaStore — visible
 * in Files, no storage permission needed on API 29+.
 */
class DownloadBridge(private val context: Context, private val origin: String) {

    companion object { private const val TAG = "jumpcut-shell" }

    private val main = Handler(Looper.getMainLooper())

    private fun toast(msg: String) {
        main.post { Toast.makeText(context, msg, Toast.LENGTH_LONG).show() }
    }

    /**
     * Save a server URL (a finished render, `/media/renders/…`) to Downloads.
     * The URL may be relative — it is resolved against the local server's
     * origin. Streaming through HTTP rather than reaching into MEDIA_DIR keeps
     * this class ignorant of the server's file layout.
     */
    @JavascriptInterface
    fun saveUrl(url: String, filename: String) {
        Thread({
            try {
                val absolute = if (url.startsWith("http")) url else origin + url
                val conn = URL(absolute).openConnection() as HttpURLConnection
                conn.connect()
                if (conn.responseCode != 200) throw Exception("HTTP ${conn.responseCode}")

                val mime = conn.contentType ?: guessMime(filename)
                val uri = insertDownload(filename, mime) ?: throw Exception("MediaStore refused")
                context.contentResolver.openOutputStream(uri)!!.use { out ->
                    conn.inputStream.use { it.copyTo(out) }
                }
                finishDownload(uri)
                toast("Saved to Downloads: $filename")
            } catch (e: Exception) {
                Log.e(TAG, "saveUrl failed", e)
                toast("Save failed: ${e.message}")
            }
        }, "save-url").start()
    }

    /** Save generated text (caption sidecars) to Downloads. */
    @JavascriptInterface
    fun saveText(content: String, filename: String, mime: String) {
        Thread({
            try {
                val uri = insertDownload(filename, mime.ifBlank { "text/plain" })
                    ?: throw Exception("MediaStore refused")
                context.contentResolver.openOutputStream(uri)!!.use {
                    it.write(content.toByteArray(Charsets.UTF_8))
                }
                finishDownload(uri)
                toast("Saved to Downloads: $filename")
            } catch (e: Exception) {
                Log.e(TAG, "saveText failed", e)
                toast("Save failed: ${e.message}")
            }
        }, "save-text").start()
    }

    private fun insertDownload(filename: String, mime: String): Uri? {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, filename)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            // Owned until fully written, so a half-streamed render never shows
            // up in Files looking finished.
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        return context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
    }

    private fun finishDownload(uri: Uri) {
        val values = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
        context.contentResolver.update(uri, values, null, null)
    }

    private fun guessMime(filename: String): String = when {
        filename.endsWith(".mp4") -> "video/mp4"
        filename.endsWith(".m4a") -> "audio/mp4"
        filename.endsWith(".srt") || filename.endsWith(".vtt") || filename.endsWith(".ass") -> "text/plain"
        else -> "application/octet-stream"
    }
}
