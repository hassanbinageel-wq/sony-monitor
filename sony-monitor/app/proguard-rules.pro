# قواعد ProGuard — الأساس لا يفعّل التصغير، هذه احتياطية للنشر لاحقًا
-keep class com.hsnpmt.sonymonitor.** { *; }
-keepclassmembers class com.hsnpmt.sonymonitor.SonyBridge { public *; }
-dontwarn okhttp3.**
-dontwarn okio.**
