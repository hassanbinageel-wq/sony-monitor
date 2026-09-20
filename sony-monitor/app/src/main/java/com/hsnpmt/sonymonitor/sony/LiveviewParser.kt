package com.hsnpmt.sonymonitor.sony

import android.util.Log
import java.io.DataInputStream
import java.io.InputStream

/**
 * محلّل دفق liveview الخاص بـ Sony (Camera Remote API — "Liveview streaming").
 *
 * تنسيق كل حزمة:
 *   Common Header (8 بايت):
 *     [0]      = 0xFF (بايت البداية)
 *     [1]      = نوع الحمولة: 0x01 = صورة JPEG للبث الحي، 0x02 = معلومات إطار التركيز
 *     [2..3]   = رقم تسلسلي (uint16 BE)
 *     [4..7]   = ختم زمني بالميلي ثانية من ساعة الكاميرا (uint32 BE)
 *   Payload Header (128 بايت):
 *     [0..3]   = رمز البداية 0x24 0x35 0x68 0x79
 *     [4..6]   = حجم بيانات الحمولة (3 بايت BE)
 *     [7]      = حجم الحشو (padding)
 *     [8..127] = محجوز
 *   ثم بيانات الحمولة (JPEG) يتبعها بايتات الحشو.
 *
 * ملاحظة صدق حول التأخير: الختم الزمني مرجعه ساعة الكاميرا وليس ساعة الهاتف،
 * لذا لا يصلح لقياس تأخير "الزجاج إلى الزجاج". نستعمله فقط لترتيب/كشف الإطارات،
 * ونقيس معدّل الإطارات (FPS) من وقت وصولها إلى الهاتف.
 */
class LiveviewParser(
    private val onJpegFrame: (jpeg: ByteArray, sequence: Int, cameraTsMs: Long) -> Unit
) {
    @Volatile private var running = false

    fun stop() { running = false }

    /** يقرأ الدفق حتى التوقّف أو نهايته. يُنفّذ على خيط خلفي. */
    fun parse(input: InputStream) {
        running = true
        val din = DataInputStream(input)
        val common = ByteArray(8)
        val payload = ByteArray(128)
        try {
            while (running) {
                // مزامنة على بايت البداية 0xFF
                if (!syncToStart(din)) break
                // قرأنا 0xFF بالفعل داخل syncToStart؛ نكمل بقية Common Header (7 بايت)
                readFully(din, common, 1, 7)
                common[0] = 0xFF.toByte()

                val payloadType = common[1].toInt() and 0xFF
                val sequence = ((common[2].toInt() and 0xFF) shl 8) or (common[3].toInt() and 0xFF)
                val ts = ((common[4].toLong() and 0xFF) shl 24) or
                        ((common[5].toLong() and 0xFF) shl 16) or
                        ((common[6].toLong() and 0xFF) shl 8) or
                        (common[7].toLong() and 0xFF)

                readFully(din, payload, 0, 128)
                // تحقّق من رمز بداية Payload Header
                if (payload[0].toInt() and 0xFF != 0x24 ||
                    payload[1].toInt() and 0xFF != 0x35 ||
                    payload[2].toInt() and 0xFF != 0x68 ||
                    payload[3].toInt() and 0xFF != 0x79
                ) {
                    Log.w(TAG, "رمز بداية غير صالح — إعادة مزامنة")
                    continue
                }

                val dataSize = ((payload[4].toInt() and 0xFF) shl 16) or
                        ((payload[5].toInt() and 0xFF) shl 8) or
                        (payload[6].toInt() and 0xFF)
                val paddingSize = payload[7].toInt() and 0xFF

                if (dataSize <= 0 || dataSize > MAX_FRAME) {
                    Log.w(TAG, "حجم حمولة غير منطقي: $dataSize — تخطّي")
                    continue
                }

                val data = ByteArray(dataSize)
                readFully(din, data, 0, dataSize)
                if (paddingSize > 0) skipFully(din, paddingSize)

                if (payloadType == 0x01) {
                    onJpegFrame(data, sequence, ts)
                }
                // payloadType 0x02 (إطارات التركيز) نتجاهله في هذا الأساس
            }
        } catch (e: Exception) {
            if (running) Log.w(TAG, "توقّف دفق البث: ${e.message}")
        } finally {
            running = false
        }
    }

    private fun syncToStart(din: DataInputStream): Boolean {
        var guard = 0
        while (running) {
            val b = din.read()
            if (b < 0) return false
            if (b == 0xFF) return true
            if (++guard > MAX_SYNC_SCAN) {
                Log.w(TAG, "فشل المزامنة بعد فحص طويل")
                return false
            }
        }
        return false
    }

    private fun readFully(din: DataInputStream, buf: ByteArray, off: Int, len: Int) {
        var read = 0
        while (read < len) {
            val n = din.read(buf, off + read, len - read)
            if (n < 0) throw java.io.EOFException("نهاية الدفق")
            read += n
        }
    }

    private fun skipFully(din: DataInputStream, len: Int) {
        var remaining = len.toLong()
        while (remaining > 0) {
            val skipped = din.skip(remaining)
            if (skipped <= 0) {
                if (din.read() < 0) throw java.io.EOFException("نهاية الدفق أثناء الحشو")
                remaining -= 1
            } else remaining -= skipped
        }
    }

    companion object {
        private const val TAG = "LiveviewParser"
        private const val MAX_FRAME = 8 * 1024 * 1024
        private const val MAX_SYNC_SCAN = 1 * 1024 * 1024
    }
}
