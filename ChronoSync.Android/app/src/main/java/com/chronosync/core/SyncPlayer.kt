package com.chronosync.core

import android.content.Context
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackParameters
import androidx.media3.exoplayer.ExoPlayer
import com.chronosync.models.VideoInfo
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.abs

/**
 * Synchronized video player using ExoPlayer.
 * 100% port of web version's sync playback (lines 773-904).
 *
 * Sync algorithm:
 * - Seek all videos to correct position, then play
 * - Sync loop every 0.3s:
 *   - absDrift > 2.0s → direct seek
 *   - absDrift > 0.15s → playbackRate micro-adjust (±5%)
 *   - Otherwise → normal rate (1.0)
 */
class SyncPlayer(private val context: Context) {

    companion object {
        private const val SYNC_CHECK_INTERVAL_MS = 300L  // 0.3 seconds
        private const val SEEK_THRESHOLD = 2.0           // Direct seek threshold
        private const val RATE_ADJUST_THRESHOLD = 0.15   // Rate adjustment threshold
        private const val MAX_RATE_ADJUSTMENT = 0.05     // ±5% max rate change
    }

    data class PlayerEntry(
        val video: VideoInfo,
        val exoPlayer: ExoPlayer,
        var offset: Double = 0.0
    )

    private val players = mutableListOf<PlayerEntry>()
    private var syncJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private val _isPlaying = MutableStateFlow(false)
    val isPlaying: StateFlow<Boolean> = _isPlaying.asStateFlow()

    private val _currentTime = MutableStateFlow(0.0)
    val currentTime: StateFlow<Double> = _currentTime.asStateFlow()

    /**
     * Add a video to the synchronized player.
     */
    fun addVideo(videoInfo: VideoInfo, offset: Double = 0.0): ExoPlayer {
        val exoPlayer = ExoPlayer.Builder(context).build()
        val mediaItem = MediaItem.fromUri(videoInfo.uri)
        exoPlayer.setMediaItem(mediaItem)
        exoPlayer.prepare()

        players.add(PlayerEntry(video = videoInfo, exoPlayer = exoPlayer, offset = offset))
        return exoPlayer
    }

    /**
     * Set offset for a specific video.
     */
    fun setOffset(videoId: String, offset: Double) {
        players.find { it.video.id == videoId }?.offset = offset
    }

    /**
     * Update offset for a specific video.
     */
    fun adjustOffset(videoId: String, delta: Double) {
        players.find { it.video.id == videoId }?.let {
            it.offset += delta
        }
    }

    /**
     * Get current offset for a video.
     */
    fun getOffset(videoId: String): Double {
        return players.find { it.video.id == videoId }?.offset ?: 0.0
    }

    /**
     * Seek all videos to a specific time (considering offsets).
     * Matching web version's updateSyncFromSlider.
     */
    fun seekTo(time: Double) {
        for ((index, entry) in players.withIndex()) {
            val offset = entry.offset
            val targetTime = if (index == 0) time else time + offset
            val clampedTime = maxOf(0.0, targetTime)
            entry.exoPlayer.seekTo((clampedTime * 1000).toLong())
        }
        _currentTime.value = time
    }

    /**
     * Start synchronized playback.
     * 100% port of web version's startSyncPlay (lines 773-904).
     */
    fun startSyncPlay() {
        if (players.size < 2) return

        // Find base video offset
        val baseOffset = players.firstOrNull()?.offset ?: 0.0

        // Set all videos to correct position and play
        for (entry in players) {
            val offset = entry.offset
            val startDelay = offset - baseOffset

            if (startDelay < 0) {
                // Negative offset: video hasn't reached its time yet, pause and wait for sync loop
                entry.exoPlayer.seekTo(0)
                entry.exoPlayer.pause()
            } else {
                entry.exoPlayer.playbackParameters = PlaybackParameters(1.0f)
                entry.exoPlayer.play()
            }
        }

        _isPlaying.value = true

        // Start sync loop
        syncJob = scope.launch {
            var lastSyncTime = -1.0

            while (isActive && _isPlaying.value) {
                delay(SYNC_CHECK_INTERVAL_MS)

                val basePlayer = players.firstOrNull() ?: break
                val baseTime = basePlayer.exoPlayer.currentPosition / 1000.0

                // Update current time display
                _currentTime.value = baseTime

                // Check if base video ended
                if (baseTime >= (basePlayer.video.duration - 0.1)) {
                    pauseSyncPlay()
                    break
                }

                // Sync other videos every 0.3s (matching web version)
                if (abs(baseTime - lastSyncTime) >= 0.3) {
                    lastSyncTime = baseTime

                    for ((index, entry) in players.withIndex()) {
                        if (index == 0) continue // Skip base video

                        val offset = entry.offset
                        val targetTime = baseTime + offset

                        // Negative offset: pause and wait
                        if (targetTime < 0) {
                            if (entry.exoPlayer.isPlaying) {
                                entry.exoPlayer.pause()
                                entry.exoPlayer.seekTo(0)
                                entry.exoPlayer.playbackParameters = PlaybackParameters(1.0f)
                            }
                            continue
                        }

                        // Positive offset: resume if was paused
                        if (!entry.exoPlayer.isPlaying) {
                            entry.exoPlayer.seekTo((targetTime * 1000).toLong())
                            entry.exoPlayer.playbackParameters = PlaybackParameters(1.0f)
                            entry.exoPlayer.play()
                            continue
                        }

                        // Drift correction (matching web version exactly)
                        val currentPos = entry.exoPlayer.currentPosition / 1000.0
                        val drift = currentPos - targetTime
                        val absDrift = abs(drift)

                        when {
                            absDrift > SEEK_THRESHOLD -> {
                                // Large drift: direct seek
                                entry.exoPlayer.seekTo((targetTime * 1000).toLong())
                                entry.exoPlayer.playbackParameters = PlaybackParameters(1.0f)
                            }
                            absDrift > RATE_ADJUST_THRESHOLD -> {
                                // Medium drift: playbackRate micro-adjust (±5%)
                                // Web version: correction = max(-0.05, min(0.05, -drift * 0.3))
                                val correction = maxOf(
                                    -MAX_RATE_ADJUSTMENT,
                                    minOf(MAX_RATE_ADJUSTMENT, -drift * 0.3)
                                )
                                entry.exoPlayer.playbackParameters =
                                    PlaybackParameters((1.0f + correction).toFloat())
                            }
                            else -> {
                                // Small drift: normal rate
                                entry.exoPlayer.playbackParameters = PlaybackParameters(1.0f)
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Pause synchronized playback.
     * 100% port of web version's pauseSyncPlay (lines 906-922).
     */
    fun pauseSyncPlay() {
        _isPlaying.value = false

        for (entry in players) {
            entry.exoPlayer.pause()
            entry.exoPlayer.playbackParameters = PlaybackParameters(1.0f)
        }

        syncJob?.cancel()
        syncJob = null
    }

    /**
     * Release all players and resources.
     */
    fun release() {
        pauseSyncPlay()
        for (entry in players) {
            entry.exoPlayer.release()
        }
        players.clear()
        scope.cancel()
    }

    /**
     * Get all player entries (for UI rendering).
     */
    fun getPlayers(): List<PlayerEntry> = players.toList()

    /**
     * Get the ExoPlayer for a specific video.
     */
    fun getPlayerForVideo(videoId: String): ExoPlayer? {
        return players.find { it.video.id == videoId }?.exoPlayer
    }
}
