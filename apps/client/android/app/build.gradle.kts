plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val releaseKeystorePath = System.getenv("COSYNCING_ANDROID_KEYSTORE_PATH")
val releaseKeyAlias = System.getenv("COSYNCING_ANDROID_KEY_ALIAS")
val releaseStorePassword = System.getenv("COSYNCING_ANDROID_KEYSTORE_PASSWORD")
val releaseKeyPassword = System.getenv("COSYNCING_ANDROID_KEY_PASSWORD")
val requireReleaseSigning =
    System.getenv("COSYNCING_REQUIRE_ANDROID_RELEASE_SIGNING") == "true"
val hasReleaseSigning = listOf(
    releaseKeystorePath,
    releaseKeyAlias,
    releaseStorePassword,
    releaseKeyPassword,
).all { !it.isNullOrBlank() }

if (requireReleaseSigning && !hasReleaseSigning) {
    throw GradleException(
        "Protected Android release signing was required, but one or more COSYNCING_ANDROID_* values are missing.",
    )
}

android {
    namespace = "com.cosyncing.client"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    defaultConfig {
        // Product identity is fixed and guarded by the release manifest checks.
        applicationId = "com.cosyncing.client"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("cosyncingRelease") {
                storeFile = file(releaseKeystorePath!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            // Local release-mode smoke keeps Flutter's debug certificate. The
            // GitHub release lane sets COSYNCING_REQUIRE_ANDROID_RELEASE_SIGNING
            // and supplies a protected, long-lived project key; it cannot fall
            // back to debug signing.
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("cosyncingRelease")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
}
