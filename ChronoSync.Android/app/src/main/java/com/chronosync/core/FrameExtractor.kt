package com.chronosync.core

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import com.chronosync.models.CalibrationPoint
import com.chronosync.models.TimerRegion
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.random.Random
import java.util.concurrent.atomic.AtomicInteger

/**
 * Frame extraction from video files using MediaCodec.
 * 100% port of web version's extractFrames (lines 1569-1677).
 *
 * Parallelism:
 * - All sample times generated upfront
 * - All frames extracted in parallel via async/await with Semaphore(4)
 * - Each parallel task opens its own MediaMetadataRetriever (not thread-safe)
 * - Mutex serializes OCR calls (TessBaseAPI is not thread-safe)
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

        // Use a shared retriever for metadata only (released before parallel extraction)
        val metaRetriever = MediaMetadataRetriever()
        try {
            metaRetriever.setDataSource(context, videoUri)

            // Get video duration
            val durationStr = metaRetriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
            val duration = (durationStr?.toDoubleOrNull() ?: 0.0) / 1000.0
            if (duration <= 0) return@withContext emptyList()

            // Get video dimensions
            val widthStr = metaRetriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
            val heightStr = metaRetriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
            val vw = widthStr?.toIntOrNull() ?: 0
            val vh = heightStr?.toIntOrNull() ?: 0
            if (vw <= 0 || vh <= 0) return@withContext emptyList()

            metaRetriever.release()

            val usableStart = duration * 0.05
            val usableEnd = duration * 0.95

            // Generate all sample times upfront (matching web version's random sampling)
            val sampleTimes = mutableListOf<Double>()
            val usedTimes = mutableSetOf<Int>()
            for (attempt in 0 until MAX_SAMPLES * 10) {
                val t = usableStart + Random.nextDouble() * (usableEnd - usableStart)
                val key = (t * 1000).roundToInt()
                if (key !in usedTimes) {
                    usedTimes.add(key)
                    sampleTimes.add(t)
                    if (sampleTimes.size >= MAX_SAMPLES) break
                }
            }

            if (sampleTimes.isEmpty()) return@withContext emptyList()

            // Concurrency limits
            val extractionSemaphore = Semaphore(4)    // parallel bitmap extraction
            val ocrMutex = Mutex()                     // serialize TessBaseAPI calls (not thread-safe)
            val completedCount = AtomicInteger(0)

            // Extract ALL frames in parallel — each task opens its own MediaMetadataRetriever
            val extractionResults = coroutineScope {
                sampleTimes.map { time ->
                    async {
                        extractionSemaphore.withPermit {
                            extractAndOcr(
                                videoUri = videoUri,
                                time = time,
                                duration = duration,
                                region = region,
                                ocrEngine = ocrEngine,
                                ocrMutex = ocrMutex,
                                vw = vw,
                                vh = vh
                            ).also {
                                val count = completedCount.incrementAndGet()
                                onProgress(count)
                            }
                        }
                    }
                }.awaitAll()
            }

            // Collect valid results, sort by videoTime, take first MIN_CALIB_POINTS
            calibPoints.addAll(
                extractionResults
                    .filterNotNull()
                    .sortedBy { it.videoTime }
                    .take(MIN_CALIB_POINTS)
            )

        } catch (e: Exception) {
            e.printStackTrace()
        }

        calibPoints
    }

    /**
     * Extract a single frame and run OCR on it. Each call opens its own
     * MediaMetadataRetriever so it is safe to run from parallel coroutines.
     *
     * @return CalibrationPoint if OCR succeeded, null otherwise
     */
    private suspend fun extractAndOcr(
        videoUri: Uri,
        time: Double,
        duration: Double,
        region: TimerRegion,
        ocrEngine: OcrEngine,
        ocrMutex: Mutex,
        vw: Int,
        vh: Int
    ): CalibrationPoint? {
        // Each parallel task opens its own MediaMetadataRetriever (not thread-safe)
        val retriever = MediaMetadataRetriever()
        return try {
            withContext(Dispatchers.IO) {
                retriever.setDataSource(context, videoUri)
            }

            // Extract frame at target time
            val bitmap = extractFrameAtTime(retriever, time) ?: return null

            // OCR — serialized via mutex (TessBaseAPI uses JNI, not thread-safe)
            var result = ocrMutex.withLock {
                ocrEngine.readTimerValue(bitmap, region, vw, vh)
            }
            var actualTime = time

            // If failed, retry at time + 0.05s (matching web version)
            if (result.value == null) {
                val retryTime = min(time + 0.05, duration - 0.01)
                val retryBitmap = extractFrameAtTime(retriever, retryTime)
                if (retryBitmap != null) {
                    val retry = ocrMutex.withLock {
                        ocrEngine.readTimerValue(retryBitmap, region, vw, vh)
                    }
                    if (retry.value != null) {
                        result = retry
                        actualTime = retryTime
                    }
                    retryBitmap.recycle()
                }
            }

            bitmap.recycle()

            result.value?.let { timerValue ->
                CalibrationPoint(videoTime = actualTime, timerValue = timerValue)
            }
        } catch (e: Exception) {
            null
        } finally {
            try {
                retriever.release()
            } catch (_: Exception) {}
        }
    }

    /**
     * Extract a single frame at the specified time using MediaMetadataRetriever.
     */
    private fun extractFrameAtTime(
        retriever: MediaMetadataRetriever,
        timeSeconds: Double
    ): Bitmap? {
        return try {
            val timeUs = (timeSeconds * 1_000_000).toLong()
            retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        } catch (e: Exception) {
            null
        }
    }
}
