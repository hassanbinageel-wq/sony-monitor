package com.hsnpmt.sonymonitor.sony

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * منسّق دورة حياة الاتصال بالكاميرا: اكتشاف → تجهيز → اكتشاف الإمكانات →
 * بثّ حي → استطلاع الحالة → التقاط/تحكم → إعادة اتصال.
 *
 * مبدأ الصدق: لا نُفعّل أي وظيفة في الواجهة إلا إن ظهرت في getAvailableApiList
 * القادمة من الكاميرا. والحالات (ISO/شتر/فتحة/بطارية/تسجيل) تُقرأ من getEvent؛
 * ما لا تُرجعه الكاميرا يبقى "غير متاح" ولا نختلق قيمة.
 */
class CameraController(
    context: Context,
    private val callback: Callback
) {
    interface Callback {
        /** حدث عام يُمرّر إلى طبقة الويب (JSON نصّي). type مثل connected/disconnected/error/capabilities/camera-status/stream */
        fun onEvent(type: String, json: JSONObject)
        /** إطار JPEG خام من البث الحي. */
        fun onFrame(jpeg: ByteArray, sequence: Int, cameraTsMs: Long)
    }

    private val appContext = context.applicationContext
    private val wifi = WifiHelper(appContext)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // عملاء HTTP: واحد قصير للطلبات، وواحد بلا مهلة قراءة للبث المستمر
    private val apiClientHttp = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()
    private val streamHttp = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)   // بثّ مستمر
        .retryOnConnectionFailure(true)
        .build()

    @Volatile private var api: ScalarWebApiClient? = null
    @Volatile private var device: SsdpDiscovery.Result? = null
    @Volatile private var capabilities: Set<String> = emptySet()

    private var statusJob: Job? = null
    private var liveviewJob: Job? = null
    private var liveviewParser: LiveviewParser? = null
    @Volatile private var wantLiveview = false

    // -------- الاتصال --------

    fun connect() {
        scope.launch {
            try {
                emit("status", JSONObject().put("phase", "binding"))
                wifi.bindToWifi() // قد تكون null إن لم تتوفّر Wi‑Fi — الاكتشاف سيفشل عندها برسالة واضحة

                emit("status", JSONObject().put("phase", "discovering"))
                val dev = SsdpDiscovery.discover(timeoutMs = 5000)
                if (dev == null) {
                    emit("error", JSONObject()
                        .put("code", "no_camera")
                        .put("message", "لم يُعثر على كاميرا Sony. تأكّد أن الهاتف متصل بشبكة Wi‑Fi الخاصة بالكاميرا وأن وضع التحكّم بالهاتف مفعّل في الكاميرا."))
                    return@launch
                }
                device = dev
                val client = ScalarWebApiClient(apiClientHttp, dev.cameraEndpointUrl, dev.avContentEndpointUrl)
                api = client

                client.startRecMode()
                delay(300)

                capabilities = try { client.getAvailableApiList() } catch (e: Exception) {
                    Log.w(TAG, "getAvailableApiList فشل: ${e.message}"); emptySet()
                }

                val caps = JSONObject()
                    .put("model", dev.modelName)
                    .put("friendlyName", dev.friendlyName)
                    .put("services", JSONArray(dev.availableServices))
                    .put("apiList", JSONArray(capabilities.toList()))
                    .put("hasLiveview", capabilities.contains("startLiveview"))
                    .put("hasTakePicture", capabilities.contains("actTakePicture"))
                    .put("hasMovieRec", capabilities.contains("startMovieRec"))
                    .put("hasAvContent", dev.avContentEndpointUrl != null)
                    .put("canSetIso", capabilities.contains("setIsoSpeedRate"))
                    .put("canSetShutter", capabilities.contains("setShutterSpeed"))
                    .put("canSetFNumber", capabilities.contains("setFNumber"))
                    .put("canSetExposureComp", capabilities.contains("setExposureCompensation"))
                    .put("canSetWhiteBalance", capabilities.contains("setWhiteBalance"))
                emit("connected", caps)

                startStatusPolling()

                // إن طُلب البث قبل اكتمال الاتصال، ابدأه الآن
                if (wantLiveview) startLiveviewInternal()
            } catch (e: Exception) {
                emit("error", JSONObject().put("code", "connect_failed").put("message", e.message ?: "فشل الاتصال"))
            }
        }
    }

    fun disconnect() {
        wantLiveview = false
        stopLiveviewInternal()
        statusJob?.cancel(); statusJob = null
        scope.launch {
            try { api?.stopLiveview() } catch (_: Exception) {}
            wifi.unbind()
            emit("disconnected", JSONObject())
        }
    }

    // -------- البث الحي --------

    fun startLiveview() { wantLiveview = true; if (api != null) startLiveviewInternal() }
    fun stopLiveview() { wantLiveview = false; stopLiveviewInternal() }

    private fun startLiveviewInternal() {
        if (liveviewJob?.isActive == true) return
        liveviewJob = scope.launch {
            var attempt = 0
            while (isActive && wantLiveview) {
                try {
                    val client = api ?: break
                    emit("stream", JSONObject().put("state", "starting"))
                    // نفضّل الحجم الأكبر إن دعمته الكاميرا
                    val sizes = client.getAvailableLiveviewSize()
                    val url = if (sizes.contains("L")) client.startLiveviewWithSize("L") else client.startLiveview()
                    if (url.isBlank()) throw IllegalStateException("رابط بث فارغ")

                    emit("stream", JSONObject().put("state", "connected").put("url", url))
                    attempt = 0
                    streamLoop(url)
                    // إن رجعنا من streamLoop بلا استثناء وما زلنا نريد البث ⇒ انقطع
                    if (wantLiveview) emit("stream", JSONObject().put("state", "lost").put("reason", "انتهى الدفق"))
                } catch (e: Exception) {
                    if (!wantLiveview) break
                    emit("stream", JSONObject().put("state", "lost").put("reason", e.message ?: "خطأ في البث"))
                }
                if (!wantLiveview) break
                attempt++
                val backoff = (500L * attempt).coerceAtMost(4000L)
                emit("stream", JSONObject().put("state", "reconnecting").put("inMs", backoff).put("attempt", attempt))
                delay(backoff)
            }
        }
    }

    private fun streamLoop(url: String) {
        val req = Request.Builder().url(url).get().build()
        streamHttp.newCall(req).execute().use { resp ->
            val body = resp.body ?: throw IllegalStateException("لا جسم في رد البث")
            val parser = LiveviewParser { jpeg, seq, ts -> callback.onFrame(jpeg, seq, ts) }
            liveviewParser = parser
            body.byteStream().use { input -> parser.parse(input) }
        }
    }

    private fun stopLiveviewInternal() {
        liveviewParser?.stop()
        liveviewJob?.cancel(); liveviewJob = null
        scope.launch { try { api?.stopLiveview() } catch (_: Exception) {} }
    }

    // -------- التحكم --------

    fun takePicture() = guarded("actTakePicture", "التقاط الصور") {
        val urls = api!!.actTakePicture()
        emit("action", JSONObject().put("action", "takePicture").put("ok", true).put("postview", JSONArray(urls)))
    }

    fun startMovieRec() = guarded("startMovieRec", "تسجيل الفيديو") {
        api!!.startMovieRec()
        emit("action", JSONObject().put("action", "startMovieRec").put("ok", true))
    }

    fun stopMovieRec() = guarded("stopMovieRec", "إيقاف التسجيل") {
        api!!.stopMovieRec()
        emit("action", JSONObject().put("action", "stopMovieRec").put("ok", true))
    }

    fun setSetting(kind: String, value: String) = guarded(apiForKind(kind), "ضبط $kind") {
        val c = api!!
        when (kind) {
            "iso" -> c.setIso(value)
            "shutter" -> c.setShutterSpeed(value)
            "fnumber" -> c.setFNumber(value)
            "exposure" -> c.setExposureCompensation(value.toInt())
            "whitebalance" -> c.setWhiteBalance(value, false, 0)
            else -> throw IllegalArgumentException("إعداد غير معروف: $kind")
        }
        emit("action", JSONObject().put("action", "set").put("kind", kind).put("value", value).put("ok", true))
    }

    private fun apiForKind(kind: String) = when (kind) {
        "iso" -> "setIsoSpeedRate"
        "shutter" -> "setShutterSpeed"
        "fnumber" -> "setFNumber"
        "exposure" -> "setExposureCompensation"
        "whitebalance" -> "setWhiteBalance"
        else -> kind
    }

    /** ينفّذ الأمر فقط إن كانت الوظيفة مدعومة، ويبلّغ الفشل بصدق دون تغيير أي قيمة في الواجهة. */
    private fun guarded(requiredApi: String, label: String, block: () -> Unit) {
        scope.launch {
            if (api == null) {
                emit("action", JSONObject().put("ok", false).put("label", label).put("message", "غير متصل بالكاميرا"))
                return@launch
            }
            if (!capabilities.contains(requiredApi)) {
                emit("action", JSONObject().put("ok", false).put("label", label)
                    .put("message", "الكاميرا الحالية لا تدعم «$label» عبر هذا الاتصال (غير موجودة في قائمة الوظائف المتاحة)."))
                return@launch
            }
            try { block() } catch (e: Exception) {
                emit("action", JSONObject().put("ok", false).put("label", label).put("message", e.message ?: "فشل التنفيذ"))
            }
        }
    }

    // -------- استطلاع الحالة --------

    private fun startStatusPolling() {
        statusJob?.cancel()
        statusJob = scope.launch {
            var longPoll = false
            while (isActive) {
                try {
                    val c = api ?: break
                    val result = c.getEvent(longPoll)
                    longPoll = true
                    val parsed = StatusParser.parse(result)
                    emit("camera-status", parsed)
                } catch (e: Exception) {
                    // getEvent قد يعيد timeout مع الاستطلاع الطويل — طبيعي؛ نعيد المحاولة
                    longPoll = false
                    delay(700)
                }
            }
        }
    }

    fun refreshStatus() {
        scope.launch {
            try {
                val c = api ?: return@launch
                emit("camera-status", StatusParser.parse(c.getEvent(false)))
            } catch (_: Exception) {}
        }
    }

    // -------- مساعد --------

    private fun emit(type: String, json: JSONObject) = callback.onEvent(type, json)

    fun release() {
        try { scope.cancel() } catch (_: Exception) {}
        wifi.unbind()
    }

    companion object { private const val TAG = "CameraController" }
}
