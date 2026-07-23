using System.Collections.Concurrent;
using ChronoSync.Windows.Models;
using OpenCvSharp;

namespace ChronoSync.Windows.Services;

/// <summary>
/// Frame extraction and OCR calibration point collection.
/// Uses Parallel.ForEach for frame extraction and concurrent OCR
/// with a thread-safe pool of OcrService instances.
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
    private const int OcrConcurrency = 4;

    /// <summary>
    /// Extract calibration points from a video using parallel frame extraction
    /// and concurrent OCR processing.
    /// </summary>
    /// <param name="videoPath">Path to the video file</param>
    /// <param name="region">Timer region to OCR</param>
    /// <param name="ocrService">Initialized OCR service (used as template)</param>
    /// <param name="onProgress">Progress callback</param>
    /// <returns>List of calibration points (videoTime, timerValue)</returns>
    public static List<CalibrationPoint> ExtractFrames(
        string videoPath,
        TimerRegion region,
        OcrService ocrService,
        Action<string>? onProgress = null)
    {
        // Probe video metadata
        int fps;
        double duration;
        using (var probeCapture = new VideoCapture(videoPath))
        {
            if (!probeCapture.IsOpened()) return [];
            fps = (int)probeCapture.Get(VideoCaptureProperties.Fps);
            double frameCount = probeCapture.Get(VideoCaptureProperties.FrameCount);
            duration = fps > 0 ? frameCount / fps : 0;
        }

        if (duration < 2) return [];

        double usableStart = duration * 0.05;
        double usableEnd = duration * 0.95;

        // Generate all random sample times upfront
        var sampleTimes = GenerateSampleTimes(usableStart, usableEnd, MaxSamples);

        onProgress?.Invoke($"并行提取 {sampleTimes.Count} 帧...");

        // Phase 1: Extract all frames in parallel (each opens its own VideoCapture)
        var extractedFrames = ExtractAllFramesInParallel(
            videoPath, sampleTimes, fps, duration);

        onProgress?.Invoke($"并发OCR处理中... ({extractedFrames.Count} 帧)");

        // Phase 2: Process OCR concurrently with pool of OcrService instances
        var calibPoints = ProcessOcrConcurrently(
            extractedFrames, region, onProgress);

        if (calibPoints.Count < MinCalibPoints)
        {
            onProgress?.Invoke(
                $"警告: 仅获得 {calibPoints.Count} 个校准点 (需要 ≥{MinCalibPoints})");
        }

        return calibPoints;
    }

    /// <summary>
    /// Generate random sample times within the usable range.
    /// Matching app.js random sampling logic.
    /// </summary>
    private static List<double> GenerateSampleTimes(
        double usableStart, double usableEnd, int maxSamples)
    {
        var times = new List<double>(maxSamples);
        var usedTimes = new HashSet<int>();
        var random = new Random();

        for (int i = 0; i < maxSamples; i++)
        {
            for (int attempt = 0; attempt < 200; attempt++)
            {
                double t = usableStart + random.NextDouble() * (usableEnd - usableStart);
                int key = (int)(t * 1000);
                if (usedTimes.Add(key))
                {
                    times.Add(t);
                    break;
                }
            }
        }

        return times;
    }

    /// <summary>
    /// Extract all frames in parallel using Parallel.ForEach.
    /// Each iteration opens its own VideoCapture for thread-safe isolation.
    /// Supports retry at time+0.05s on empty frames.
    /// </summary>
    private static List<(double Time, Mat Frame)> ExtractAllFramesInParallel(
        string videoPath,
        List<double> sampleTimes,
        int fps,
        double duration)
    {
        var results = new ConcurrentBag<(double Time, Mat Frame)>();

        // Parallel.ForEach with default degree of parallelism (ProcessorCount)
        Parallel.ForEach(sampleTimes, time =>
        {
            // Each iteration opens its own capture for thread safety
            using var capture = new VideoCapture(videoPath);
            if (!capture.IsOpened()) return;

            int targetFrame = (int)(time * fps);
            capture.Set(VideoCaptureProperties.PosFrames, targetFrame);

            using var frame = new Mat();
            if (capture.Read(frame) && !frame.Empty())
            {
                var copy = new Mat();
                Cv2.CopyTo(frame, copy);
                results.Add((time, copy));
                return;
            }

            // Retry at time + 0.05s (matching app.js)
            double retryTime = Math.Min(time + 0.05, duration - 0.01);
            int retryFrame = (int)(retryTime * fps);
            capture.Set(VideoCaptureProperties.PosFrames, retryFrame);

            using var retryFrameMat = new Mat();
            if (capture.Read(retryFrameMat) && !retryFrameMat.Empty())
            {
                var retryCopy = new Mat();
                Cv2.CopyTo(retryFrameMat, retryCopy);
                results.Add((time, retryCopy));
            }
        });

        return results.ToList();
    }

    /// <summary>
    /// Process OCR on extracted frames concurrently using Parallel.ForEach
    /// with SemaphoreSlim for concurrency control. Creates a pool of OcrService
    /// instances since TesseractEngine is not thread-safe.
    /// </summary>
    private static List<CalibrationPoint> ProcessOcrConcurrently(
        List<(double Time, Mat Frame)> extractedFrames,
        TimerRegion region,
        Action<string>? onProgress)
    {
        if (extractedFrames.Count == 0) return [];

        // Create OCR pool: TesseractEngine is not thread-safe,
        // so we need separate instances for concurrent access
        int poolSize = Math.Min(OcrConcurrency, extractedFrames.Count);
        var ocrPool = new OcrService[poolSize];
        for (int i = 0; i < poolSize; i++)
        {
            ocrPool[i] = new OcrService();
            ocrPool[i].Initialize();
        }

        var calibPoints = new ConcurrentBag<CalibrationPoint>();
        var ocrSemaphore = new SemaphoreSlim(poolSize, poolSize);
        int poolCounter = -1;

        try
        {
            // Parallel.ForEach with SemaphoreSlim for bounded concurrency
            Parallel.ForEach(extractedFrames, item =>
            {
                ocrSemaphore.Wait();
                try
                {
                    // Round-robin through OCR pool for load balancing
                    int poolIdx = Interlocked.Increment(ref poolCounter) % poolSize;
                    var ocr = ocrPool[poolIdx];

                    var result = ocr.ReadTimerValue(item.Frame, region);

                    if (result.Value is not null)
                    {
                        calibPoints.Add(new CalibrationPoint
                        {
                            VideoTime = item.Time,
                            TimerValue = result.Value.Value
                        });
                    }

                    onProgress?.Invoke(
                        $"帧采样中... t={item.Time:F2}s " +
                        $"({calibPoints.Count} 个有效校准点)");
                }
                finally
                {
                    item.Frame.Dispose();
                    ocrSemaphore.Release();
                }
            });
        }
        finally
        {
            foreach (var ocr in ocrPool)
                ocr?.Dispose();
        }

        // Sort by time and take up to MinCalibPoints
        return calibPoints
            .OrderBy(p => p.VideoTime)
            .Take(MinCalibPoints)
            .ToList();
    }
}
