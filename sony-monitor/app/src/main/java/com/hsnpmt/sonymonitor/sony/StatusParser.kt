package com.hsnpmt.sonymonitor.sony

import org.json.JSONArray
import org.json.JSONObject

/**
 * يحوّل مصفوفة getEvent إلى كائن حالة مبسّط.
 *
 * نعتمد على حقل "type" داخل كل عنصر بدلًا من أرقام الفهارس الثابتة، لأن ترتيب
 * الفهارس يختلف بين إصدارات البروتوكول والموديلات. أي حقل لا تُرجعه الكاميرا
 * لا نضيفه إطلاقًا — فتعرضه الواجهة كـ«غير متاح» بدل قيمة مختلقة.
 */
object StatusParser {

    fun parse(event: JSONArray): JSONObject {
        val out = JSONObject()
        for (i in 0 until event.length()) {
            val item = event.opt(i) ?: continue
            when (item) {
                is JSONObject -> handleObject(item, out)
                is JSONArray -> {
                    // بعض الأنواع تأتي كمصفوفة كائنات (مثل storageInformation)
                    for (j in 0 until item.length()) {
                        (item.opt(j) as? JSONObject)?.let { handleObject(it, out) }
                    }
                }
            }
        }
        return out
    }

    private fun handleObject(o: JSONObject, out: JSONObject) {
        when (o.optString("type")) {
            "cameraStatus" -> {
                val s = o.optString("cameraStatus", "")
                if (s.isNotEmpty()) {
                    out.put("cameraStatus", s)
                    out.put("isRecordingMovie", s.equals("MovieRecording", true) || s.equals("MovieSaving", true))
                }
            }
            "isoSpeedRate" -> {
                putIfPresent(o, "currentIsoSpeedRate", out, "iso")
                putArrayIfPresent(o, "isoSpeedRateCandidates", out, "isoCandidates")
            }
            "shutterSpeed" -> {
                putIfPresent(o, "currentShutterSpeed", out, "shutter")
                putArrayIfPresent(o, "shutterSpeedCandidates", out, "shutterCandidates")
            }
            "fNumber" -> {
                putIfPresent(o, "currentFNumber", out, "fnumber")
                putArrayIfPresent(o, "fNumberCandidates", out, "fnumberCandidates")
            }
            "exposureCompensation" -> {
                if (o.has("currentExposureCompensation"))
                    out.put("exposureCompIndex", o.optInt("currentExposureCompensation"))
                if (o.has("stepIndexOfExposureCompensation"))
                    out.put("exposureCompStep", o.optInt("stepIndexOfExposureCompensation"))
                if (o.has("maxExposureCompensation"))
                    out.put("exposureCompMax", o.optInt("maxExposureCompensation"))
                if (o.has("minExposureCompensation"))
                    out.put("exposureCompMin", o.optInt("minExposureCompensation"))
            }
            "whiteBalance" -> {
                putIfPresent(o, "currentWhiteBalanceMode", out, "whiteBalance")
            }
            "exposureMode" -> putIfPresent(o, "currentExposureMode", out, "exposureMode")
            "focusMode" -> putIfPresent(o, "currentFocusMode", out, "focusMode")
            "batteryInfo" -> {
                // متوفّر على بعض الموديلات فقط
                val arr = o.optJSONArray("batteryInfo")
                if (arr != null && arr.length() > 0) {
                    val b = arr.optJSONObject(0)
                    if (b != null) {
                        if (b.has("levelNumber")) out.put("cameraBatteryLevel", b.optInt("levelNumber"))
                        if (b.has("levelDenom")) out.put("cameraBatteryDenom", b.optInt("levelDenom"))
                        putIfPresent(b, "status", out, "cameraBatteryStatus")
                    }
                }
            }
            "storageInformation" -> {
                val arr = o.optJSONArray("storageInformation")
                if (arr != null && arr.length() > 0) {
                    val st = arr.optJSONObject(0)
                    if (st != null) {
                        if (st.has("numberOfRecordableImages"))
                            out.put("recordableImages", st.optInt("numberOfRecordableImages"))
                        if (st.has("recordableTime"))
                            out.put("recordableTimeMin", st.optInt("recordableTime"))
                        putIfPresent(st, "recordTarget", out, "recordTarget")
                        putIfPresent(st, "storageDescription", out, "storageDescription")
                    }
                }
            }
            "liveviewStatus" -> if (o.has("liveviewStatus")) out.put("liveviewStatus", o.optBoolean("liveviewStatus"))
        }
    }

    private fun putIfPresent(src: JSONObject, key: String, out: JSONObject, outKey: String) {
        if (src.has(key)) {
            val v = src.optString(key, "")
            if (v.isNotEmpty()) out.put(outKey, v)
        }
    }

    private fun putArrayIfPresent(src: JSONObject, key: String, out: JSONObject, outKey: String) {
        val arr = src.optJSONArray(key)
        if (arr != null && arr.length() > 0) out.put(outKey, arr)
    }
}
