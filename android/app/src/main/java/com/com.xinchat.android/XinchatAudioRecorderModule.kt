package com.xinchat.android

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.util.Locale

class XinchatAudioRecorderModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {

  private var mediaRecorder: MediaRecorder? = null
  private var mediaPlayer: MediaPlayer? = null
  private var currentFile: File? = null
  private var startedAtMs: Long = 0L

  override fun getName(): String = "XinchatAudioRecorder"

  @ReactMethod
  fun startRecording(promise: Promise) {
    if (mediaRecorder != null) {
      promise.reject("E_BUSY", "Recorder is already running.")
      return
    }
    if (!hasRecordPermission()) {
      promise.reject("E_PERMISSION", "RECORD_AUDIO permission denied.")
      return
    }

    val voiceDir = File(context.cacheDir, "voice").apply { mkdirs() }
    val file = File(voiceDir, String.format(Locale.US, "voice-%d.m4a", System.currentTimeMillis()))

    try {
      val recorder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else MediaRecorder()
      recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
      recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
      recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      recorder.setAudioEncodingBitRate(96_000)
      recorder.setAudioSamplingRate(44_100)
      recorder.setOutputFile(file.absolutePath)
      recorder.prepare()
      recorder.start()

      mediaRecorder = recorder
      currentFile = file
      startedAtMs = System.currentTimeMillis()

      val payload = Arguments.createMap().apply {
        putString("uri", "file://${file.absolutePath}")
        putString("mimeType", "audio/mp4")
        putString("fileName", file.name)
        putDouble("durationMs", 0.0)
      }
      promise.resolve(payload)
    } catch (error: Throwable) {
      safeReleaseRecorder()
      try {
        if (file.exists()) file.delete()
      } catch (_: Throwable) {}
      currentFile = null
      startedAtMs = 0L
      promise.reject("E_START_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun stopRecording(promise: Promise) {
    val recorder = mediaRecorder
    val file = currentFile
    if (recorder == null || file == null) {
      safeReleaseRecorder()
      currentFile = null
      startedAtMs = 0L
      promise.resolve(null)
      return
    }

    val durationMs = kotlin.math.max(0L, System.currentTimeMillis() - startedAtMs)
    try {
      recorder.stop()
    } catch (_: Throwable) {
    } finally {
      safeReleaseRecorder()
    }

    val exists = try {
      file.exists() && file.length() > 0L
    } catch (_: Throwable) {
      false
    }
    currentFile = null
    startedAtMs = 0L

    if (!exists) {
      try {
        file.delete()
      } catch (_: Throwable) {}
      promise.resolve(null)
      return
    }

    val payload = Arguments.createMap().apply {
      putString("uri", "file://${file.absolutePath}")
      putString("mimeType", "audio/mp4")
      putString("fileName", file.name)
      putDouble("durationMs", durationMs.toDouble())
    }
    promise.resolve(payload)
  }

  @ReactMethod
  fun cancelRecording(promise: Promise) {
    val file = currentFile
    val recorder = mediaRecorder
    if (recorder != null) {
      try {
        recorder.stop()
      } catch (_: Throwable) {
      } finally {
        safeReleaseRecorder()
      }
    } else {
      safeReleaseRecorder()
    }

    currentFile = null
    startedAtMs = 0L
    if (file != null) {
      try {
        if (file.exists()) file.delete()
      } catch (_: Throwable) {}
    }
    promise.resolve(true)
  }

  @ReactMethod
  fun startPlayback(url: String, promise: Promise) {
    val source = url.trim()
    if (source.isEmpty()) {
      promise.reject("E_PLAYBACK_URL", "Playback url is empty.")
      return
    }

    safeReleasePlayer()
    try {
      val player = MediaPlayer().apply {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
          setAudioAttributes(
            AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_MEDIA)
              .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
              .build()
          )
        }
      }

      player.setOnCompletionListener {
        safeReleasePlayer()
      }
      player.setOnErrorListener { _, _, _ ->
        safeReleasePlayer()
        true
      }
      player.setOnPreparedListener {
        try {
          it.start()
          promise.resolve(true)
        } catch (error: Throwable) {
          safeReleasePlayer()
          promise.reject("E_PLAYBACK_START", error.message, error)
        }
      }
      player.setDataSource(context, Uri.parse(source))
      player.prepareAsync()
      mediaPlayer = player
    } catch (error: Throwable) {
      safeReleasePlayer()
      promise.reject("E_PLAYBACK_PREPARE", error.message, error)
    }
  }

  @ReactMethod
  fun stopPlayback(promise: Promise) {
    safeReleasePlayer()
    promise.resolve(true)
  }

  override fun invalidate() {
    super.invalidate()
    safeReleaseRecorder()
    safeReleasePlayer()
    currentFile = null
    startedAtMs = 0L
  }

  private fun hasRecordPermission(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
    return context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
  }

  private fun safeReleaseRecorder() {
    val recorder = mediaRecorder ?: return
    try {
      recorder.reset()
    } catch (_: Throwable) {}
    try {
      recorder.release()
    } catch (_: Throwable) {}
    mediaRecorder = null
  }

  private fun safeReleasePlayer() {
    val player = mediaPlayer ?: return
    try {
      if (player.isPlaying) {
        player.stop()
      }
    } catch (_: Throwable) {}
    try {
      player.reset()
    } catch (_: Throwable) {}
    try {
      player.release()
    } catch (_: Throwable) {}
    mediaPlayer = null
  }
}
