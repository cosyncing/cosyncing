package com.cosyncing.client

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.android.FlutterActivity
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.security.MessageDigest

class MainActivity : FlutterActivity() {
    private val updateChannel = "com.cosyncing.client/android_update"
    private val notificationsChannel = "com.cosyncing.client/notifications"
    private val installAction = "com.cosyncing.client.APK_INSTALL_RESULT"
    private val backgroundConnectionChannel = "com.cosyncing.client/background_connection"
    private var installReceiver: BroadcastReceiver? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        val reattaching = RetainedEngine.engine != null
        super.onCreate(savedInstanceState)
        if (reattaching && savedInstanceState == null) forwardNotificationTap()
    }

    /**
     * Attaches a new activity to the app that kept running in the background
     * rather than starting a second one beside it.
     */
    override fun provideFlutterEngine(context: Context): FlutterEngine? = RetainedEngine.engine

    /** The engine outlives this activity while the background connection runs. */
    override fun shouldDestroyEngineWithHost(): Boolean = !BackgroundConnectionService.isRunning

    /**
     * A notification tapped after this activity was closed starts a new one.
     * The notification plugin reads a launch tap only when the app starts, and
     * the retained app started long ago, so hand it the tap as it would get
     * one while the activity was open.
     */
    private fun forwardNotificationTap() {
        val launch = intent ?: return
        if (launch.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        if (launch.action != "SELECT_NOTIFICATION" && launch.action != "SELECT_FOREGROUND_NOTIFICATION") return
        flutterEngine?.activityControlSurface?.onNewIntent(launch)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        RetainedEngine.hold(flutterEngine)
        // Bound to the application, not this activity: the app can switch the
        // connection off while no activity is open.
        val application = applicationContext
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, backgroundConnectionChannel)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "start" -> result.success(
                        BackgroundConnectionService.start(
                            application,
                            channelName = call.argument<String>("channelName") ?: "",
                            groupName = call.argument<String>("groupName") ?: "",
                            title = call.argument<String>("title") ?: "",
                            text = call.argument<String>("text") ?: "",
                        ),
                    )
                    "stop" -> {
                        BackgroundConnectionService.stop(application)
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, updateChannel)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "installedIdentity" -> installedIdentity(result)
                    "installApk" -> installApk(call, result)
                    else -> result.notImplemented()
                }
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, notificationsChannel)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "openSettings" -> openNotificationSettings(call, result)
                    else -> result.notImplemented()
                }
            }
    }

    /**
     * Opens this app's notification page, or one channel's page when a channel
     * id is given. Each notification type is a channel, so this is where the
     * user changes its sound, pop-up, and lock-screen behavior.
     */
    private fun openNotificationSettings(call: MethodCall, result: MethodChannel.Result) {
        val channelId = call.argument<String>("channelId")
        val intent = when {
            channelId != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ->
                Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                    .putExtra(Settings.EXTRA_CHANNEL_ID, channelId)
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ->
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            else ->
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
        }
        try {
            startActivity(intent)
            result.success(true)
        } catch (_: Exception) {
            result.success(false)
        }
    }

    /**
     * Drops the handlers that hold this activity. The engine may outlive it,
     * and the next activity registers its own.
     */
    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, updateChannel)
            .setMethodCallHandler(null)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, notificationsChannel)
            .setMethodCallHandler(null)
        super.cleanUpFlutterEngine(flutterEngine)
    }

    override fun onDestroy() {
        clearInstallReceiver()
        super.onDestroy()
    }

    private fun installedIdentity(result: MethodChannel.Result) {
        try {
            val info = packageInfo(packageName, 0)
            result.success(
                mapOf(
                    "applicationId" to info.packageName,
                    "versionCode" to longVersionCode(info),
                    "signerSha256" to signerSha256(info),
                ),
            )
        } catch (error: Exception) {
            result.error("installed-identity-failed", error.message, null)
        }
    }

    private fun installApk(call: MethodCall, result: MethodChannel.Result) {
        val path = call.argument<String>("path")
        val expectedApplicationId = call.argument<String>("applicationId")
        val expectedVersion = call.argument<String>("version")
        val expectedVersionCode = call.argument<Number>("versionCode")?.toLong()
        val expectedSigner = call.argument<String>("signerSha256")
        if (
            path == null || expectedApplicationId == null || expectedVersion == null ||
            expectedVersionCode == null || expectedSigner == null
        ) {
            result.error("apk-arguments-invalid", "APK installation arguments are incomplete", null)
            return
        }
        try {
            val apk = File(path)
            if (!apk.isFile) throw IllegalArgumentException("Downloaded APK is missing")
            val archive = archiveInfo(apk)
                ?: throw IllegalArgumentException("Downloaded APK cannot be parsed")
            if (archive.packageName != expectedApplicationId || expectedApplicationId != packageName) {
                throw SecurityException("Downloaded APK package identity does not match")
            }
            if (longVersionCode(archive) != expectedVersionCode) {
                throw SecurityException("Downloaded APK versionCode does not match")
            }
            if (archive.versionName != expectedVersion) {
                throw SecurityException("Downloaded APK versionName does not match")
            }
            if (signerSha256(archive) != expectedSigner.lowercase()) {
                throw SecurityException("Downloaded APK signer does not match")
            }
            if (expectedVersionCode <= longVersionCode(packageInfo(packageName, 0))) {
                throw IllegalArgumentException("Downloaded APK is not newer")
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
                startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:$packageName"),
                    ),
                )
                result.success("permission-required")
                return
            }
            commitInstallSession(apk, expectedApplicationId, result)
        } catch (error: Exception) {
            result.error("apk-install-failed", error.message, null)
        }
    }

    private fun commitInstallSession(
        apk: File,
        expectedApplicationId: String,
        result: MethodChannel.Result,
    ) {
        clearInstallReceiver()
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val status = intent.getIntExtra(
                    PackageInstaller.EXTRA_STATUS,
                    PackageInstaller.STATUS_FAILURE,
                )
                when (status) {
                    PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                        val confirmation = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                        } else {
                            @Suppress("DEPRECATION")
                            intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                        }
                        if (confirmation == null) {
                            result.error("installer-confirmation-missing", "Android supplied no confirmation activity", null)
                        } else {
                            try {
                                confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                startActivity(confirmation)
                                result.success("launched")
                            } catch (error: Exception) {
                                result.error("installer-confirmation-failed", error.message, null)
                            }
                        }
                        clearInstallReceiver()
                    }
                    PackageInstaller.STATUS_SUCCESS -> {
                        result.success("launched")
                        clearInstallReceiver()
                    }
                    else -> {
                        result.error(
                            "installer-rejected",
                            intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                                ?: "Android rejected the APK installation",
                            status,
                        )
                        clearInstallReceiver()
                    }
                }
            }
        }
        installReceiver = receiver
        val filter = IntentFilter(installAction)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(receiver, filter)
        }

        val installer = packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            .apply {
                setAppPackageName(expectedApplicationId)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
                }
            }
        var sessionId: Int? = null
        try {
            val createdSessionId = installer.createSession(params)
            sessionId = createdSessionId
            installer.openSession(createdSessionId).use { session ->
                apk.inputStream().use { input ->
                    session.openWrite("cosyncing-update.apk", 0, apk.length()).use { output ->
                        input.copyTo(output)
                        session.fsync(output)
                    }
                }
                val callback = PendingIntent.getBroadcast(
                    this,
                    createdSessionId,
                    Intent(installAction).setPackage(packageName),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
                )
                session.commit(callback.intentSender)
            }
        } catch (error: Exception) {
            sessionId?.let(installer::abandonSession)
            clearInstallReceiver()
            throw error
        }
    }

    private fun clearInstallReceiver() {
        installReceiver?.let {
            try {
                unregisterReceiver(it)
            } catch (_: IllegalArgumentException) {
                // Already unregistered during activity teardown.
            }
        }
        installReceiver = null
    }

    private fun archiveInfo(apk: File): PackageInfo? {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            @Suppress("DEPRECATION")
            PackageManager.GET_SIGNATURES
        }
        return packageManager.getPackageArchiveInfo(apk.absolutePath, flags)
    }

    private fun packageInfo(name: String, extraFlags: Int): PackageInfo {
        val signerFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            @Suppress("DEPRECATION")
            PackageManager.GET_SIGNATURES
        }
        @Suppress("DEPRECATION")
        return packageManager.getPackageInfo(name, signerFlags or extraFlags)
    }

    private fun longVersionCode(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else {
            @Suppress("DEPRECATION")
            info.versionCode.toLong()
        }

    private fun signerSha256(info: PackageInfo): String {
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners
        } else {
            @Suppress("DEPRECATION")
            info.signatures
        } ?: throw SecurityException("APK has no signing certificate")
        if (signatures.size != 1) throw SecurityException("APK signer set is ambiguous")
        return MessageDigest.getInstance("SHA-256")
            .digest(signatures.single().toByteArray())
            .joinToString("") { byte -> "%02x".format(byte) }
    }
}
