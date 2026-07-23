package com.chronosync.ui

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.chronosync.R
import com.chronosync.models.VideoInfo

/**
 * RecyclerView adapter for displaying selected videos in Step 1.
 */
class VideoListAdapter(
    private val videos: List<VideoInfo>,
    private val onRemove: (VideoInfo) -> Unit
) : RecyclerView.Adapter<VideoListAdapter.ViewHolder>() {

    class ViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        val icon: View = view.findViewById(R.id.videoIcon)
        val name: TextView = view.findViewById(R.id.videoName)
        val removeBtn: ImageButton = view.findViewById(R.id.btnRemove)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_video_list, parent, false)
        return ViewHolder(view)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val video = videos[position]
        holder.name.text = video.name
        holder.removeBtn.setOnClickListener {
            onRemove(video)
        }
    }

    override fun getItemCount(): Int = videos.size
}
