package com.chronosync.models

/**
 * Result of Theil-Sen regression: videoTime = slope * timerValue + intercept
 */
data class RegressionResult(
    val slope: Double,
    val intercept: Double
)

/**
 * Final offset calculation result for a video.
 */
data class OffsetResult(
    val videoId: String,
    val offsetSeconds: Double,
    val regression: RegressionResult?,
    val calibrationPoints: List<CalibrationPoint>,
    val hasOcr: Boolean
)
