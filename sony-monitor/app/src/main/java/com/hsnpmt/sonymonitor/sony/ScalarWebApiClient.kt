package com.hsnpmt.sonymonitor.sony

import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

/**
 * عميل JSON-RPC لبروتوكول Sony ScalarWebAPI (Camera Remote API).
 *
 * كل استدعاء يرسل POST بجسم مثل:
 *   {"method":"startLiveview","params":[],"id":3,"version":"1.0"}
 * والرد إمّا {"result":[...],"id":3} أو {"error":[code,"message"],"id":3}
 *
 * هذا العميل لا يفترض أن أي وظيفة مدعومة — بل يوفّر getAvailableApiList()
 * لكي تكتشف الطبقة الأعلى ما تدعمه الكاميرا فعليًا قبل عرض أي زر على المستخدم.
 */
class ScalarWebApiClient(
    private val http: OkHttpClient,
    private val cameraEndpoint: String,
    private val avContentEndpoint: String? = null
) {
    private val idGen = AtomicInteger(1)
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    class ApiError(val code: Int, override val message: String) : Exception("Sony API error $code: $message")

    /** نتيجة استدعاء: مصفوفة result كما تعيدها الكاميرا. */
    fun call(
        method: String,
        params: JSONArray = JSONArray(),
        version: String = "1.0",
        endpoint: String = cameraEndpoint
    ): JSONArray {
        val id = idGen.getAndIncrement()
        val body = JSONObject()
            .put("method", method)
            .put("params", params)
            .put("id", id)
            .put("version", version)
            .toString()

        val req = Request.Builder()
            .url(endpoint)
            .post(body.toRequestBody(jsonType))
            .build()

        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: throw ApiError(-1, "رد فارغ من الكاميرا")
            val obj = JSONObject(text)
            if (obj.has("error")) {
                val err = obj.getJSONArray("error")
                val code = if (err.length() > 0) err.optInt(0, -1) else -1
                val msg = if (err.length() > 1) err.optString(1, "") else ""
                throw ApiError(code, msg)
            }
            return obj.optJSONArray("result") ?: JSONArray()
        }
    }

    fun callAv(method: String, params: JSONArray = JSONArray(), version: String = "1.0"): JSONArray {
        val ep = avContentEndpoint ?: throw ApiError(-2, "خدمة avContent غير متوفّرة على هذه الكاميرا")
        return call(method, params, version, ep)
    }

    // ---- استدعاءات شائعة ----

    /** يجب استدعاؤها على كثير من الكاميرات قبل بدء البث/الالتقاط. */
    fun startRecMode(): Boolean = try {
        call("startRecMode"); true
    } catch (e: ApiError) {
        // بعض الكاميرات لا تحتاجها أو تعيد خطأ "already" — لا نُفشل الاتصال بسببها
        Log.w(TAG, "startRecMode: ${e.message}")
        e.code == 1 // 1 غالبًا يعني already in rec mode
    }

    fun getApplicationInfo(): List<String> {
        val r = call("getApplicationInfo")
        val out = ArrayList<String>()
        for (i in 0 until r.length()) out.add(r.optString(i))
        return out
    }

    /** قائمة الوظائف المدعومة فعليًا الآن على الكاميرا — أساس التصنيف الصادق للإمكانات. */
    fun getAvailableApiList(): Set<String> {
        val r = call("getAvailableApiList")
        val set = LinkedHashSet<String>()
        if (r.length() > 0) {
            val arr = r.optJSONArray(0) ?: JSONArray()
            for (i in 0 until arr.length()) set.add(arr.optString(i))
        }
        return set
    }

    /** يبدأ البث الحي ويعيد رابط دفق liveview. */
    fun startLiveview(): String {
        val r = call("startLiveview")
        return r.optString(0)
    }

    /** بدء البث مع حجم إطار محدّد ("L" أو "M") إن دعمته الكاميرا. */
    fun startLiveviewWithSize(size: String): String {
        val r = call("startLiveviewWithSize", JSONArray().put(size))
        return r.optString(0)
    }

    fun getAvailableLiveviewSize(): List<String> {
        return try {
            val r = call("getSupportedLiveviewSize")
            val out = ArrayList<String>()
            if (r.length() > 0) {
                val a = r.optJSONArray(0) ?: JSONArray()
                for (i in 0 until a.length()) out.add(a.optString(i))
            }
            out
        } catch (e: ApiError) { emptyList() }
    }

    fun stopLiveview() { try { call("stopLiveview") } catch (e: ApiError) { Log.w(TAG, "stopLiveview ${e.message}") } }

    /** التقاط صورة. يعيد روابط صور المعاينة (postview). */
    fun actTakePicture(): List<String> {
        val r = call("actTakePicture")
        val out = ArrayList<String>()
        if (r.length() > 0) {
            val a = r.optJSONArray(0) ?: JSONArray()
            for (i in 0 until a.length()) out.add(a.optString(i))
        }
        return out
    }

    fun startMovieRec() { call("startMovieRec") }
    fun stopMovieRec() { call("stopMovieRec") }

    // ضبط الإعدادات — تُستدعى فقط إن كانت ضمن getAvailableApiList
    fun setIso(value: String) { call("setIsoSpeedRate", JSONArray().put(value)) }
    fun setShutterSpeed(value: String) { call("setShutterSpeed", JSONArray().put(value)) }
    fun setFNumber(value: String) { call("setFNumber", JSONArray().put(value)) }
    fun setExposureCompensation(indexValue: Int) { call("setExposureCompensation", JSONArray().put(indexValue)) }
    fun setWhiteBalance(mode: String, colorTempEnabled: Boolean, colorTemp: Int) {
        call("setWhiteBalance", JSONArray().put(mode).put(colorTempEnabled).put(colorTemp))
    }

    /**
     * getEvent: يعيد مصفوفة حالة كبيرة. نمرّرها كما هي للطبقة الأعلى لاستخراج
     * القيم المتاحة (ISO/شتر/فتحة/بطارية/حالة التسجيل...) بأمان.
     * longPolling=false للحصول على لقطة فورية.
     */
    fun getEvent(longPolling: Boolean): JSONArray {
        return call("getEvent", JSONArray().put(longPolling), version = "1.0")
    }

    companion object { private const val TAG = "ScalarWebApiClient" }
}
