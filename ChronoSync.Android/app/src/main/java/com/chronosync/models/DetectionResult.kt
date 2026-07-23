package com.chronosync.models

/**
 * Result from auto-detection of timer region in a video frame.
 */
data class DetectionResult(
    val minX: Int,
    val maxX: Int,
    val minY: Int,
    val maxY: Int,
    val count: Int,  // warm pixel count
    val seekTime: Double
)
