using ChronoSync.Windows.Models;
using OpenCvSharp;

namespace ChronoSync.Windows.Services;

/// <summary>
/// Frame extraction and OCR calibration point collection.
/// Replicates app.js extractFrames():
/// - Random sampling, each video at least 3 calibration points (MIN_CALIB_POINTS=3)
/// - Max 30 samples (MAX_SAMPLES=30)
/// - Each frame: try OCR, if fails retry at time+0.05s
/// - Calibration points: [{videoTime, timerValue}]
/// </summary>
public static class FrameExtractionService
{
    private const int MinCalibPoints = 3;
    private const int MaxSamples = 30;

    /// <summary>
    /// Extract calibration points from a video using OCR.
    /// </summary>
    /// <param name="videoPath">Path to the video file</param>
    /// <param name="region">Timer region to OCR</param>
    /// <param name="ocrService">Initialized OCR service</param>
    /// <param name="onProgress">Progress callback</param>
    /// <returns>List of calibration points (videoTime, timerValue)</returns>
    public static List<CalibrationPoint> ExtractFrames(
        string videoPath,
        TimerRegion region,
        OcrService ocrService,
        Action<string>? onProgress = null)
    {
        using var capture = new VideoCapture(videoPath);
        if (!capture.IsOpened()) return [];

        int fps = (int)capture.Get(VideoCaptureProperties.Fps);
        double frameCount = capture.Get(VideoCaptureProperties.FrameCount);
        double duration = fps > 0 ? frameCount / fps : 0;

        if (duration < 2) return [];

        double usableStart = duration * 0.05;
        double usableEnd = duration * 0.95;

        var calibPoints = new List<CalibrationPoint>();
        var usedTimes = new HashSet<int>();
        var random = new Random();

        for (int i = 0; i < MaxSamples && calibPoints.Count < MinCalibPoints; i++)
        {
            // Random sample (matching app.js)
            double? time = null;
            for (int attempt = 0; attempt < 200; attempt++)
            {
                double t = usableStart + random.NextDouble() * (usableEnd - usableStart);
                int key = (int)(t * 1000);
                if (!usedTimes.Contains(key))
                {
                    usedTimes.Add(key);
                    time = t;
                    break;
                }
            }

            if (time is null) continue;

            // Seek to time
            int targetFrame = (int)(time.Value * fps);
            capture.Set(VideoCaptureProperties.PosFrames, targetFrame);

            using var frame = new Mat();
            if (!capture.Read(frame) || frame.Empty()) continue;

            // Try OCR on current frame
            var result = ocrService.ReadTimerValue(frame, region);

            // If failed, retry at time + 0.05s (matching app.js)
            if (result.Value is null)
            {
                double retryTime = Math.Min(time.Value + 0.05, duration - 0.01);
                int retryFrame = (int)(retryTime * fps);
                capture.Set(VideoCaptureProperties.PosFrames, retryFrame);

                using var retryFrameMat = new Mat();
                if (capture.Read(retryFrameMat) && !retryFrameMat.Empty())
                {
                    var retry = ocrService.ReadTimerValue(retryFrameMat, region);
                    if (retry.Value is not null)
                        result = retry;
                }
            }

            onProgress?.Invoke($"帧 {calibPoints.Count + 1} 采样中... t={time.Value:F2}s");

            if (result.Value is not null)
            {
                calibPoints.Add(new CalibrationPoint
                {
                    VideoTime = time.Value,
                    TimerValue = result.Value.Value
                });
            }
        }

        if (calibPoints.Count < MinCalibPoints)
        {
            onProgress?.Invoke($"警告: 仅获得 {calibPoints.Count} 个校准点 (需要 ≥{MinCalibPoints})");
        }

        return calibPoints;
    }
}
