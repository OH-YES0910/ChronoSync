package com.chronosync.models

/**
 * A calibration point: video timestamp and corresponding OCR timer value.
 * Format matches web version: {videoTime, timerValue}
 */
data class CalibrationPoint(
    val videoTime: Double,    // seconds in video
    val timerValue: Double    // seconds from OCR timer
)
