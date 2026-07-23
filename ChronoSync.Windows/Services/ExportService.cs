using System.IO;
using System.Threading.Channels;
using ChronoSync.Windows.Models;
using OpenCvSharp;

namespace ChronoSync.Windows.Services;

/// <summary>
/// Video export service using OpenCV to draw frames and FFMpegCore to encode.
/// Uses parallel frame extraction via Channels producer-consumer pattern.
/// </summary>
public static class ExportService
{
    public enum Layout
    {
        Vertical,      // 竖向
        Horizontal,    // 横向
        Top1Bottom2,   // 上1下2
        Top2Bottom1,   // 上2下1
        Grid4          // 2x2网格
    }

    /// <summary>
    /// An extracted frame from a specific video at a specific time index.
    /// </summary>
    private sealed record FrameData(int FrameIndex, int VideoIndex, Mat Frame);

    /// <summary>
    /// Export synchronized comparison video with parallel frame extraction.
    /// </summary>
    public static async Task ExportAsync(
        List<VideoExportData> videos,
        Dictionary<string, double> offsets,
        Layout layout,
        int targetHeight = 1080,
        int targetFps = 30,
        string? outputPath = null,
        Action<string>? onProgress = null,
        CancellationToken ct = default)
    {
        if (videos.Count < 2)
            throw new Exception("需要至少2个视频");

        outputPath ??= Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.MyVideos),
            $"ChronoSync_{DateTime.Now:yyyyMMdd_HHmmss}.mp4");

        onProgress?.Invoke("并行加载视频...");

        // Phase 1: Load all video captures in parallel
        var captures = await LoadCapturesInParallelAsync(videos, ct);

        try
        {
            // Get base video dimensions from first capture
            int rawW = captures[0].FrameWidth;
            int rawH = captures[0].FrameHeight;
            double scale = Math.Min((double)targetHeight / rawH, 1.0);
            int vw = (int)Math.Round(rawW * scale);
            int vh = (int)Math.Round(rawH * scale);

            // Calculate canvas size based on layout
            var (canvasW, canvasH) = CalculateCanvasSize(layout, videos.Count, vw, vh);

            // Calculate export timing
            double baseOffset = offsets.TryGetValue(videos[0].Id, out var bo) ? bo : 0;
            double exportStartTime = Math.Max(0, -baseOffset);
            double maxEndTime = 0;
            foreach (var v in videos)
            {
                double off = offsets.TryGetValue(v.Id, out var o) ? o : 0;
                double ve = v.Duration - off;
                if (ve > maxEndTime) maxEndTime = ve;
            }
            double totalDuration = maxEndTime - exportStartTime;
            int totalFrames = (int)Math.Ceiling(totalDuration * targetFps);
            double frameInterval = 1.0 / targetFps;

            onProgress?.Invoke(
                $"画布: {canvasW}x{canvasH} @ {targetFps}fps, 共{totalFrames}帧 (并行抽帧)");

            // Setup temp directory for frames
            string tempDir = Path.Combine(
                Path.GetTempPath(), $"chronosync_export_{Guid.NewGuid():N}");
            Directory.CreateDirectory(tempDir);

            try
            {
                // Phase 2: Parallel frame extraction via Channels producer-consumer
                await ExtractAndComposeFramesAsync(
                    captures, videos, offsets, layout,
                    vw, vh, canvasW, canvasH,
                    exportStartTime, frameInterval, totalFrames,
                    targetFps, tempDir, onProgress, ct);

                // Phase 3: FFmpeg encoding
                onProgress?.Invoke("FFmpeg编码中...");
                await RunFfmpegAsync(targetFps, tempDir, outputPath, onProgress, ct);

                onProgress?.Invoke($"导出完成: {outputPath}");
            }
            finally
            {
                if (Directory.Exists(tempDir))
                    Directory.Delete(tempDir, true);
            }
        }
        finally
        {
            foreach (var cap in captures)
                cap.Dispose();
        }
    }

    /// <summary>
    /// Load all video captures in parallel using Task.WhenAll.
    /// </summary>
    private static async Task<List<VideoCapture>> LoadCapturesInParallelAsync(
        List<VideoExportData> videos, CancellationToken ct)
    {
        var loadTasks = videos.Select(v => Task.Run(() =>
        {
            ct.ThrowIfCancellationRequested();
            var cap = new VideoCapture(v.FilePath);
            if (!cap.IsOpened())
            {
                cap.Dispose();
                throw new Exception($"无法打开视频: {v.Name}");
            }
            return cap;
        }, ct)).ToArray();

        return (await Task.WhenAll(loadTasks)).ToList();
    }

    /// <summary>
    /// Parallel frame extraction using Channels producer-consumer pattern.
    /// Producers: one task per video, each extracts frames independently.
    /// Consumer: composes canvas and saves frames sequentially.
    /// Pipeline overlap: producers extract ahead while consumer composes.
    /// </summary>
    private static async Task ExtractAndComposeFramesAsync(
        List<VideoCapture> captures,
        List<VideoExportData> videos,
        Dictionary<string, double> offsets,
        Layout layout,
        int vw, int vh, int canvasW, int canvasH,
        double exportStartTime, double frameInterval, int totalFrames,
        int targetFps, string tempDir,
        Action<string>? onProgress, CancellationToken ct)
    {
        // Bounded channel: limits memory while allowing pipeline overlap
        // Capacity = videos * 4 frames buffered ahead
        int channelCapacity = Math.Min(videos.Count * 4, 32);
        var channel = Channel.CreateBounded<FrameData>(
            new BoundedChannelOptions(channelCapacity)
            {
                SingleReader = true,
                SingleWriter = false,
                FullMode = BoundedChannelFullMode.Wait
            });

        // Start parallel extraction producers (one per video)
        var producers = new Task[videos.Count];
        for (int vi = 0; vi < videos.Count; vi++)
        {
            int videoIndex = vi;
            var video = videos[videoIndex];
            var capture = captures[videoIndex];
            double videoOffset = offsets.TryGetValue(video.Id, out var o) ? o : 0;

            producers[vi] = Task.Run(
                () => ExtractVideoFramesAsync(
                    capture, videoIndex, video, videoOffset,
                    exportStartTime, frameInterval, totalFrames,
                    vw, vh, channel.Writer, ct),
                ct);
        }

        // Signal channel completion when all producers finish
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.WhenAll(producers);
            }
            catch (Exception ex)
            {
                channel.Writer.TryComplete(ex);
                return;
            }
            channel.Writer.TryComplete();
        }, ct);

        // Consumer: read from channel, compose canvas, save frames
        await ComposeFramesFromChannelAsync(
            channel.Reader, videos.Count, layout, vw, vh,
            canvasW, canvasH, totalFrames, targetFps, tempDir,
            onProgress, ct);
    }

    /// <summary>
    /// Producer: Extract all frames from a single video and write to channel.
    /// Each producer has its own VideoCapture (thread-safe isolation).
    /// WriteAsync provides backpressure via the bounded channel.
    /// </summary>
    private static async Task ExtractVideoFramesAsync(
        VideoCapture capture, int videoIndex, VideoExportData video,
        double videoOffset, double exportStartTime, double frameInterval,
        int totalFrames, int vw, int vh,
        ChannelWriter<FrameData> writer, CancellationToken ct)
    {
        for (int fi = 0; fi < totalFrames; fi++)
        {
            ct.ThrowIfCancellationRequested();

            double time = exportStartTime + fi * frameInterval;
            double target = Math.Max(
                0.01,
                Math.Min(video.Duration - 0.01, time + videoOffset));
            capture.Set(VideoCaptureProperties.PosMsec, target * 1000);

            Mat frame;
            using (var rawFrame = new Mat())
            {
                if (capture.Read(rawFrame) && !rawFrame.Empty())
                {
                    frame = ResizeFrame(rawFrame, vw, vh);
                }
                else
                {
                    // Black frame placeholder for missing frames
                    frame = new Mat(vh, vw, MatType.CV_8UC3, Scalar.All(0));
                }
            }

            // WriteAsync blocks if channel is full (backpressure)
            await writer.WriteAsync(new FrameData(fi, videoIndex, frame), ct);
        }
    }

    /// <summary>
    /// Consumer: Read frames from channel, buffer by frame index,
    /// compose canvas when all videos' frames arrive, save to disk.
    /// Frames may arrive out-of-order from different producers.
    /// </summary>
    private static async Task ComposeFramesFromChannelAsync(
        ChannelReader<FrameData> reader, int videoCount, Layout layout,
        int vw, int vh, int canvasW, int canvasH,
        int totalFrames, int targetFps, string tempDir,
        Action<string>? onProgress, CancellationToken ct)
    {
        using var canvas = new Mat(canvasH, canvasW, MatType.CV_8UC3, Scalar.All(0));

        // Buffer frames by frame index until all videos' frames arrive
        var frameBuffers = new Dictionary<int, List<FrameData>>();
        int composedCount = 0;

        await foreach (var fd in reader.ReadAllAsync(ct))
        {
            if (!frameBuffers.TryGetValue(fd.FrameIndex, out var buffer))
            {
                buffer = new List<FrameData>(videoCount);
                frameBuffers[fd.FrameIndex] = buffer;
            }
            buffer.Add(fd);

            // When all videos' frames for this index are collected, compose
            if (buffer.Count == videoCount)
            {
                canvas.SetTo(Scalar.All(0));
                ComposeCanvasFromBuffers(canvas, buffer, layout, vw, vh);

                string frameFile = Path.Combine(
                    tempDir, $"frame{composedCount:D5}.jpg");
                Cv2.ImWrite(frameFile, canvas);
                composedCount++;

                // Dispose extracted Mats to release memory
                foreach (var f in buffer)
                    f.Frame.Dispose();
                frameBuffers.Remove(fd.FrameIndex);

                if (composedCount % Math.Max(1, targetFps * 2) == 0)
                {
                    int pct = (int)((double)composedCount / totalFrames * 100);
                    onProgress?.Invoke(
                        $"并行抽帧 {pct}% | 帧{composedCount}/{totalFrames}");
                }
            }
        }
    }

    /// <summary>
    /// Compose the canvas from buffered frame data based on layout.
    /// </summary>
    private static void ComposeCanvasFromBuffers(
        Mat canvas, List<FrameData> buffers, Layout layout,
        int vw, int vh)
    {
        // Sort by video index to ensure correct ordering
        buffers.Sort((a, b) => a.VideoIndex.CompareTo(b.VideoIndex));

        switch (layout)
        {
            case Layout.Horizontal:
                for (int i = 0; i < buffers.Count; i++)
                {
                    var roi = new Mat(canvas, new Rect(i * vw, 0, vw, vh));
                    buffers[i].Frame.CopyTo(roi);
                }
                break;

            case Layout.Top1Bottom2 when buffers.Count == 3:
                CopyToRegion(canvas, buffers[0].Frame, (int)(vw * 0.5), 0, vw, vh);
                CopyToRegion(canvas, buffers[1].Frame, 0, vh, vw, vh);
                CopyToRegion(canvas, buffers[2].Frame, vw, vh, vw, vh);
                break;

            case Layout.Top2Bottom1 when buffers.Count == 3:
                CopyToRegion(canvas, buffers[0].Frame, 0, 0, vw, vh);
                CopyToRegion(canvas, buffers[1].Frame, vw, 0, vw, vh);
                CopyToRegion(canvas, buffers[2].Frame, (int)(vw * 0.5), vh, vw, vh);
                break;

            case Layout.Grid4 when buffers.Count == 4:
                for (int i = 0; i < 4; i++)
                {
                    int col = i % 2;
                    int row = i / 2;
                    CopyToRegion(canvas, buffers[i].Frame, col * vw, row * vh, vw, vh);
                }
                break;

            default: // Vertical
                for (int i = 0; i < buffers.Count; i++)
                {
                    CopyToRegion(canvas, buffers[i].Frame, 0, i * vh, vw, vh);
                }
                break;
        }
    }

    /// <summary>
    /// Copy a frame to a specific region on the canvas.
    /// </summary>
    private static void CopyToRegion(
        Mat canvas, Mat frame, int x, int y, int drawW, int drawH)
    {
        var roi = new Mat(canvas, new Rect(
            Math.Max(0, x),
            Math.Max(0, y),
            Math.Min(drawW, canvas.Width - Math.Max(0, x)),
            Math.Min(drawH, canvas.Height - Math.Max(0, y))
        ));
        frame.CopyTo(roi);
    }

    /// <summary>
    /// Calculate canvas dimensions based on layout and video count.
    /// </summary>
    private static (int canvasW, int canvasH) CalculateCanvasSize(
        Layout layout, int videoCount, int vw, int vh)
    {
        return layout switch
        {
            Layout.Horizontal => (vw * videoCount, vh),
            Layout.Top1Bottom2 when videoCount == 3 => (vw * 2, vh * 2),
            Layout.Top2Bottom1 when videoCount == 3 => (vw * 2, vh * 2),
            Layout.Grid4 when videoCount == 4 => (vw * 2, vh * 2),
            _ => (vw, vh * videoCount) // Vertical default
        };
    }

    private static Mat ResizeFrame(Mat frame, int targetW, int targetH)
    {
        var resized = new Mat();
        Cv2.Resize(frame, resized, new Size(targetW, targetH));
        return resized;
    }

    /// <summary>
    /// Run FFmpeg encoding asynchronously as an external process.
    /// </summary>
    private static async Task RunFfmpegAsync(
        int targetFps, string tempDir, string outputPath,
        Action<string>? onProgress, CancellationToken ct)
    {
        string ffmpegPath = FindFfmpeg();

        var psi = new System.Diagnostics.ProcessStartInfo
        {
            FileName = ffmpegPath,
            Arguments = $"-framerate {targetFps} -i \"{tempDir}/frame%05d.jpg\" " +
                       $"-c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p " +
                       $"-movflags +faststart \"{outputPath}\"",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true
        };

        using var process = System.Diagnostics.Process.Start(psi);
        if (process is not null)
        {
            await process.WaitForExitAsync(ct);
            if (process.ExitCode != 0)
            {
                string error = await process.StandardError.ReadToEndAsync(ct);
                throw new Exception($"FFmpeg错误: {error}");
            }
        }
    }

    private static string FindFfmpeg()
    {
        // Check common locations
        string[] paths =
        [
            Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ffmpeg.exe"),
            "ffmpeg",
            @"C:\ffmpeg\bin\ffmpeg.exe",
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "ffmpeg", "bin", "ffmpeg.exe")
        ];

        foreach (var p in paths)
        {
            if (File.Exists(p)) return p;
        }

        // Try PATH
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "where",
                Arguments = "ffmpeg",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                CreateNoWindow = true
            };
            using var proc = System.Diagnostics.Process.Start(psi);
            if (proc is not null)
            {
                string output = proc.StandardOutput.ReadToEnd().Trim();
                proc.WaitForExit();
                if (proc.ExitCode == 0 && !string.IsNullOrEmpty(output))
                    return output.Split('\n')[0].Trim();
            }
        }
        catch { }

        throw new Exception("未找到ffmpeg，请安装并添加到PATH");
    }
}

public sealed class VideoExportData
{
    public required string Id { get; init; }
    public required string FilePath { get; init; }
    public string Name => Path.GetFileName(FilePath);
    public double Duration { get; init; }
}
