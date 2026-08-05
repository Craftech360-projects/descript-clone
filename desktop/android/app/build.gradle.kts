import java.io.ByteArrayOutputStream

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.jumpcut.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.jumpcut.android"
        // 29 (Android 10): the exec-from-nativeLibraryDir story and the
        // MediaStore.Downloads API are uniform from here up. Going lower forks
        // every storage and exec code path for devices too weak for this
        // workload anyway.
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        // nodejs-mobile and our ffmpeg build are arm64-only. A second ABI would
        // double the (already large) native payload for hardware that cannot
        // render video acceptably.
        ndk { abiFilters += "arm64-v8a" }

        // libnode.so links against the shared C++ runtime; building our own
        // JNI lib with c++_shared makes AGP package libc++_shared.so into the
        // APK. Without it the app crashes at System.loadLibrary("node") with
        // UnsatisfiedLinkError: "libc++_shared.so" not found.
        externalNativeBuild {
            cmake { arguments += "-DANDROID_STL=c++_shared" }
        }
    }

    // CRITICAL: extract jniLibs to real files in nativeLibraryDir. Without this
    // libffmpeg.so is only a page-mapped region inside the APK and
    // child_process.spawn() has no file to exec.
    packaging {
        jniLibs { useLegacyPackaging = true }
    }

    externalNativeBuild {
        cmake { path = file("src/main/cpp/CMakeLists.txt") }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // Deliberately empty. The shell is a plain Activity + WebView + JNI: no
    // appcompat, no compose, no networking library. Every dependency here is
    // APK weight on top of an already-heavy native payload.
}

// ── nodejs-project assets ─────────────────────────────────────────────────────
// build.mjs bundles the server + web UI into src/main/assets/nodejs-project/.
// Hooked into preBuild so an Android Studio build can never ship stale assets.
// Skipped when npm is missing so CI that only lints Kotlin still configures.
val prepareNodeAssets by tasks.registering(Exec::class) {
    workingDir = projectDir.parentFile // desktop/android
    val npm = if (System.getProperty("os.name").lowercase().contains("win")) "npm.cmd" else "npm"
    commandLine(npm, "run", "prepare-assets")
}

tasks.named("preBuild") {
    dependsOn(prepareNodeAssets)
}
