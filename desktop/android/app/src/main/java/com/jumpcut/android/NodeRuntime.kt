package com.jumpcut.android

import android.content.Context
import android.system.Os
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.URL

/**
 * Owns the in-process Node server: syncs the bundled nodejs-project assets to
 * real files, resolves paths, sets the environment, starts Node on its own
 * thread, and polls /api/health until the server answers.
 *
 * The direct analog of desktop/win/main.cjs — same env contract
 * (PORT/MEDIA_DIR/WEB_DIST/FFMPEG_PATH/FFPROBE_PATH/SETTINGS_PATH), same
 * free-port + health-poll lifecycle. The Android-only additions are TMPDIR
 * (bionic has no /tmp, and ffmpeg.ts writes its filter scripts to os.tmpdir()),
 * HOME and XDG_CACHE_HOME (fontconfig's cache, for burned captions).
 *
 * Node starts ONCE per process — libnode cannot be restarted. A dead server
 * means the whole process restarts (MainActivity handles that).
 */
class NodeRuntime(private val context: Context) {

    companion object {
        private const val TAG = "jumpcut-shell"

        init {
            System.loadLibrary("node")
            System.loadLibrary("native-lib")
        }
    }

    /** Blocks for the life of the server; run it on a dedicated thread. */
    private external fun startNodeWithArguments(arguments: Array<String>): Int

    val port: Int = ServerSocket(0).use { it.localPort }
    val origin: String get() = "http://127.0.0.1:$port"

    private val projectDir = File(context.filesDir, "nodejs-project")
    private val mediaDir = File(context.filesDir, "media")

    var onExit: ((code: Int) -> Unit)? = null

    /**
     * Copy the bundled nodejs-project out of the APK when its version stamp
     * changed. Hono's serveStatic and Node's loader need real files; APK assets
     * are not a filesystem. version.txt is a content hash written by build.mjs,
     * so app updates re-copy and unchanged relaunches don't.
     */
    private fun syncAssets() {
        val installedVersion = File(projectDir, "version.txt").takeIf { it.exists() }?.readText()
        val bundledVersion = context.assets.open("nodejs-project/version.txt")
            .bufferedReader().use { it.readText() }

        if (installedVersion == bundledVersion) {
            Log.i(TAG, "assets current ($bundledVersion)")
            return
        }

        Log.i(TAG, "syncing assets $installedVersion -> $bundledVersion")
        projectDir.deleteRecursively()
        copyAssetDir("nodejs-project", projectDir)
    }

    private fun copyAssetDir(assetPath: String, dst: File) {
        val names = context.assets.list(assetPath) ?: return
        if (names.isEmpty()) {
            // A file. (Assets can't hold empty dirs, so empty list == file is
            // ambiguous only for empty dirs, which the bundle doesn't have.)
            dst.parentFile?.mkdirs()
            context.assets.open(assetPath).use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
            return
        }
        dst.mkdirs()
        for (name in names) copyAssetDir("$assetPath/$name", File(dst, name))
    }

    /** The environment the server boots with — one map, used twice (see start). */
    private fun environment(): Map<String, String> {
        val nativeDir = context.applicationInfo.nativeLibraryDir
        return mapOf(
            "PORT" to port.toString(),
            "MEDIA_DIR" to mediaDir.absolutePath,
            "WEB_DIST" to File(projectDir, "web").absolutePath,
            "FFMPEG_PATH" to "$nativeDir/libffmpeg.so",
            "FFPROBE_PATH" to "$nativeDir/libffprobe.so",
            "SETTINGS_PATH" to File(context.filesDir, ".jumpcut-secrets.json").absolutePath,
            // bionic has no /tmp; ffmpeg.ts writes filter scripts to os.tmpdir().
            "TMPDIR" to context.cacheDir.absolutePath,
            // fontconfig (burned captions) wants a home and a cache.
            "HOME" to context.filesDir.absolutePath,
            "XDG_CACHE_HOME" to context.cacheDir.absolutePath,
        )
    }

    /**
     * Sync assets, write the config, start Node on its own thread.
     *
     * Env travels two ways, deliberately redundant: Os.setenv here (the real
     * process environment, visible if libnode snapshots environ at start) and
     * the config JSON that main.cjs assigns into process.env before importing
     * the server (guaranteed visible, and the authoritative one).
     */
    fun start() {
        syncAssets()
        mediaDir.mkdirs()

        val env = environment()
        for ((k, v) in env) Os.setenv(k, v, true)

        val config = JSONObject()
            .put("cwd", projectDir.absolutePath)
            .put("env", JSONObject(env))
        val configFile = File(context.filesDir, "node-config.json")
        configFile.writeText(config.toString())

        val mainCjs = File(projectDir, "main.cjs").absolutePath
        Thread({
            val code = startNodeWithArguments(arrayOf("node", mainCjs, configFile.absolutePath))
            Log.w(TAG, "node thread ended, code=$code")
            onExit?.invoke(code)
        }, "node-main").start()
    }

    /**
     * Poll until the server answers, so the WebView never opens on a refused
     * port. Any HTTP status counts as listening — but a 503 is worth shouting
     * about in the log: it means Node booted and ffmpeg did NOT spawn (the M0
     * go/no-go signal — see /api/health in apps/server/src/index.ts).
     */
    fun waitForServer(timeoutMs: Long = 20_000, onReady: (healthy: Boolean) -> Unit) {
        Thread({
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                try {
                    val conn = URL("$origin/api/health").openConnection() as HttpURLConnection
                    conn.connectTimeout = 1_000
                    conn.readTimeout = 1_000
                    val code = conn.responseCode
                    if (code == 503) {
                        val body = conn.errorStream?.bufferedReader()?.use { it.readText() }
                        Log.e(TAG, "health 503 — server up but ffmpeg unusable: $body")
                    }
                    conn.disconnect()
                    onReady(code == 200)
                    return@Thread
                } catch (_: Exception) {
                    Thread.sleep(250)
                }
            }
            Log.e(TAG, "server did not answer within ${timeoutMs}ms")
            onReady(false)
        }, "health-poll").start()
    }
}
