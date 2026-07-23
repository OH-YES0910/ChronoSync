package com.chronosync.models

import android.net.Uri

/**
 * Represents a video file selected by the user.
 */
data class VideoInfo(
    val id: String,
    val uri: Uri,
    val name: String,
    var duration: Double = 0.0,
    var width: Int = 0,
    var height: Int = 0
)
