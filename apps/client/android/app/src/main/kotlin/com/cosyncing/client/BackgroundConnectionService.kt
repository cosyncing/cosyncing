package com.cosyncing.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import io.flutter.embedding.engine.FlutterEngine

/**
 * Keeps the app's process, and so its Flutter engine and attention-feed
 * workers, alive after the user leaves the app. Android keeps a process with
 * a foreground service running; without one, a backgrounded app is frozen or
 * killed and notifications stop until it is opened again.
 *
 * The service only holds the process. The engine it keeps alive is the one the
 * activity created, handed over through [RetainedEngine] so a later activity
 * attaches to the same running app instead of starting a second one.
 */
class BackgroundConnectionService : Service() {
    companion object {
        private const val CHANNEL_ID = "cosy.v2.background"
        private const val GROUP_ID = "cosy.v2.server"

        // Attention notifications use non-negative ids, so a negative one
        // can never be replaced or cancelled by them.
        private const val NOTIFICATION_ID = -7734

        private const val EXTRA_CHANNEL_NAME = "channelName"
        private const val EXTRA_GROUP_NAME = "groupName"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_TEXT = "text"

        /** Whether the service is running, so the engine must outlive the activity. */
        @Volatile
        var isRunning = false
            private set

        /**
         * Starts the service, or updates its notification text. Returns false
         * when Android refuses, which it does while the app is in the
         * background.
         */
        fun start(
            context: Context,
            channelName: String,
            groupName: String,
            title: String,
            text: String,
        ): Boolean {
            val intent = Intent(context, BackgroundConnectionService::class.java)
                .putExtra(EXTRA_CHANNEL_NAME, channelName)
                .putExtra(EXTRA_GROUP_NAME, groupName)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_TEXT, text)
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
                true
            } catch (_: IllegalStateException) {
                // ForegroundServiceStartNotAllowedException and the older
                // background-start refusal are both IllegalStateExceptions.
                false
            } catch (_: SecurityException) {
                false
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, BackgroundConnectionService::class.java))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) {
            // Android restarted the service without the app: there is no
            // engine to keep, so a notification would claim a connection that
            // does not exist.
            stopSelf()
            return START_NOT_STICKY
        }
        val notification = buildNotification(
            channelName = intent.getStringExtra(EXTRA_CHANNEL_NAME) ?: "Background connection",
            groupName = intent.getStringExtra(EXTRA_GROUP_NAME) ?: "Server",
            title = intent.getStringExtra(EXTRA_TITLE) ?: "Cosyncing",
            text = intent.getStringExtra(EXTRA_TEXT) ?: "",
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        isRunning = true
        // Not sticky: if Android kills the process, the engine is gone with
        // it, and the next launch of the app starts the service again.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        super.onDestroy()
    }

    private fun buildNotification(
        channelName: String,
        groupName: String,
        title: String,
        text: String,
    ): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            packageManager.getLaunchIntentForPackage(packageName)
                ?: Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            // The app's own channel sync creates this group too, with the
            // same name; a channel cannot name a group that does not exist.
            manager.createNotificationChannelGroup(NotificationChannelGroup(GROUP_ID, groupName))
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, channelName, NotificationManager.IMPORTANCE_LOW)
                    .apply {
                        group = GROUP_ID
                        setShowBadge(false)
                        setSound(null, null)
                        enableVibration(false)
                    },
            )
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
        }
        builder
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentIntent(open)
            .setOngoing(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
        if (text.isNotEmpty()) builder.setContentText(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }
        return builder.build()
    }
}

/**
 * The running app's Flutter engine, kept across activities while
 * [BackgroundConnectionService] runs. Without it, closing the activity (Back
 * before Android 12, or swiping the app away) would destroy the engine and
 * every worker in it, and the next launch would start a fresh one.
 */
object RetainedEngine {
    @Volatile
    var engine: FlutterEngine? = null
        private set

    fun hold(flutterEngine: FlutterEngine) {
        if (engine === flutterEngine) return
        engine = flutterEngine
        flutterEngine.addEngineLifecycleListener(
            object : FlutterEngine.EngineLifecycleListener {
                override fun onPreEngineRestart() {}

                override fun onEngineWillDestroy() {
                    if (engine === flutterEngine) engine = null
                }
            },
        )
    }
}
