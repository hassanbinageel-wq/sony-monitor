package com.hsnpmt.sonymonitor.sony

import android.util.Log
import java.io.ByteArrayInputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketTimeoutException
import javax.xml.parsers.DocumentBuilderFactory

/**
 * اكتشاف كاميرا Sony على الشبكة عبر SSDP (بروتوكول Camera Remote API / ScalarWebAPI).
 *
 * الخطوات:
 *  1) إرسال رسالة M-SEARCH عبر UDP multicast للبحث عن خدمة urn:schemas-sony-com:service:ScalarWebAPI:1
 *  2) قراءة ردّ الكاميرا واستخراج ترويسة LOCATION (رابط ملف وصف الجهاز DD.xml)
 *  3) تنزيل DD.xml وتحليله لاستخراج نقطة نهاية خدمة "camera" (ActionList URL)
 *
 * مرجع البروتوكول: Sony Camera Remote API — "Device Discovery".
 * ملاحظة صدق: الاتصال يفترض أن الهاتف متصل مسبقًا بشبكة Wi‑Fi الخاصة بالكاميرا (وضع نقطة الوصول)،
 * وأن العملية مربوطة بتلك الشبكة (انظر WifiHelper).
 */
object SsdpDiscovery {

    private const val TAG = "SsdpDiscovery"
    private const val SSDP_ADDR = "239.255.255.250"
    private const val SSDP_PORT = 1900
    private const val ST = "urn:schemas-sony-com:service:ScalarWebAPI:1"

    data class Result(
        val baseUrl: String,             // مثال: http://192.168.122.1:8080/sony
        val cameraEndpointUrl: String,   // مثال: http://192.168.122.1:8080/sony/camera
        val avContentEndpointUrl: String?, // نقطة نهاية استعراض الملفات إن وُجدت الخدمة
        val friendlyName: String,        // اسم الكاميرا من DD.xml إن توفّر
        val modelName: String,           // مثال: ILCE-7M3
        val availableServices: List<String>, // camera / system / avContent ...
        val locationUrl: String
    )

    /**
     * يبحث عن الكاميرا. يعيد null إذا لم يُعثر على شيء خلال المهلة.
     * timeoutMs: مهلة الاستماع الكلّية.
     */
    fun discover(timeoutMs: Int = 4000): Result? {
        val request = buildString {
            append("M-SEARCH * HTTP/1.1\r\n")
            append("HOST: $SSDP_ADDR:$SSDP_PORT\r\n")
            append("MAN: \"ssdp:discover\"\r\n")
            append("MX: 1\r\n")
            append("ST: $ST\r\n")
            append("\r\n")
        }.toByteArray(Charsets.UTF_8)

        var socket: DatagramSocket? = null
        try {
            socket = DatagramSocket()
            socket.reuseAddress = true
            socket.broadcast = true
            socket.soTimeout = 900

            val group = InetAddress.getByName(SSDP_ADDR)
            val packet = DatagramPacket(request, request.size, InetSocketAddress(group, SSDP_PORT))

            val deadline = System.currentTimeMillis() + timeoutMs
            // نُعيد إرسال M-SEARCH عدّة مرات لأن UDP غير موثوق
            var lastSend = 0L
            val buf = ByteArray(2048)

            while (System.currentTimeMillis() < deadline) {
                val now = System.currentTimeMillis()
                if (now - lastSend > 800) {
                    try { socket.send(packet) } catch (e: Exception) { Log.w(TAG, "send failed: ${e.message}") }
                    lastSend = now
                }
                try {
                    val resp = DatagramPacket(buf, buf.size)
                    socket.receive(resp)
                    val text = String(resp.data, 0, resp.length, Charsets.UTF_8)
                    val location = parseHeader(text, "LOCATION")
                    if (location != null && text.contains("ScalarWebAPI", ignoreCase = true)) {
                        Log.i(TAG, "SSDP LOCATION = $location")
                        val parsed = fetchAndParseDeviceDescription(location)
                        if (parsed != null) return parsed
                    }
                } catch (_: SocketTimeoutException) {
                    // نعاود المحاولة حتى انتهاء المهلة
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "discover error: ${e.message}", e)
        } finally {
            socket?.close()
        }
        return null
    }

    private fun parseHeader(response: String, name: String): String? {
        response.split("\r\n").forEach { line ->
            val idx = line.indexOf(':')
            if (idx > 0) {
                val key = line.substring(0, idx).trim()
                if (key.equals(name, ignoreCase = true)) {
                    return line.substring(idx + 1).trim()
                }
            }
        }
        return null
    }

    /** تنزيل DD.xml وتحليله. عام لإتاحة إعادة الاستخدام والاختبار. */
    fun fetchAndParseDeviceDescription(locationUrl: String): Result? {
        return try {
            val conn = (java.net.URL(locationUrl).openConnection() as java.net.HttpURLConnection).apply {
                connectTimeout = 3000
                readTimeout = 3000
                requestMethod = "GET"
            }
            val xml = conn.inputStream.use { it.readBytes() }
            parseDeviceDescriptionXml(xml, locationUrl)
        } catch (e: Exception) {
            Log.e(TAG, "DD.xml fetch failed: ${e.message}")
            null
        }
    }

    /**
     * تحليل ملف وصف الجهاز. نبحث عن عناصر Sony المخصّصة داخل مساحة الأسماء
     * urn:schemas-sony-com:av — تحديدًا X_ScalarWebAPI_Service و X_ScalarWebAPI_ActionList_URL.
     */
    fun parseDeviceDescriptionXml(xml: ByteArray, locationUrl: String): Result? {
        return try {
            // ملف Sony يستخدم بادئة مساحة أسماء av: (مثل <av:X_ScalarWebAPI_Service>)،
            // لذا نطابق بالاسم المحلّي (ما بعد ':') لنكون مستقلّين عن البادئة.
            val factory = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = false }
            val doc = factory.newDocumentBuilder().parse(ByteArrayInputStream(xml))

            val friendly = firstLocal(doc, "friendlyName") ?: "Sony Camera"
            val model = firstLocal(doc, "X_ScalarWebAPI_ModelName")
                ?: firstLocal(doc, "modelName")
                ?: "Unknown"

            // كل خدمة لها نوع (camera/system/avContent) ورابط ActionList
            val services = elementsByLocal(doc, "X_ScalarWebAPI_Service")
            var cameraActionUrl: String? = null
            val serviceTypes = ArrayList<String>()
            for (node in services) {
                var type: String? = null
                var url: String? = null
                val children = node.childNodes
                for (j in 0 until children.length) {
                    val c = children.item(j)
                    when (localName(c.nodeName)) {
                        "X_ScalarWebAPI_ServiceType" -> type = c.textContent?.trim()
                        "X_ScalarWebAPI_ActionList_URL" -> url = c.textContent?.trim()
                    }
                }
                if (type != null) {
                    serviceTypes.add(type)
                    if (type == "camera" && url != null) cameraActionUrl = url
                }
            }

            if (cameraActionUrl == null) {
                Log.e(TAG, "لم يُعثر على خدمة camera في DD.xml")
                return null
            }
            // نقطة نهاية خدمة الكاميرا = ActionList URL + "/camera"
            val base = cameraActionUrl.trimEnd('/')
            val endpoint = "$base/camera"
            val avContent = if (serviceTypes.contains("avContent")) "$base/avContent" else null
            Result(
                baseUrl = base,
                cameraEndpointUrl = endpoint,
                avContentEndpointUrl = avContent,
                friendlyName = friendly,
                modelName = model,
                availableServices = serviceTypes,
                locationUrl = locationUrl
            )
        } catch (e: Exception) {
            Log.e(TAG, "DD.xml parse failed: ${e.message}", e)
            null
        }
    }

    private fun localName(nodeName: String): String {
        val idx = nodeName.indexOf(':')
        return if (idx >= 0) nodeName.substring(idx + 1) else nodeName
    }

    /** كل العناصر التي يطابق اسمها المحلّي القيمة المطلوبة (مستقل عن بادئة مساحة الأسماء). */
    private fun elementsByLocal(doc: org.w3c.dom.Document, local: String): List<org.w3c.dom.Node> {
        val all = doc.getElementsByTagName("*")
        val out = ArrayList<org.w3c.dom.Node>()
        for (i in 0 until all.length) {
            val n = all.item(i)
            if (localName(n.nodeName) == local) out.add(n)
        }
        return out
    }

    private fun firstLocal(doc: org.w3c.dom.Document, local: String): String? {
        val list = elementsByLocal(doc, local)
        return if (list.isNotEmpty()) list[0].textContent?.trim() else null
    }
}
