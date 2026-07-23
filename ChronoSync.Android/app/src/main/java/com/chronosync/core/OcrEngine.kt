package com.chronosync.core

import android.graphics.Bitmap
import com.chronosync.models.TimerRegion
import com.googlecode.tesseract.android.TessBaseAPI
import java.io.File
import android.content.Context

/**
 * OCR Engine using Tesseract4Android.
 * 100% port of web version's readTimerValue + parseTimerText.
 *
 * - Crops timer region from bitmap
 * - Resizes to 640x144 for OCR
 * - Uses Tesseract with whitelist '0123456789.:'
 * - parseTimerText matches \d+:\d{1,2}(?:[.,]\d+)?
 * - Alarm icon correction: if mins > 4, mins = mins % 100
 * - Validation: mins <= 4 && secs < 60
 */
class OcrEngine(private val context: Context) {

    private var tessApi: TessBaseAPI? = null
    private var isInitialized = false

    /**
     * Initialize Tesseract with eng trained data.
     * Copies traineddata from assets if not already present.
     */
    fun initialize(): Boolean {
        if (isInitialized) return true
        return try {
            val baseDir = File(context.filesDir, "tesseract")
            if (!baseDir.exists()) baseDir.mkdirs()

            val tessDataDir = File(baseDir, "tessdata")
            if (!tessDataDir.exists()) tessDataDir.mkdirs()

            // Copy eng.traineddata from assets if not present
            val trainedDataFile = File(tessDataDir, "eng.traineddata")
            if (!trainedDataFile.exists()) {
                context.assets.open("tessdata/eng.traineddata").use { input ->
                    trainedDataFile.outputStream().use { output ->
                        input.copyTo(output)
                    }
                }
            }

            tessApi = TessBaseAPI()
            tessApi?.init(baseDir.absolutePath, "eng", TessBaseAPI.OEM_TESSERACT_ONLY)
            tessApi?.setPageSegMode(TessBaseAPI.PageSegMode.PSM_SINGLE_WORD)
            tessApi?.setVariable("tessedit_char_whitelist", "0123456789.:")
            isInitialized = true
            true
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    /**
     * Read timer value from a bitmap frame using the specified region.
     * 100% port of web version's readTimerValue.
     *
     * @param frame Bitmap of the full video frame
     * @param region Timer region as percentages (from auto-detect or manual selection)
     * @param videoWidth Original video width in pixels
     * @param videoHeight Original video height in pixels
     * @return OCR result with text and parsed value
     */
    fun readTimerValue(
        frame: Bitmap,
        region: TimerRegion,
        videoWidth: Int,
        videoHeight: Int
    ): OcrResult {
        if (!isInitialized || tessApi == null) {
            return OcrResult("", null, 0f)
        }

        // Map percentage region to actual pixel coordinates
        // This is the reverse of the web version's object-fit:contain mapping
        val videoX = (region.x / 100f * videoWidth).toInt().coerceIn(0, videoWidth - 1)
        val videoY = (region.y / 100f * videoHeight).toInt().coerceIn(0, videoHeight - 1)
        val videoW = (region.w / 100f * videoWidth).toInt().coerceAtLeast(1)
        val videoH = (region.h / 100f * videoHeight).toInt().coerceAtLeast(1)

        val rx = videoX.coerceIn(0, frame.width - 1)
        val ry = videoY.coerceIn(0, frame.height - 1)
        val rw = videoW.coerceIn(1, frame.width - rx)
        val rh = videoH.coerceIn(1, frame.height - ry)

        // Crop timer region
        val cropped = Bitmap.createBitmap(frame, rx, ry, rw, rh)

        // Resize to 640x144 (matching web version exactly)
        val resized = Bitmap.createScaledBitmap(cropped, 640, 144, true)

        return try {
            tessApi?.setImage(resized)
            val text = tessApi?.utF8Text?.trim() ?: ""
            val confidence = tessApi?.meanConfidence()?.div(100f) ?: 0f

            val value = parseTimerText(text)

            // Cleanup
            cropped.recycle()
            resized.recycle()

            OcrResult(text, value, confidence)
        } catch (e: Exception) {
            e.printStackTrace()
            cropped.recycle()
            resized.recycle()
            OcrResult("", null, 0f)
        }
    }

    /**
     * Parse OCR text to timer value in seconds.
     * 100% port of web version's parseTimerText.
     *
     * Format: MM:SS.mmm (racing timer max 04 minutes)
     * Alarm icon correction: "300"→00, "301"→01 — strip hundreds/tens digit interference
     */
    fun parseTimerText(text: String): Double? {
        val cleaned = text.replace(Regex("[^0-9:.,]"), "").trim()

        // Match XX:XX.XXX format (web version: /(\d+):(\d{1,2})(?:[.,](\d+))?/)
        val match = Regex("(\\d+):(\\d{1,2})(?:[.,](\\d+))?").find(cleaned) ?: return null

        var mins = match.groupValues[1].toIntOrNull() ?: return null
        val secs = match.groupValues[2].toIntOrNull() ?: return null
        val msStr = match.groupValues[3]
        val ms = if (msStr.isNotEmpty()) "0.$msStr".toDoubleOrNull() ?: 0.0 else 0.0

        // Alarm icon misread correction: if mins > 4, strip to last 2 digits
        // Web version: if (mins > 4) mins = mins % 100;
        if (mins > 4) mins = mins % 100

        // Validation: mins <= 4 && secs < 60
        return if (mins <= 4 && secs < 60) {
            mins * 60.0 + secs + ms
        } else {
            null
        }
    }

    fun release() {
        tessApi?.recycle()
        tessApi = null
        isInitialized = false
    }

    data class OcrResult(
        val text: String,
        val value: Double?,
        val confidence: Float
    )
}
