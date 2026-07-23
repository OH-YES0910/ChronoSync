package com.chronosync.ui.steps

import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.chronosync.MainActivity
import com.chronosync.core.AutoDetectService
import com.chronosync.databinding.FragmentStep2Binding
import com.chronosync.models.TimerRegion
import com.chronosync.ui.RegionSelectorView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Step 2: Region selection.
 * - Show video preview with region selector
 * - Auto-detect timer region button
 * - Manual region selection via drag
 * - Random seek slider
 * - "Next" button enabled when all videos have regions
 */
class Step2RegionFragment : Fragment() {

    private var _binding: FragmentStep2Binding? = null
    private val binding get() = _binding!!
    private val autoDetectService = AutoDetectService()

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentStep2Binding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        val mainActivity = requireActivity() as MainActivity

        // Setup video panels for each video
        for ((index, video) in mainActivity.videos.withIndex()) {
            val panelView = createVideoPanel(video.id, video.name, index)
            binding.videoPanelContainer.addView(panelView)

            // Load video preview
            val regionSelector = panelView.findViewById<RegionSelectorView>(com.chronosync.R.id.regionSelector)
            val seekBar = panelView.findViewById<com.google.android.material.slider.Slider>(com.chronosync.R.id.seekSlider)
            val statusText = panelView.findViewById<android.widget.TextView>(com.chronosync.R.id.statusText)
            val autoDetectBtn = panelView.findViewById<com.google.android.material.button.MaterialButton>(com.chronosync.R.id.btnAutoDetect)

            // Setup region selector callback
            regionSelector.setOnRegionSelectedListener { region ->
                mainActivity.regions[video.id] = region
                statusText.text = "Region: x=${region.x}% y=${region.y}% w=${region.w}% h=${region.h}%"
                statusText.setTextColor(resources.getColor(com.chronosync.R.color.success, null))
                updateNextButton()
            }

            // Setup seek bar
            seekBar.addOnChangeListener { _, value, fromUser ->
                if (fromUser) {
                    // Seek video to position (would need ExoPlayer here for actual seeking)
                }
            }

            // Setup auto-detect button
            autoDetectBtn.setOnClickListener {
                autoDetectForVideo(video.id, regionSelector, statusText)
            }

            // Restore existing region if any
            mainActivity.regions[video.id]?.let { region ->
                regionSelector.setRegion(region)
                statusText.text = "Region: x=${region.x}% y=${region.y}% w=${region.w}% h=${region.h}%"
                statusText.setTextColor(resources.getColor(com.chronosync.R.color.success, null))
            }
        }

        // Auto-detect all button
        binding.btnAutoDetectAll.setOnClickListener {
            for ((index, video) in mainActivity.videos.withIndex()) {
                val panelView = binding.videoPanelContainer.getChildAt(index)
                val regionSelector = panelView.findViewById<RegionSelectorView>(com.chronosync.R.id.regionSelector)
                val statusText = panelView.findViewById<android.widget.TextView>(com.chronosync.R.id.statusText)
                autoDetectForVideo(video.id, regionSelector, statusText)
            }
        }

        // Back button
        binding.btnBack.setOnClickListener {
            mainActivity.goToStepClear(1)
        }

        // Next button
        binding.btnNext.setOnClickListener {
            if (allRegionsSet()) {
                mainActivity.goToStep(3)
            }
        }

        updateNextButton()
    }

    private fun autoDetectForVideo(
        videoId: String,
        regionSelector: RegionSelectorView,
        statusText: android.widget.TextView
    ) {
        val mainActivity = requireActivity() as MainActivity
        val video = mainActivity.videos.find { it.id == videoId } ?: return

        statusText.text = "Auto-detecting timer..."
        statusText.setTextColor(resources.getColor(com.chronosync.R.color.text_secondary, null))

        lifecycleScope.launch {
            try {
                val region = withContext(Dispatchers.Default) {
                    detectTimerRegion(video.uri)
                }

                if (region != null) {
                    mainActivity.regions[videoId] = region
                    regionSelector.setRegion(region)
                    statusText.text = "Detected: x=${region.x}% y=${region.y}% w=${region.w}% h=${region.h}%"
                    statusText.setTextColor(resources.getColor(com.chronosync.R.color.success, null))
                } else {
                    statusText.text = "No timer detected. Please select manually."
                    statusText.setTextColor(resources.getColor(com.chronosync.R.color.warning, null))
                }
                updateNextButton()
            } catch (e: Exception) {
                statusText.text = "Detection failed: ${e.message}"
                statusText.setTextColor(resources.getColor(com.chronosync.R.color.error, null))
            }
        }
    }

    private suspend fun detectTimerRegion(videoUri: Uri): TimerRegion? {
        return withContext(Dispatchers.Default) {
            val retriever = MediaMetadataRetriever()
            try {
                retriever.setDataSource(requireContext(), videoUri)

                val widthStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
                val heightStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
                val durationStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)

                val vw = widthStr?.toIntOrNull() ?: return@withContext null
                val vh = heightStr?.toIntOrNull() ?: return@withContext null
                val duration = (durationStr?.toDoubleOrNull() ?: 0.0) / 1000.0

                if (duration <= 0) return@withContext null

                // Sample 8 frames (matching web version)
                val frames = mutableListOf<Pair<Double, Bitmap>>()
                for (i in 0 until 8) {
                    val t = duration * (0.1 + 0.8 * i / 7)
                    if (t > 1 && t < duration - 1) {
                        val bitmap = retriever.getFrameAtTime(
                            (t * 1_000_000).toLong(),
                            MediaMetadataRetriever.OPTION_CLOSEST_SYNC
                        )
                        if (bitmap != null) {
                            frames.add(Pair(t, bitmap))
                        }
                    }
                }

                val result = autoDetectService.autoDetectFromFrames(frames, vw, vh)

                // Cleanup bitmaps
                frames.forEach { it.second.recycle() }

                result
            } catch (e: Exception) {
                e.printStackTrace()
                null
            } finally {
                try { retriever.release() } catch (_: Exception) {}
            }
        }
    }

    private fun createVideoPanel(videoId: String, videoName: String, index: Int): View {
        val context = requireContext()
        val panel = android.widget.LinearLayout(context).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(16, 16, 16, 16)
            setBackgroundColor(android.graphics.Color.parseColor("#1E1E1E"))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).also {
                (it as ViewGroup.MarginLayoutParams).bottomMargin = 16
            }
        }

        // Video name header
        val header = android.widget.TextView(context).apply {
            text = "Video ${index + 1}: $videoName"
            setTextColor(android.graphics.Color.WHITE)
            textSize = 16f
            setPadding(0, 0, 0, 8)
        }
        panel.addView(header)

        // Region selector view
        val selector = RegionSelectorView(context).apply {
            id = com.chronosync.R.id.regionSelector
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                300
            )
        }
        panel.addView(selector)

        // Seek bar
        val seekBar = com.google.android.material.slider.Slider(context).apply {
            id = com.chronosync.R.id.seekSlider
            valueFrom = 0f
            valueTo = 100f
            stepSize = 1f
            value = 10f
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        panel.addView(seekBar)

        // Controls row
        val controlsRow = android.widget.LinearLayout(context).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
            setPadding(0, 8, 0, 8)
        }

        // Auto-detect button
        val autoDetectBtn = com.google.android.material.button.MaterialButton(context).apply {
            id = com.chronosync.R.id.btnAutoDetect
            text = "Auto-Detect"
            layoutParams = android.widget.LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                1f
            ).also {
                it.marginEnd = 8
            }
        }
        controlsRow.addView(autoDetectBtn)

        // Random seek button
        val randomBtn = com.google.android.material.button.MaterialButton(context).apply {
            text = "Random"
            layoutParams = android.widget.LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                1f
            )
        }
        randomBtn.setOnClickListener {
            val seekBar = panel.findViewById<com.google.android.material.slider.Slider>(com.chronosync.R.id.seekSlider)
            seekBar.value = (Math.random() * 80 + 10).toFloat()
        }
        controlsRow.addView(randomBtn)

        panel.addView(controlsRow)

        // Status text
        val statusText = android.widget.TextView(context).apply {
            id = com.chronosync.R.id.statusText
            text = "No region selected"
            setTextColor(android.graphics.Color.parseColor("#888888"))
            textSize = 12f
            setPadding(0, 4, 0, 0)
        }
        panel.addView(statusText)

        return panel
    }

    private fun allRegionsSet(): Boolean {
        val mainActivity = requireActivity() as MainActivity
        return mainActivity.videos.all { mainActivity.regions.containsKey(it.id) }
    }

    private fun updateNextButton() {
        binding.btnNext.isEnabled = allRegionsSet()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
