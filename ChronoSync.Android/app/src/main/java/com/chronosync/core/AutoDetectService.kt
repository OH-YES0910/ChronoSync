package com.chronosync.core

import android.graphics.Bitmap
import android.graphics.Color
import com.chronosync.models.DetectionResult
import com.chronosync.models.TimerRegion
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Auto-detection of timer region in video frames.
 * 100% port of web version's autoDetectRegion (lines 266-499).
 *
 * Algorithm:
 * 1. Scan right upper corner (x>70%, y<25%) for warm-colored pixels
 *    - Warm criteria: R>120, (R-B)>60, R>G*0.6
 * 2. Row histogram to find horizontal warm bands
 * 3. Column histogram to find rectangular segments
 * 4. White text validation (exclude LED light strips)
 * 5. Multi-frame sampling (8 frames) + clustering vote (center <5% distance)
 */
class AutoDetectService {

    companion object {
        // Warm pixel criteria (exactly matching web version)
        private const val WARM_R_MIN = 120
        private const val WARM_RB_DIFF = 60
        private const val WARM_RG_RATIO = 0.6

        // Scan region: x>70%, y from 5% to 25%
        private const val SCAN_X_START = 0.70
        private const val SCAN_Y_START = 0.05
        private const val SCAN_Y_END = 0.25

        // Row threshold: 20% of peak
        private const val ROW_THRESH_RATIO = 0.20

        // Column threshold: 25% of row height
        private const val COL_THRESH_RATIO = 0.25

        // White text validation
        private const val WHITE_R_MIN = 200
        private const val WHITE_G_MIN = 200
        private const val WHITE_B_MIN = 200
        private const val WHITE_DIFF_MAX = 30
        private const val MIN_WHITE_COUNT = 10
        private const val MIN_WHITE_RATIO = 0.01

        // Clustering: center distance < 5%
        private const val CLUSTER_DISTANCE = 0.05

        // Number of sample frames
        private const val NUM_SAMPLES = 8
    }

    /**
     * Check if a pixel is warm-colored (exactly matching web version criteria).
     * Web version: r > 120 && (r - b) > 60 && r > g * 0.6
     */
    private fun isWarmPixel(r: Int, g: Int, b: Int): Boolean {
        return r > WARM_R_MIN && (r - b) > WARM_RB_DIFF && r > (g * WARM_RG_RATIO).toInt()
    }

    /**
     * Check if a pixel is white text.
     * Web version: r > 200 && g > 200 && b > 200 && |r-g| < 30 && |r-b| < 30
     */
    private fun isWhitePixel(r: Int, g: Int, b: Int): Boolean {
        return r > WHITE_R_MIN && g > WHITE_G_MIN && b > WHITE_B_MIN &&
                abs(r - g) < WHITE_DIFF_MAX && abs(r - b) < WHITE_DIFF_MAX
    }

    /**
     * Find timer region in a single frame.
     * 100% port of web version's findTimer (lines 315-410).
     */
    fun findTimer(bitmap: Bitmap, vw: Int, vh: Int): DetectionResult? {
        val sx = floor(vw * SCAN_X_START).toInt()
        val sy = floor(vh * SCAN_Y_START).toInt()
        val ey = floor(vh * SCAN_Y_END).toInt()
        val scanH = ey - sy
        val scanW = vw - sx

        if (scanH <= 0 || scanW <= 0) return null

        // Step 1: Row histogram — how many warm pixels per row (find horizontal band)
        val rowHist = IntArray(scanH)
        for (y in sy until ey) {
            for (x in sx until vw) {
                val pixel = bitmap.getPixel(x, y)
                val r = Color.red(pixel)
                val g = Color.green(pixel)
                val b = Color.blue(pixel)
                if (isWarmPixel(r, g, b)) {
                    rowHist[y - sy]++
                }
            }
        }

        // Find peak in row histogram
        var maxRowCount = 0
        var centerRow = 0
        for (i in rowHist.indices) {
            if (rowHist[i] > maxRowCount) {
                maxRowCount = rowHist[i]
                centerRow = i
            }
        }
        if (maxRowCount < 5) return null  // Web version: "no warm rows"

        // Row expansion: take all rows >= 20% of peak
        val rowThresh = (maxRowCount * ROW_THRESH_RATIO).toInt()
        var top = scanH
        var bottom = 0
        for (i in rowHist.indices) {
            if (rowHist[i] >= rowThresh) {
                if (i < top) top = i
                if (i > bottom) bottom = i
            }
        }
        if (top > bottom) return null  // Web version: "no warm rows after thresh"

        val minY = sy + top
        val maxY = sy + bottom
        val rowH = maxY - minY + 1

        // Step 2: Column histogram within determined row range
        val colHist = IntArray(scanW)
        for (y in minY..maxY) {
            for (x in sx until vw) {
                val pixel = bitmap.getPixel(x, y)
                val r = Color.red(pixel)
                val g = Color.green(pixel)
                val b = Color.blue(pixel)
                if (isWarmPixel(r, g, b)) {
                    colHist[x - sx]++
                }
            }
        }

        // Column threshold: >= 25% of row height (filter scattered points)
        val colThresh = (rowH * COL_THRESH_RATIO).toInt()

        // Collect all continuous column segments
        val segments = mutableListOf<Pair<Int, Int>>() // start, length
        var curRun = 0
        var curStart = 0
        for (i in colHist.indices) {
            if (colHist[i] >= colThresh) {
                if (curRun == 0) curStart = i
                curRun++
            } else {
                if (curRun > 0) {
                    segments.add(Pair(curStart, curRun))
                    curRun = 0
                }
            }
        }
        if (curRun > 0) segments.add(Pair(curStart, curRun))

        // Select segment with highest warm pixel total (rectangle blocks score highest, light strips score low)
        var bestSeg: Pair<Int, Int>? = null
        var bestScore = 0
        for ((start, len) in segments) {
            var sum = 0
            for (i in start until start + len) {
                sum += colHist[i]
            }
            if (sum > bestScore) {
                bestScore = sum
                bestSeg = Pair(start, len)
            }
        }

        if (bestSeg == null) return null  // Web version: "no valid segment"

        val minX = sx + bestSeg.first
        val maxX = sx + bestSeg.first + bestSeg.second
        val bW = maxX - minX
        val bH = maxY - minY

        // White text check: timer has white digits, light strips don't
        var whiteCount = 0
        val totalPixels = bW * bH
        for (y in minY..maxY) {
            for (x in minX until maxX) {
                val pixel = bitmap.getPixel(x, y)
                val r = Color.red(pixel)
                val g = Color.green(pixel)
                val b = Color.blue(pixel)
                if (isWhitePixel(r, g, b)) {
                    whiteCount++
                }
            }
        }
        val whiteRatio = whiteCount.toDouble() / totalPixels

        // No white pixels = not a timer (it's a light strip)
        if (whiteCount < MIN_WHITE_COUNT || whiteRatio < MIN_WHITE_RATIO) return null

        return DetectionResult(
            minX = minX,
            maxX = maxX,
            minY = minY,
            maxY = maxY,
            count = bestScore,
            seekTime = 0.0 // will be set by caller
        )
    }

    /**
     * Auto-detect timer region across multiple frames.
     * 100% port of web version's autoDetectRegion (lines 412-498).
     *
     * Samples 8 frames, clusters detections by center position (<5% distance),
     * and picks the cluster with most votes.
     */
    fun autoDetectFromFrames(
        frames: List<Pair<Double, Bitmap>>, // List of (time, bitmap)
        videoWidth: Int,
        videoHeight: Int
    ): TimerRegion? {
        val vw = videoWidth
        val vh = videoHeight

        // Run findTimer on each sampled frame
        val detections = mutableListOf<DetectionResult>()
        for ((time, bitmap) in frames) {
            val result = findTimer(bitmap, vw, vh)
            if (result != null) {
                detections.add(result.copy(seekTime = time))
            }
        }

        if (detections.isEmpty()) return null

        // Cluster by center position: distance < 5% of frame dimensions
        // Web version: |cx - cl.cx| < 0.05 && |cy - cl.cy| < 0.05
        data class Cluster(
            var cx: Double,
            var cy: Double,
            val items: MutableList<DetectionResult> = mutableListOf()
        )

        val clusters = mutableListOf<Cluster>()
        for (d in detections) {
            val cx = (d.minX + d.maxX).toDouble() / 2 / vw
            val cy = (d.minY + d.maxY).toDouble() / 2 / vh
            var matched = false
            for (cl in clusters) {
                if (abs(cx - cl.cx) < CLUSTER_DISTANCE && abs(cy - cl.cy) < CLUSTER_DISTANCE) {
                    cl.items.add(d)
                    // Update cluster center to average
                    cl.cx = cl.items.map { (it.minX + it.maxX).toDouble() / 2 / vw }.average()
                    cl.cy = cl.items.map { (it.minY + it.maxY).toDouble() / 2 / vh }.average()
                    matched = true
                    break
                }
            }
            if (!matched) {
                clusters.add(Cluster(cx, cy, mutableListOf(d)))
            }
        }

        // Select cluster with most votes, take average within cluster
        clusters.sortByDescending { it.items.size }
        val bestCluster = clusters[0]

        val minX = bestCluster.items.map { it.minX }.average().roundToInt()
        val maxX = bestCluster.items.map { it.maxX }.average().roundToInt()
        val minY = bestCluster.items.map { it.minY }.average().roundToInt()
        val maxY = bestCluster.items.map { it.maxY }.average().roundToInt()

        // Add padding (matching web version exactly)
        val tW = maxX - minX
        val tH = maxY - minY
        val padX = max((tW * 0.15).toInt(), (vw * 0.003).toInt())
        val padY = max((tH * 0.2).toInt(), (vh * 0.002).toInt())
        val fx = max(0, minX - padX)
        val fy = max(0, minY - padY)
        val fw = min(vw, maxX + padX) - fx
        val fh = min(vh, maxY + padY) - fy

        // Convert pixel coordinates to percentage (matching web version)
        val xPct = (fx.toFloat() / vw * 100).let { (it * 10).roundToInt() / 10f }
        val yPct = (fy.toFloat() / vh * 100).let { (it * 10).roundToInt() / 10f }
        val wPct = (fw.toFloat() / vw * 100).let { (it * 10).roundToInt() / 10f }
        val hPct = (fh.toFloat() / vh * 100).let { (it * 10).roundToInt() / 10f }

        return TimerRegion(
            x = xPct.coerceIn(0f, 100f),
            y = yPct.coerceIn(0f, 100f),
            w = wPct.coerceIn(0f, 100f - xPct),
            h = hPct.coerceIn(0f, 100f - yPct)
        )
    }
}
