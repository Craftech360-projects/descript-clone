/**
 * JNI bridge: boot Node.js inside the app process.
 *
 * Adapted from the nodejs-mobile native-gradle sample. Two exports:
 *
 *   NodeRuntime.startNodeWithArguments(String[])  — runs node::Start on the
 *     CALLING thread (Kotlin dedicates a thread to it; the call blocks for the
 *     server's whole life and its return value is Node's exit code).
 *
 * Plus a stdout/stderr → logcat pump, because in-process Node writes to fds 1
 * and 2, which Android drops on the floor. Every console.log in server.mjs
 * surfaces in logcat under the "jumpcut-node" tag — that is the only window
 * into the server during the M0 spike.
 *
 * Node can be started ONCE per process. A crashed server means the Kotlin side
 * restarts the whole process (see MainActivity), not this bridge.
 */
#include <jni.h>
#include <string>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <unistd.h>
#include <pthread.h>
#include <android/log.h>
#include "node.h"

#define LOG_TAG "jumpcut-node"

// ── stdout/stderr → logcat ────────────────────────────────────────────────────
static int stdout_pipe[2];

static void* logcat_pump(void*) {
    char buf[1024];
    ssize_t n;
    while ((n = read(stdout_pipe[0], buf, sizeof(buf) - 1)) > 0) {
        if (buf[n - 1] == '\n') n--;   // logcat adds its own newline
        buf[n] = '\0';
        __android_log_write(ANDROID_LOG_INFO, LOG_TAG, buf);
    }
    return nullptr;
}

static void redirect_stdio_to_logcat() {
    // Line-buffer so a console.log arrives as one logcat line, promptly.
    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(stdout_pipe);
    dup2(stdout_pipe[1], STDOUT_FILENO);
    dup2(stdout_pipe[1], STDERR_FILENO);
    pthread_t t;
    pthread_create(&t, nullptr, logcat_pump, nullptr);
    pthread_detach(t);
}

// ── Node start ────────────────────────────────────────────────────────────────
extern "C" JNIEXPORT jint JNICALL
Java_com_jumpcut_android_NodeRuntime_startNodeWithArguments(
        JNIEnv* env, jobject /* this */, jobjectArray arguments) {

    redirect_stdio_to_logcat();

    // Marshal the Java String[] into the contiguous argv block node::Start
    // expects (argv strings must outlive the call; Node also rewrites argv,
    // hence one flat allocation).
    const int argc = env->GetArrayLength(arguments);
    size_t total = 0;
    for (int i = 0; i < argc; i++) {
        auto s = (jstring) env->GetObjectArrayElement(arguments, i);
        total += env->GetStringUTFLength(s) + 1;
        env->DeleteLocalRef(s);
    }

    char* payload = (char*) malloc(total);
    char** argv = (char**) malloc(sizeof(char*) * argc);
    char* p = payload;
    for (int i = 0; i < argc; i++) {
        auto s = (jstring) env->GetObjectArrayElement(arguments, i);
        const char* utf = env->GetStringUTFChars(s, nullptr);
        size_t len = strlen(utf) + 1;
        memcpy(p, utf, len);
        argv[i] = p;
        p += len;
        env->ReleaseStringUTFChars(s, utf);
        env->DeleteLocalRef(s);
    }

    __android_log_print(ANDROID_LOG_INFO, LOG_TAG, "starting node with %d args", argc);
    const int code = node::Start(argc, argv);
    __android_log_print(ANDROID_LOG_WARN, LOG_TAG, "node exited with code %d", code);

    free(argv);
    free(payload);
    return code;
}
