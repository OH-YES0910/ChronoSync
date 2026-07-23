package com.chronosync.core

import com.chronosync.models.CalibrationPoint
import com.chronosync.models.RegressionResult
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max

/**
 * Offset calculation using Theil-Sen robust regression.
 * 100% port of web version's calculateBestOffset (lines 1680-1770)
 * and theilSenRegression (lines 1539-1566).
 *
 * Algorithm:
 * 1. Theil-Sen: compute all pair slopes → median → intercept median
 * 2. Outlier filtering: residuals > 1.5s removed
 * 3. Calculate offset at median timer value (not T=0 extrapolation)
 * 4. Consistency check: MAD check, outlier adjustment (0.3*original + 0.7*median)
 */
class OffsetCalculator {

    /**
     * Theil-Sen robust regression.
     * 100% port of web version's theilSenRegression (lines 1539-1566).
     *
     * videoTime = slope × timerValue + intercept
     * Direction: timer value → video time (not reverse)
     *
     * @return RegressionResult or null if insufficient data
     */
    fun theilSenRegression(points: List<CalibrationPoint>): RegressionResult? {
        if (points.size < 2) return null

        // Compute all pair slopes: ΔvideoTime / ΔtimerValue
        val slopes = mutableListOf<Double>()
        for (i in points.indices) {
            for (j in i + 1 until points.size) {
                val dt = points[j].timerValue - points[i].timerValue
                if (abs(dt) > 0.001) { // Avoid division by zero
                    val dv = points[j].videoTime - points[i].videoTime
                    slopes.add(dv / dt)
                }
            }
        }

        if (slopes.isEmpty()) return null

        // Median slope
        slopes.sort()
        val medianSlope = if (slopes.size % 2 == 0) {
            (slopes[slopes.size / 2 - 1] + slopes[slopes.size / 2]) / 2.0
        } else {
            slopes[floor(slopes.size / 2.0).toInt()]
        }

        // Intercept median: intercept = videoTime - slope × timerValue
        val intercepts = points.map { it.videoTime - medianSlope * it.timerValue }
        intercepts.sorted()
        val sortedIntercepts = intercepts.sorted()
        val medianIntercept = if (sortedIntercepts.size % 2 == 0) {
            (sortedIntercepts[sortedIntercepts.size / 2 - 1] + sortedIntercepts[sortedIntercepts.size / 2]) / 2.0
        } else {
            sortedIntercepts[floor(sortedIntercepts.size / 2.0).toInt()]
        }

        return RegressionResult(slope = medianSlope, intercept = medianIntercept)
    }

    /**
     * Calculate best offset between a target video and the base video.
     * 100% port of web version's calculateBestOffset (lines 1680-1770).
     *
     * @param basePoints Calibration points for the base (first) video
     * @param targetPoints Calibration points for the target video
     * @param allTimerValues All timer values collected so far (for median calculation)
     * @return Offset in seconds, or null if calculation fails
     */
    fun calculateOffset(
        basePoints: List<CalibrationPoint>,
        targetPoints: List<CalibrationPoint>,
        allTimerValues: MutableList<Double>
    ): Double? {
        val baseReg = theilSenRegression(basePoints) ?: return null

        var points = targetPoints

        // First pass: initial regression
        var reg = theilSenRegression(points) ?: return null

        // Outlier filtering: remove points with residuals > 1.5s (matching web version)
        if (points.size > 3) {
            val residuals = points.map { p ->
                abs(p.videoTime - (reg.slope * p.timerValue + reg.intercept))
            }
            val sorted = residuals.sorted()
            val median = sorted[floor(sorted.size / 2.0).toInt()]
            val threshold = max(1.5, median * 2.5)

            val filtered = points.filterIndexed { idx, _ -> residuals[idx] < threshold }

            if (filtered.size >= 2 && filtered.size < points.size) {
                points = filtered
                reg = theilSenRegression(points) ?: return null
            }
        }

        // Collect target video timer values for median
        allTimerValues.addAll(points.map { it.timerValue })

        // Calculate offset at median timer value (not T=0 extrapolation)
        // Web version: offset(T) = targetReg(T) - baseReg(T)
        val sortedAll = allTimerValues.sorted()
        val medianTimer = if (sortedAll.size % 2 == 0) {
            (sortedAll[sortedAll.size / 2 - 1] + sortedAll[sortedAll.size / 2]) / 2.0
        } else {
            sortedAll[floor(sortedAll.size / 2.0).toInt()]
        }

        val baseTimeAtMedian = baseReg.slope * medianTimer + baseReg.intercept
        val targetTimeAtMedian = reg.slope * medianTimer + reg.intercept
        return targetTimeAtMedian - baseTimeAtMedian
    }

    /**
     * Consistency check: adjust outlier offsets toward median.
     * 100% port of web version's second-pass consistency check (lines 1751-1770).
     *
     * @param offsets Map of videoId → offset
     * @param videoIds List of video IDs (excluding base)
     * @return Adjusted offsets map
     */
    fun consistencyCheck(
        offsets: Map<String, Double>,
        videoIds: List<String>
    ): Map<String, Double> {
        val nonZeroOffsets = offsets.values.filter { it != 0.0 }
        if (nonZeroOffsets.size <= 1) return offsets

        val sorted = nonZeroOffsets.sorted()
        val medianOffset = if (sorted.size % 2 == 0) {
            (sorted[sorted.size / 2 - 1] + sorted[sorted.size / 2]) / 2.0
        } else {
            sorted[floor(sorted.size / 2.0).toInt()]
        }

        // MAD (Median Absolute Deviation)
        val mad = nonZeroOffsets.sumOf { abs(it - medianOffset) } / nonZeroOffsets.size

        val adjusted = offsets.toMutableMap()
        for (vid in videoIds) {
            val currentOffset = adjusted[vid] ?: continue
            if (currentOffset == 0.0) continue

            // If offset is outlier: 0.3 * original + 0.7 * median (matching web version)
            if (abs(currentOffset - medianOffset) > max(2.0, mad * 3)) {
                adjusted[vid] = currentOffset * 0.3 + medianOffset * 0.7
            }
        }

        return adjusted
    }
}
