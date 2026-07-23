package com.chronosync.models

/**
 * Timer region coordinates as percentages of video dimensions.
 * Matches web version: {x, y, w, h} in percentage.
 */
data class TimerRegion(
    val x: Float,  // percentage 0-100
    val y: Float,  // percentage 0-100
    val w: Float,  // percentage 0-100
    val h: Float   // percentage 0-100
)
