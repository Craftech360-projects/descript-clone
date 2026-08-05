package com.jumpcut.android

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView

/**
 * The Android shell — the analog of desktop/win/main.cjs, and nothing more.
 *
 * It starts the in-process Node server (NodeRuntime), shows a splash until
 * /api/health answers, then swaps in a WebView pointed at the local origin.
 * The server it runs is byte-for-byte the server that runs in dev, Docker and
 * the desktop apps — no product logic lives here.
 */
class MainActivity : Activity() {

    companion object {
        private const val TAG = "jumpcut-shell"
        private const val FILE_CHOOSER_REQUEST = 1

        // The runtime survives configuration changes and even Activity
        // recreation — Node can only start once per process, so it must never
        // be owned by anything shorter-lived than the process.
        private var runtime: NodeRuntime? = null
    }

    private lateinit var root: FrameLayout
    private lateinit var splash: TextView
    private var webView: WebView? = null
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        root = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#0e0e12")) }
        splash = TextView(this).apply {
            text = "Starting editor…"
            setTextColor(Color.parseColor("#8b8b94"))
            textSize = 16f
            gravity = Gravity.CENTER
        }
        root.addView(
            splash,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        setContentView(root)

        val rt = runtime ?: NodeRuntime(applicationContext).also {
            runtime = it
            it.onExit = { code -> runOnUiThread { serverDied(code) } }
            it.start()
        }

        rt.waitForServer { healthy ->
            runOnUiThread {
                if (healthy) openWebView(rt)
                else showFailure(
                    "The editor service did not start.\n\n" +
                        "Check `adb logcat -s jumpcut-node jumpcut-shell` — a 503 from " +
                        "/api/health means Node booted but ffmpeg could not run.",
                )
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun openWebView(rt: NodeRuntime) {
        val wv = WebView(this)
        webView = wv
        wv.setBackgroundColor(Color.parseColor("#0e0e12"))
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // The editor drives <video>.play() from code (transport, word
            // click); requiring a gesture would break every programmatic play.
            mediaPlaybackRequiresUserGesture = false
        }

        // Keep the app inside its own origin; anything else (music credits,
        // license links) belongs to the system browser.
        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == "127.0.0.1" || url.host == "localhost") return false
                startActivity(Intent(Intent.ACTION_VIEW, url))
                return true
            }
        }

        // <input type=file> — the import path. Without this the picker simply
        // never opens and import looks broken.
        wv.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                val intent = params.createIntent().apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                }
                return try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST)
                    true
                } catch (e: Exception) {
                    Log.e(TAG, "file chooser failed", e)
                    filePathCallback = null
                    false
                }
            }
        }

        // Primary save path is the injected bridge (download.ts prefers it);
        // this listener is the net under any anchor download the bridge does
        // not intercept.
        val bridge = DownloadBridge(applicationContext, rt.origin)
        wv.addJavascriptInterface(bridge, "JumpCutAndroid")
        wv.setDownloadListener { url, _, contentDisposition, _, _ ->
            val name = contentDisposition
                ?.let { Regex("filename=\"?([^\";]+)").find(it)?.groupValues?.get(1) }
                ?: url.substringAfterLast('/')
            bridge.saveUrl(url, name)
        }

        root.addView(
            wv,
            0,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        root.removeView(splash)
        wv.loadUrl(rt.origin)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            val uris = if (resultCode == RESULT_OK && data?.data != null) arrayOf(data.data!!) else null
            filePathCallback?.onReceiveValue(uris)
            filePathCallback = null
            return
        }
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    /**
     * The SPA owns navigation; going "back" through WebView history would step
     * through editor states meaninglessly. Background the app instead — the
     * server (and any running render) stays alive with the process.
     */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        moveTaskToBack(true)
    }

    /**
     * Node cannot be restarted in-process (libnode limitation), so a dead
     * server means a dead process: show what happened, then let the user
     * relaunch clean. Mirrors main.cjs's "Editor stopped" dialog + quit.
     */
    private fun serverDied(code: Int) {
        showFailure("The editor service stopped (code $code).\nClose and reopen the app.")
    }

    private fun showFailure(message: String) {
        webView?.let { root.removeView(it) }
        webView = null
        if (splash.parent == null) {
            root.addView(
                splash,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
        }
        splash.text = message
        splash.setOnClickListener {
            // Full process restart — the only way to get a fresh Node.
            val intent = packageManager.getLaunchIntentForPackage(packageName)
            intent?.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
            startActivity(intent)
            Process.killProcess(Process.myPid())
        }
    }
}
