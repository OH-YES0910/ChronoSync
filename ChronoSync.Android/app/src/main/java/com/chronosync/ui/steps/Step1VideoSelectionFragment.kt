package com.chronosync.ui.steps

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import androidx.recyclerview.widget.LinearLayoutManager
import com.chronosync.MainActivity
import com.chronosync.databinding.FragmentStep1Binding
import com.chronosync.models.VideoInfo
import com.chronosync.ui.VideoListAdapter
import java.util.UUID

/**
 * Step 1: Video selection.
 * - Select 2-4 video files (MP4, WebM, MOV)
 * - Display selected video list, can remove
 * - "Next" button enabled when >= 2 videos selected
 */
class Step1VideoSelectionFragment : Fragment() {

    private var _binding: FragmentStep1Binding? = null
    private val binding get() = _binding!!
    private lateinit var adapter: VideoListAdapter
    private val maxVideos = 4

    private val pickVideoLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            result.data?.let { intent ->
                val clipData = intent.clipData
                if (clipData != null) {
                    // Multiple selection
                    for (i in 0 until clipData.itemCount) {
                        addVideo(clipData.getItemAt(i).uri)
                    }
                } else {
                    intent.data?.let { addVideo(it) }
                }
            }
        }
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentStep1Binding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        val mainActivity = requireActivity() as MainActivity

        adapter = VideoListAdapter(
            videos = mainActivity.videos,
            onRemove = { video ->
                mainActivity.videos.remove(video)
                mainActivity.regions.remove(video.id)
                mainActivity.frames.remove(video.id)
                mainActivity.offsets.remove(video.id)
                adapter.notifyDataSetChanged()
                updateNextButton()
            }
        )

        binding.videoList.layoutManager = LinearLayoutManager(requireContext())
        binding.videoList.adapter = adapter

        binding.btnSelectVideo.setOnClickListener {
            if (mainActivity.videos.size >= maxVideos) {
                Toast.makeText(requireContext(), "Maximum $maxVideos videos allowed", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "video/*"
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
            pickVideoLauncher.launch(intent)
        }

        binding.btnNext.setOnClickListener {
            if (mainActivity.videos.size >= 2) {
                mainActivity.goToStep(2)
            }
        }

        updateNextButton()
    }

    private fun addVideo(uri: Uri) {
        val mainActivity = requireActivity() as MainActivity

        if (mainActivity.videos.size >= maxVideos) {
            Toast.makeText(requireContext(), "Maximum $maxVideos videos allowed", Toast.LENGTH_SHORT).show()
            return
        }

        // Get video name from URI
        val name = getFileName(uri)
        val videoInfo = VideoInfo(
            id = UUID.randomUUID().toString(),
            uri = uri,
            name = name
        )

        mainActivity.videos.add(videoInfo)
        adapter.notifyDataSetChanged()
        updateNextButton()
    }

    private fun getFileName(uri: Uri): String {
        var name = "video"
        requireContext().contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (cursor.moveToFirst() && nameIndex >= 0) {
                name = cursor.getString(nameIndex)
            }
        }
        return name
    }

    private fun updateNextButton() {
        val mainActivity = requireActivity() as MainActivity
        binding.btnNext.isEnabled = mainActivity.videos.size >= 2
        binding.videoCount.text = "${mainActivity.videos.size}/$maxVideos videos selected"
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
