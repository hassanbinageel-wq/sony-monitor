package com.hsnpmt.sonymonitor

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.hsnpmt.sonymonitor.sony.CameraController
import org.json.JSONObject

/**
 * جسر بين واجهة الويب (JavaScript) والطبقة الأصلية (Kotlin).
 *
 * كل الدوال الموسومة بـ @JavascriptInterface يمكن استدعاؤها من الويب عبر
 * window.SonyBridge.*(). والأحداث/الإطارات القادمة من الكاميرا تُدفع إلى الويب
 * عبر window.__sonyEvent(...) و window.__sonyFrame(...).
 */
class SonyBridge(
    private val context: Context,
    private val webView: WebView,
    private val onKeepScreenOn: (Boolean) -> Unit
) : CameraController.Callback {

    private val main = Handler(Looper.getMainLooper())
    private val controller = CameraController(context, this)

    // -------- أوامر من الويب إلى الأصل --------

    @JavascriptInterface fun connect() = controller.connect()
    @JavascriptInterface fun disconnect() = controller.disconnect()
    @JavascriptInterface fun startLiveview() = controller.startLiveview()
    @JavascriptInterface fun stopLiveview() = controller.stopLiveview()
    @JavascriptInterface fun takePicture() = controller.takePicture()
    @JavascriptInterface fun startMovieRec() = controller.startMovieRec()
    @JavascriptInterface fun stopMovieRec() = controller.stopMovieRec()
    @JavascriptInterface fun setSetting(kind: String, value: String) = controller.setSetting(kind, value)
    @JavascriptInterface fun refreshStatus() = controller.refreshStatus()

    @JavascriptInterface fun keepScreenOn(on: Boolean) { main.post { onKeepScreenOn(on) } }

    /** حالة الهاتف: البطارية والمساحة المتاحة — لعرضها في المونيتور. */
    @JavascriptInterface fun getPhoneStatus(): String {
        val out = JSONObject()
        try {
            val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            out.put("batteryPct", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
            val status = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val plugged = status?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
            out.put("charging", plugged != 0)
        } catch (_: Exception) {}
        try {
            val stat = StatFs(context.filesDir.absolutePath)
            out.put("freeBytes", stat.availableBytes)
            out.put("totalBytes", stat.totalBytes)
        } catch (_: Exception) {}
        return out.toString()
    }

    fun release() = controller.release()

    // -------- أحداث/إطارات من الأصل إلى الويب --------

    override fun onEvent(type: String, json: JSONObject) {
        val payload = json.toString()
        // نمرّر النص كوسيط JSON آمن عبر ترميزه كسلسلة
        val js = "window.__sonyEvent && window.__sonyEvent(${jsString(type)}, ${jsString(payload)});"
        main.post { webView.evaluateJavascript(js, null) }
    }

    override fun onFrame(jpeg: ByteArray, sequence: Int, cameraTsMs: Long) {
        val b64 = Base64.encodeToString(jpeg, Base64.NO_WRAP)
        val arrival = System.currentTimeMillis()
        val js = "window.__sonyFrame && window.__sonyFrame(${jsString(b64)}, $sequence, $cameraTsMs, $arrival);"
        main.post { webView.evaluateJavascript(js, null) }
    }

    /** ترميز سلسلة كـ JSON literal آمن للحقن في JS. */
    private fun jsString(s: String): String {
        val sb = StringBuilder(s.length + 2)
        sb.append('"')
        for (c in s) {
            when (c) {
                '\\' -> sb.append("\\\\")
                '"' -> sb.append("\\\"")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                ' ' -> sb.append("\\u2028")
                ' ' -> sb.append("\\u2029")
                else -> if (c < ' ') sb.append("\\u%04x".format(c.code)) else sb.append(c)
            }
        }
        sb.append('"')
        return sb.toString()
    }
}
