package com.chronosync.core

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import com.chronosync.models.CalibrationPoint
import com.chronosync.models.TimerRegion
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.random.Random

/**
 * Frame extraction from video files using MediaCodec.
 * 100% port of web version's extractFrames (lines 1569-1677).
 *
 * - Random sampling, each video needs at least 3 valid calibration points (MIN_CALIB_POINTS=3)
 * - Max 30 frames (MAX_SAMPLES=30)
 * - Each frame tries OCR, retries at time+0.05s if failed
 * - Calibration point format: [{videoTime, timerValue}]
 */
class FrameExtractor(private val context: Context) {

    companion object {
        private const val MIN_CALIB_POINTS = 3
        private const val MAX_SAMPLES = 30
    }

    /**
     * Extract calibration points from a video.
     * 100% port of web version's extractFrames.
     *
     * @param videoUri URI of the video file
     * @param region Timer region as percentages
     * @param ocrEngine Initialized OCR engine
     * @param onProgress Callback for progress updates (completed frames count)
     * @return List of calibration points
     */
    suspend fun extractFrames(
        videoUri: Uri,
        region: TimerRegion,
        ocrEngine: OcrEngine,
        onProgress: (Int) -> Unit = {}
    ): List<CalibrationPoint> = withContext(Dispatchers.Default) {
        val calibPoints = mutableListOf<CalibrationPoint>()
        val usedTimes = mutableSetOf<Int>()

        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(context, videoUri)

            // Get video duration
            val durationStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
            val duration = (durationStr?.toDoubleOrNull() ?: 0.0) / 1000.0
            if (duration <= 0) return@withContext emptyList()

            // Get video dimensions
            val widthStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
            val heightStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
            val vw = widthStr?.toIntOrNull() ?: 0
            val vh = heightStr?.toIntOrNull() ?: 0
            if (vw <= 0 || vh <= 0) return@withContext emptyList()

            val usableStart = duration * 0.05
            val usableEnd = duration * 0.95

            var frameIndex = 0
            while (frameIndex < MAX_SAMPLES && calibPoints.size < MIN_CALIB_POINTS) {
                // EnsureActive check for coroutine cancellation
                ensureActive()

                // Random time within usable range (matching web version)
                var time: Double? = null
                for (attempt in 0 until 200) {
                    val t = usableStart + Random.nextDouble() * (usableEnd - usableStart)
                    val key = (t * 1000).roundToInt()
                    if (key !in usedTimes) {
                        usedTimes.add(key)
                        time = t
                        break
                    }
                }
                if (time == null) {
                    frameIndex++
                    continue // All time points used
                }

                // Extract frame at target time using MediaCodec
                val bitmap = extractFrameAtTime(retriever, time, vw, vh)
                if (bitmap != null) {
                    // Try OCR on this frame
                    var result = ocrEngine.readTimerValue(bitmap, region, vw, vh)

                    // If failed, retry at time + 0.05s (matching web version)
                    if (result.value == null) {
                        val retryTime = min(time + 0.05, duration - 0.01)
                        val retryBitmap = extractFrameAtTime(retriever, retryTime, vw, vh)
                        if (retryBitmap != null) {
                            val retry = ocrEngine.readTimerValue(retryBitmap, region, vw, vh)
                            if (retry.value != null) {
                                result = retry
                                time = retryTime
                            }
                            retryBitmap.recycle()
                        }
                    }

                    onProgress(frameIndex + 1)

                    if (result.value != null) {
                        calibPoints.add(CalibrationPoint(videoTime = time, timerValue = result.value))
                    }
                    bitmap.recycle()
                }

                frameIndex++
            }
        } catch (e: Exception) {
            e.printStackTrace()
        } finally {
            try {
                retriever.release()
            } catch (_: Exception) {}
        }

        calibPoints
    }

    /**
     * Extract a single frame at the specified time using MediaMetadataRetriever.
     */
    private fun extractFrameAtTime(
        retriever: MediaMetadataRetriever,
        timeSeconds: Double,
        width: Int,
        height: Int
    ): Bitmap? {
        return try {
            val timeUs = (timeSeconds * 1_000_000).toLong()
            retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        } catch (e: Exception) {
            null
        }
    }
}
