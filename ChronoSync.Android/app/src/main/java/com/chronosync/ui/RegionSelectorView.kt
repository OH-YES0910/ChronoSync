package com.chronosync.ui

import android.content.Context
import android.graphics.*
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import com.chronosync.models.TimerRegion
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Custom view for selecting timer region via drag gesture.
 * Supports both mouse and touch input (matching web version's setupRegionDrag).
 */
class RegionSelectorView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    private var onRegionSelected: ((TimerRegion) -> Unit)? = null

    // Selection box coordinates (in view pixels)
    private var startX = 0f
    private var startY = 0f
    private var currentX = 0f
    private var currentY = 0f
    private var isDragging = false

    // Stored region (in percentages)
    private var region: TimerRegion? = null

    // Paint for selection box
    private val boxPaint = Paint().apply {
        color = Color.parseColor("#FF6B35")
        style = Paint.Style.STROKE
        strokeWidth = 3f
        isAntiAlias = true
    }

    private val fillPaint = Paint().apply {
        color = Color.parseColor("#33FF6B35")
        style = Paint.Style.FILL
        isAntiAlias = true
    }

    private val textPaint = Paint().apply {
        color = Color.WHITE
        textSize = 24f
        isAntiAlias = true
        setShadowLayer(2f, 1f, 1f, Color.BLACK)
    }

    private val bgPaint = Paint().apply {
        color = Color.parseColor("#1A1A1A")
        style = Paint.Style.FILL
    }

    fun setOnRegionSelectedListener(listener: (TimerRegion) -> Unit) {
        onRegionSelected = listener
    }

    fun setRegion(region: TimerRegion) {
        this.region = region
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)

        // Draw dark background
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bgPaint)

        // Draw grid lines for reference
        val gridPaint = Paint().apply {
            color = Color.parseColor("#333333")
            strokeWidth = 1f
        }
        for (i in 1..4) {
            val x = width * i / 5f
            canvas.drawLine(x, 0f, x, height.toFloat(), gridPaint)
            val y = height * i / 5f
            canvas.drawLine(0f, y, width.toFloat(), y, gridPaint)
        }

        // Draw stored region
        region?.let { r ->
            val left = r.x / 100f * width
            val top = r.y / 100f * height
            val right = (r.x + r.w) / 100f * width
            val bottom = (r.y + r.h) / 100f * height

            canvas.drawRect(left, top, right, bottom, fillPaint)
            canvas.drawRect(left, top, right, bottom, boxPaint)

            // Draw region info text
            val infoText = "x=${r.x}% y=${r.y}% w=${r.w}% h=${r.h}%"
            canvas.drawText(infoText, left + 8, top - 8, textPaint)
        }

        // Draw current drag selection
        if (isDragging) {
            val left = min(startX, currentX)
            val top = min(startY, currentY)
            val right = max(startX, currentX)
            val bottom = max(startY, currentY)

            canvas.drawRect(left, top, right, bottom, fillPaint)
            canvas.drawRect(left, top, right, bottom, boxPaint)

            // Draw drag dimensions
            val wPct = abs(currentX - startX) / width * 100
            val hPct = abs(currentY - startY) / height * 100
            val dragText = "%.1f%% x %.1f%%".format(wPct, hPct)
            canvas.drawText(dragText, left + 8, top - 8, textPaint)
        }

        // Draw hint if no region
        if (region == null && !isDragging) {
            val hintPaint = Paint().apply {
                color = Color.parseColor("#666666")
                textSize = 20f
                isAntiAlias = true
                textAlign = Paint.Align.CENTER
            }
            canvas.drawText("Drag to select timer region", width / 2f, height / 2f, hintPaint)
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.action) {
            MotionEvent.ACTION_DOWN -> {
                startX = event.x
                startY = event.y
                currentX = event.x
                currentY = event.y
                isDragging = true
                invalidate()
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (isDragging) {
                    currentX = event.x
                    currentY = event.y
                    invalidate()
                    return true
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (isDragging) {
                    isDragging = false

                    // Calculate region percentages
                    val left = min(startX, currentX)
                    val top = min(startY, currentY)
                    val right = max(startX, currentX)
                    val bottom = max(startY, currentY)

                    val wPct = (abs(right - left) / width * 100).let { (it * 10).toInt() / 10f }
                    val hPct = (abs(bottom - top) / height * 100).let { (it * 10).toInt() / 10f }

                    // Minimum size check (matching web version: w >= 2 && h >= 2)
                    if (wPct >= 2f && hPct >= 2f) {
                        val xPct = (left / width * 100).let { (it * 10).toInt() / 10f }
                        val yPct = (top / height * 100).let { (it * 10).toInt() / 10f }

                        val newRegion = TimerRegion(
                            x = xPct.coerceIn(0f, 100f),
                            y = yPct.coerceIn(0f, 100f),
                            w = wPct.coerceIn(0f, 100f - xPct),
                            h = hPct.coerceIn(0f, 100f - yPct)
                        )

                        region = newRegion
                        onRegionSelected?.invoke(newRegion)
                    }

                    invalidate()
                    return true
                }
            }
        }
        return super.onTouchEvent(event)
    }
}
