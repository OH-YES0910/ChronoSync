package com.chronosync.ui

import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.chronosync.R
import com.chronosync.models.VideoInfo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * RecyclerView adapter for displaying selected videos in Step 1.
 */
class VideoListAdapter(
    private val videos: List<VideoInfo>,
    private val onRemove: (VideoInfo) -> Unit
) : RecyclerView.Adapter<VideoListAdapter.ViewHolder>() {

    class ViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        val thumbnail: ImageView = view.findViewById(R.id.videoThumbnail)
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
        
        // Load video thumbnail asynchronously
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val retriever = MediaMetadataRetriever()
                retriever.setDataSource(holder.itemView.context, video.uri)
                val bitmap = retriever.getFrameAtTime(1_000_000) // 1 second
                retriever.release()
                
                withContext(Dispatchers.Main) {
                    if (bitmap != null) {
                        holder.thumbnail.setImageBitmap(bitmap)
                    }
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    override fun getItemCount(): Int = videos.size
}
