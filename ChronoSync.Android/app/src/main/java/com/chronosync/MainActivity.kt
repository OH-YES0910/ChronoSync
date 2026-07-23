package com.chronosync

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import com.chronosync.databinding.ActivityMainBinding
import com.chronosync.models.VideoInfo
import com.chronosync.models.TimerRegion
import com.chronosync.models.CalibrationPoint
import com.chronosync.models.OffsetResult
import com.chronosync.ui.steps.Step1VideoSelectionFragment
import com.chronosync.ui.steps.Step2RegionFragment
import com.chronosync.ui.steps.Step3AnalysisFragment

/**
 * Main Activity hosting the 3-step workflow.
 * Step 1: Select videos
 * Step 2: Select timer regions
 * Step 3: Analyze + sync playback + export
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    // Shared state across fragments
    val videos = mutableListOf<VideoInfo>()
    val regions = mutableMapOf<String, TimerRegion>()
    val frames = mutableMapOf<String, List<CalibrationPoint>>()
    val offsets = mutableMapOf<String, Double>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        if (savedInstanceState == null) {
            supportFragmentManager.beginTransaction()
                .replace(R.id.fragmentContainer, Step1VideoSelectionFragment())
                .commit()
        }
    }

    /**
     * Navigate to next step fragment.
     */
    fun goToStep(step: Int) {
        val fragment: Fragment = when (step) {
            1 -> Step1VideoSelectionFragment()
            2 -> Step2RegionFragment()
            3 -> Step3AnalysisFragment()
            else -> return
        }

        supportFragmentManager.beginTransaction()
            .setCustomAnimations(
                R.anim.slide_in_right,
                R.anim.slide_out_left,
                R.anim.slide_in_left,
                R.anim.slide_out_right
            )
            .replace(R.id.fragmentContainer, fragment)
            .addToBackStack(null)
            .commit()
    }

    /**
     * Navigate back to a specific step, clearing back stack.
     */
    fun goToStepClear(step: Int) {
        supportFragmentManager.popBackStack(null, androidx.fragment.app.FragmentManager.POP_BACK_STACK_INCLUSIVE)
        goToStep(step)
    }

    override fun onDestroy() {
        super.onDestroy()
        videos.clear()
        regions.clear()
        frames.clear()
        offsets.clear()
    }
}
