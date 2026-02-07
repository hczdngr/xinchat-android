package com.xinchat.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class XinchatNotificationModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {

  companion object {
    private const val CHANNEL_ID = "xinchat_messages"
    private const val CHANNEL_NAME = "XinChat Messages"
    private const val CHANNEL_DESCRIPTION = "Chat message alerts"
  }

  override fun getName(): String = "XinchatNotification"

  override fun initialize() {
    super.initialize()
    ensureChannel()
  }

  @ReactMethod
  fun notifyIncomingMessage(chatUid: Double, title: String?, body: String?, targetType: String?) {
    val uid = chatUid.toInt()
    if (uid <= 0) return
    ensureChannel()

    val target = (targetType ?: "").trim().ifEmpty { "private" }
    val intent = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      putExtra("openChatUid", uid)
      putExtra("openChatTargetType", target)
    }
    val requestCode = notificationId(uid, target)
    val pendingIntent = PendingIntent.getActivity(
      context,
      requestCode,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle((title ?: "").ifBlank { "New message" })
      .setContentText((body ?: "").ifBlank { "You received a new message" })
      .setStyle(
        NotificationCompat.BigTextStyle().bigText((body ?: "").ifBlank { "You received a new message" })
      )
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setAutoCancel(true)
      .setOnlyAlertOnce(false)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setSound(sound)
      .setDefaults(NotificationCompat.DEFAULT_LIGHTS or NotificationCompat.DEFAULT_VIBRATE)
      .setContentIntent(pendingIntent)
      .build()

    try {
      NotificationManagerCompat.from(context).notify(requestCode, notification)
    } catch (_: SecurityException) {
    }
  }

  @ReactMethod
  fun cancelChatNotification(chatUid: Double) {
    val uid = chatUid.toInt()
    if (uid <= 0) return
    val manager = NotificationManagerCompat.from(context)
    manager.cancel(notificationId(uid, "private"))
    manager.cancel(notificationId(uid, "group"))
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      ?: return
    val existing = manager.getNotificationChannel(CHANNEL_ID)
    if (existing != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      CHANNEL_NAME,
      NotificationManager.IMPORTANCE_HIGH
    ).apply {
      description = CHANNEL_DESCRIPTION
      enableLights(true)
      enableVibration(true)
      setSound(
        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
        null
      )
    }
    manager.createNotificationChannel(channel)
  }

  private fun notificationId(uid: Int, targetType: String): Int {
    val base = "${targetType.trim().ifEmpty { "private" }}:$uid".hashCode()
    val positive = (base.toLong() and 0x7fffffffL) % 1000000000L
    return (positive + 1000L).toInt()
  }
}
