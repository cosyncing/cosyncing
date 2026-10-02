package com.cosyncing.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock

/**
 * Keeps the app's process running while it downloads an update APK, and shows
 * the download's progress in a notification. Without a foreground service
 * Android freezes an app soon after the user leaves it, and the download,
 * which runs in the Flutter engine, stops with it.
 *
 * Like [BackgroundConnectionService], it only holds the process. Downloading
 * and verifying the APK stay in the app, and so does opening the installer:
 * Android starts an installer only for an app in front, so a download that
 * finishes out of sight leaves a notification that brings the user back.
 */
class UpdateDownloadService : Service() {
    /** The words the app supplies for a download that finished out of sight. */
    data class Ready(val channelName: String, val title: String, val text: String)

    companion object {
        private const val CHANNEL_ID = "cosy.v2.update"

        // Attention notifications use non-negative ids, and the background
        // connection uses -7734, so neither can replace these.
        private const val PROGRESS_ID = -7735
        private const val READY_ID = -7736

        // Android drops a burst of notification updates from one app, so a
        // fast download moves the bar at most twice a second.
        private const val PROGRESS_INTERVAL_MS = 500L

        private const val EXTRA_CHANNEL_NAME = "channelName"
        private const val EXTRA_TITLE = "title"

        /**
         * Whether a download wants the process held, from [start] until
         * [stop], so the engine must outlive the activity.
         */
        @Volatile
        var isActive = false
            private set

        /** Whether the service has reached the foreground. */
        @Volatile
        private var inForeground = false

        @Volatile
        private var title: String? = null

        @Volatile
        private var lastProgressAt = 0L

        /**
         * Starts the service for a download. Returns false when Android
         * refuses, which it does while the app is in the background.
         */
        fun start(context: Context, channelName: String, title: String): Boolean {
            cancelReady(context)
            isActive = true
            val intent = Intent(context, UpdateDownloadService::class.java)
                .putExtra(EXTRA_CHANNEL_NAME, channelName)
                .putExtra(EXTRA_TITLE, title)
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
                isActive = false
                false
            } catch (_: SecurityException) {
                isActive = false
                false
            }
        }

        /** Moves the notification's bar to [percent] while the service runs. */
        fun progress(context: Context, percent: Int) {
            val shownTitle = title ?: return
            if (!isActive || !inForeground) return
            val now = SystemClock.elapsedRealtime()
            if (percent < 100 && now - lastProgressAt < PROGRESS_INTERVAL_MS) return
            lastProgressAt = now
            context.getSystemService(NotificationManager::class.java)
                ?.notify(PROGRESS_ID, progressNotification(context, shownTitle, percent.coerceIn(0, 100)))
        }

        /**
         * Stops the service and its progress notification. With [ready], posts
         * a notification that opens the app to install; without it, clears one.
         */
        fun stop(context: Context, ready: Ready?) {
            isActive = false
            title = null
            // A service Android has not yet brought to the foreground must not
            // be stopped from here: stopping it before it calls startForeground
            // crashes the app. It stops itself as soon as it does.
            if (inForeground) {
                context.stopService(Intent(context, UpdateDownloadService::class.java))
            }
            if (ready == null) {
                cancelReady(context)
                return
            }
            ensureChannel(context, ready.channelName)
            val notification = builder(context)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(ready.title)
                .setContentText(ready.text)
                .setContentIntent(openApp(context))
                .setAutoCancel(true)
                .build()
            context.getSystemService(NotificationManager::class.java)?.notify(READY_ID, notification)
        }

        private fun cancelReady(context: Context) {
            context.getSystemService(NotificationManager::class.java)?.cancel(READY_ID)
        }

        private fun ensureChannel(context: Context, channelName: String) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL_ID, channelName, NotificationManager.IMPORTANCE_LOW)
                    .apply {
                        setShowBadge(false)
                        setSound(null, null)
                        enableVibration(false)
                    },
            )
        }

        private fun builder(context: Context): Notification.Builder =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context).setPriority(Notification.PRIORITY_LOW)
            }

        private fun openApp(context: Context): PendingIntent = PendingIntent.getActivity(
            context,
            0,
            context.packageManager.getLaunchIntentForPackage(context.packageName)
                ?: Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        /** [percent] below zero draws an indeterminate bar, before the first byte. */
        private fun progressNotification(context: Context, title: String, percent: Int): Notification {
            val builder = builder(context)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentIntent(openApp(context))
                .setProgress(100, percent.coerceAtLeast(0), percent < 0)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setCategory(Notification.CATEGORY_PROGRESS)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            }
            return builder.build()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) {
            // Android restarted the service without the app: no download is
            // running to show.
            stopSelf()
            return START_NOT_STICKY
        }
        val channelName = intent.getStringExtra(EXTRA_CHANNEL_NAME) ?: "App updates"
        val shownTitle = intent.getStringExtra(EXTRA_TITLE) ?: "Cosyncing"
        ensureChannel(this, channelName)
        val notification = progressNotification(this, shownTitle, -1)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(PROGRESS_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(PROGRESS_ID, notification)
        }
        inForeground = true
        if (!isActive) {
            // The download ended before Android started the service.
            stopSelf()
            return START_NOT_STICKY
        }
        title = shownTitle
        lastProgressAt = 0L
        // Not sticky: if Android kills the process, the download is gone with
        // it, and the next launch offers the update again.
        return START_NOT_STICKY
    }

    /**
     * Android 15 caps a data-sync service at six hours a day and stops the app
     * if one outlives its cap. No APK download needs that long.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        isActive = false
        title = null
        stopSelf()
    }

    override fun onDestroy() {
        inForeground = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}
