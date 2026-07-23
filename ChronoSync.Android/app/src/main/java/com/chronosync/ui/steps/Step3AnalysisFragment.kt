package com.chronosync.ui.steps

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.chronosync.MainActivity
import com.chronosync.core.FrameExtractor
import com.chronosync.core.OffsetCalculator
import com.chronosync.core.OcrEngine
import com.chronosync.core.SyncPlayer
import com.chronosync.databinding.FragmentStep3Binding
import com.chronosync.models.CalibrationPoint
import com.chronosync.models.OffsetResult
import com.chronosync.export.VideoExporter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Step 3: Analysis + sync playback + export.
 * - Run OCR on all videos to get calibration points
 * - Calculate offsets using Theil-Sen regression
 * - Synchronized playback with drift correction
 * - Export to MP4 with layout options
 */
class Step3AnalysisFragment : Fragment() {

    private var _binding: FragmentStep3Binding? = null
    private val binding get() = _binding!!

    private lateinit var ocrEngine: OcrEngine
    private lateinit var frameExtractor: FrameExtractor
    private lateinit var offsetCalculator: OffsetCalculator
    private lateinit var syncPlayer: SyncPlayer
    private lateinit var videoExporter: VideoExporter

    private var isPlaying = false
    private val videoViews = mutableMapOf<String, PlayerView>()

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentStep3Binding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        ocrEngine = OcrEngine(requireContext())
        frameExtractor = FrameExtractor(requireContext())
        offsetCalculator = OffsetCalculator()
        syncPlayer = SyncPlayer(requireContext())
        videoExporter = VideoExporter(requireContext())

        val mainActivity = requireActivity() as MainActivity

        // Initialize OCR
        lifecycleScope.launch {
            val initialized = withContext(Dispatchers.Default) { ocrEngine.initialize() }
            if (!initialized) {
                Toast.makeText(requireContext(), "OCR initialization failed", Toast.LENGTH_LONG).show()
            }
        }

        // Start analysis automatically
        analyzeVideos(mainActivity)

        // Sync play button
        binding.btnSyncPlay.setOnClickListener {
            if (isPlaying) {
                pauseSync()
            } else {
                startSync()
            }
        }

        // Time slider
        binding.timeSlider.addOnChangeListener { _, value, fromUser ->
            if (fromUser) {
                if (isPlaying) pauseSync()
                syncPlayer.seekTo(value.toDouble())
                binding.timeDisplay.text = "%.1fs".format(value)
            }
        }

        // Back button
        binding.btnBack.setOnClickListener {
            if (isPlaying) pauseSync()
            mainActivity.goToStepClear(2)
        }

        // Export button
        binding.btnExport.setOnClickListener {
            exportVideo(mainActivity)
        }

        // Layout buttons
        setupLayoutButtons()
    }

    private fun analyzeVideos(mainActivity: MainActivity) {
        binding.analysisStatus.text = "Analyzing videos..."
        binding.progressBar.progress = 5

        lifecycleScope.launch {
            try {
                val allFrames = mutableMapOf<String, List<CalibrationPoint>>()
                val totalVideos = mainActivity.videos.size
                var completedVideos = 0

                // Process each video
                for (video in mainActivity.videos) {
                    val region = mainActivity.regions[video.id] ?: continue

                    val points = withContext(Dispatchers.Default) {
                        frameExtractor.extractFrames(
                            videoUri = video.uri,
                            region = region,
                            ocrEngine = ocrEngine,
                            onProgress = { frame ->
                                val totalProgress = (completedVideos * 8 + frame).toFloat() /
                                        (totalVideos * 8) * 80
                                launch(Dispatchers.Main) {
                                    binding.progressBar.progress = (5 + totalProgress).toInt()
                                }
                            }
                        )
                    }

                    allFrames[video.id] = points
                    mainActivity.frames[video.id] = points
                    completedVideos++
                }

                binding.progressBar.progress = 90
                binding.analysisStatus.text = "Calculating offsets..."

                // Calculate offsets
                withContext(Dispatchers.Default) {
                    calculateOffsets(mainActivity, allFrames)
                }

                binding.progressBar.progress = 100
                binding.analysisStatus.text = "Analysis complete!"

                // Setup sync player
                setupSyncPlayer(mainActivity)

            } catch (e: Exception) {
                binding.analysisStatus.text = "Analysis failed: ${e.message}"
            }
        }
    }

    private suspend fun calculateOffsets(
        mainActivity: MainActivity,
        allFrames: Map<String, List<CalibrationPoint>>
    ) {
        val videos = mainActivity.videos.filter { video ->
            val points = allFrames[video.id]
            points != null && points.size >= 2
        }

        if (videos.size < 2) {
            mainActivity.offsets.clear()
            return
        }

        val base = videos[0]
        val basePoints = allFrames[base.id] ?: return
        val baseReg = offsetCalculator.theilSenRegression(basePoints) ?: return

        val allTimerValues = basePoints.map { it.timerValue }.toMutableList()

        for (i in 1 until videos.size) {
            val target = videos[i]
            val targetPoints = allFrames[target.id] ?: continue

            val offset = offsetCalculator.calculateOffset(basePoints, targetPoints, allTimerValues)
            if (offset != null) {
                mainActivity.offsets[target.id] = offset
            }
        }

        // Consistency check
        val adjusted = offsetCalculator.consistencyCheck(
            mainActivity.offsets,
            videos.drop(1).map { it.id }
        )
        mainActivity.offsets.clear()
        mainActivity.offsets.putAll(adjusted)
    }

    private fun setupSyncPlayer(mainActivity: MainActivity) {
        // Create player views for each video
        for ((index, video) in mainActivity.videos.withIndex()) {
            val playerView = PlayerView(requireContext()).apply {
                useController = false
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    200
                )
            }

            val exoPlayer = syncPlayer.addVideo(video, mainActivity.offsets[video.id] ?: 0.0)
            playerView.player = exoPlayer
            videoViews[video.id] = playerView

            // Add to layout
            binding.videoContainer.addView(playerView)
        }

        // Update offset display
        updateOffsetDisplay(mainActivity)

        // Update time slider range
        val maxDuration = mainActivity.videos.maxOfOrNull { it.duration } ?: 0.0
        binding.timeSlider.valueTo = maxDuration.toFloat()

        // Load videos
        for (entry in syncPlayer.getPlayers()) {
            entry.exoPlayer.prepare()
        }
    }

    private fun startSync() {
        isPlaying = true
        binding.btnSyncPlay.text = "Pause"
        syncPlayer.startSyncPlay()

        // Update time display
        lifecycleScope.launch {
            while (isPlaying) {
                val time = syncPlayer.currentTime.value
                binding.timeDisplay.text = "%.1fs".format(time)
                binding.timeSlider.value = time.toFloat()
                kotlinx.coroutines.delay(100)
            }
        }
    }

    private fun pauseSync() {
        isPlaying = false
        binding.btnSyncPlay.text = "Play"
        syncPlayer.pauseSyncPlay()
    }

    private fun updateOffsetDisplay(mainActivity: MainActivity) {
        val offsetText = mainActivity.videos.mapIndexed { index, video ->
            val offset = mainActivity.offsets[video.id] ?: 0.0
            val name = video.name.substringBeforeLast(".")
            if (index == 0) "$name: Base" else "$name: +${offset.toFixed(3)}s"
        }.joinToString(" | ")
        binding.offsetDisplay.text = offsetText
    }

    private fun setupLayoutButtons() {
        val layoutButtons = mapOf(
            binding.layoutVertical to VideoExporter.Layout.VERTICAL,
            binding.layoutHorizontal to VideoExporter.Layout.HORIZONTAL,
            binding.layoutTop1Bottom2 to VideoExporter.Layout.TOP1_BOTTOM2,
            binding.layoutTop2Bottom1 to VideoExporter.Layout.TOP2_BOTTOM1,
            binding.layoutGrid4 to VideoExporter.Layout.GRID_4
        )

        for ((button, layout) in layoutButtons) {
            button.setOnClickListener {
                // Deselect all
                layoutButtons.keys.forEach { it.isSelected = false }
                button.isSelected = true
            }
        }

        // Default selection
        binding.layoutVertical.isSelected = true
    }

    private fun exportVideo(mainActivity: MainActivity) {
        if (isPlaying) pauseSync()

        binding.btnExport.isEnabled = false
        binding.btnExport.text = "Exporting..."

        lifecycleScope.launch {
            try {
                val config = VideoExporter.ExportConfig(
                    resolution = 1080,
                    fps = 30,
                    bitrateMultiplier = 1.0,
                    layout = getSelectedLayout()
                )

                val videos = mainActivity.videos.map { video ->
                    Pair(video, video.uri)
                }

                val outputFile = withContext(Dispatchers.Default) {
                    videoExporter.export(
                        videos = videos,
                        offsets = mainActivity.offsets,
                        config = config,
                        onProgress = { progress ->
                            launch(Dispatchers.Main) {
                                binding.exportProgress.text = progress
                            }
                        }
                    )
                }

                if (outputFile != null) {
                    binding.exportProgress.text = "Export complete: ${outputFile.name}"
                    Toast.makeText(requireContext(), "Export saved to ${outputFile.absolutePath}", Toast.LENGTH_LONG).show()

                    // Share file
                    val uri = androidx.core.content.FileProvider.getUriForFile(
                        requireContext(),
                        "${requireContext().packageName}.fileprovider",
                        outputFile
                    )
                    val shareIntent = Intent(Intent.ACTION_SEND).apply {
                        type = "video/mp4"
                        putExtra(Intent.EXTRA_STREAM, uri)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    startActivity(Intent.createChooser(shareIntent, "Share video"))
                } else {
                    binding.exportProgress.text = "Export failed"
                }
            } catch (e: Exception) {
                binding.exportProgress.text = "Export failed: ${e.message}"
            } finally {
                binding.btnExport.isEnabled = true
                binding.btnExport.text = "Export MP4"
            }
        }
    }

    private fun getSelectedLayout(): VideoExporter.Layout {
        return when {
            binding.layoutHorizontal.isSelected -> VideoExporter.Layout.HORIZONTAL
            binding.layoutTop1Bottom2.isSelected -> VideoExporter.Layout.TOP1_BOTTOM2
            binding.layoutTop2Bottom1.isSelected -> VideoExporter.Layout.TOP2_BOTTOM1
            binding.layoutGrid4.isSelected -> VideoExporter.Layout.GRID_4
            else -> VideoExporter.Layout.VERTICAL
        }
    }

    private fun Double.toFixed(decimals: Int): String {
        return "%.${decimals}f".format(this)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        if (isPlaying) pauseSync()
        syncPlayer.release()
        ocrEngine.release()
        _binding = null
    }
}
