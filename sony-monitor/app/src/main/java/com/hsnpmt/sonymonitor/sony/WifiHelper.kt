package com.hsnpmt.sonymonitor.sony

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Log

/**
 * يربط عملية التطبيق بشبكة Wi‑Fi (شبكة الكاميرا) حتى تذهب طلبات HTTP إليها
 * وليس إلى بيانات الجوال. المستخدم يوصّل الهاتف يدويًا بشبكة الكاميرا من إعدادات
 * Android (أو عبر QR)، ثم يربط التطبيق العملية بتلك الشبكة.
 *
 * سبب الصدق: على Android 10+ قد يوجّه النظام المقابس عبر بيانات الجوال عندما لا
 * توفّر شبكة الكاميرا إنترنت. bindProcessToNetwork يحلّ ذلك.
 */
class WifiHelper(context: Context) {

    private val cm = context.applicationContext
        .getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    @Volatile private var boundNetwork: Network? = null

    /** يربط العملية بأول شبكة Wi‑Fi متاحة. يعيد الشبكة المربوطة أو null. */
    fun bindToWifi(): Network? {
        val wifi = findWifiNetwork()
        if (wifi == null) {
            Log.w(TAG, "لا توجد شبكة Wi‑Fi نشطة لربطها")
            return null
        }
        val ok = cm.bindProcessToNetwork(wifi)
        boundNetwork = if (ok) wifi else null
        Log.i(TAG, "ربط العملية بشبكة Wi‑Fi = $ok")
        return boundNetwork
    }

    fun unbind() {
        cm.bindProcessToNetwork(null)
        boundNetwork = null
    }

    fun boundNetworkOrNull(): Network? = boundNetwork

    /** هل توجد شبكة Wi‑Fi متصلة أصلًا؟ */
    fun isWifiConnected(): Boolean = findWifiNetwork() != null

    private fun findWifiNetwork(): Network? {
        return cm.allNetworks.firstOrNull { net ->
            val caps = cm.getNetworkCapabilities(net)
            caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
        }
    }

    companion object { private const val TAG = "WifiHelper" }
}
