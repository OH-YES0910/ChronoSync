using System.IO;
using ChronoSync.Windows.Models;
using OpenCvSharp;

namespace ChronoSync.Windows.Services;

/// <summary>
/// Video export service using OpenCV to draw frames and FFMpegCore to encode.
/// Replicates app.js exportVideo() layout logic.
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
    /// Export synchronized comparison video.
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

        onProgress?.Invoke("加载视频...");

        // Load all videos
        var captures = new List<VideoCapture>();
        try
        {
            foreach (var v in videos)
            {
                var cap = new VideoCapture(v.FilePath);
                if (!cap.IsOpened())
                    throw new Exception($"无法打开视频: {v.Name}");
                captures.Add(cap);
            }

            // Get base video dimensions
            int rawW = captures[0].FrameWidth;
            int rawH = captures[0].FrameHeight;
            double scale = Math.Min((double)targetHeight / rawH, 1.0);
            int vw = (int)Math.Round(rawW * scale);
            int vh = (int)Math.Round(rawH * scale);

            // Calculate canvas size based on layout
            int canvasW, canvasH;
            switch (layout)
            {
                case Layout.Horizontal:
                    canvasW = vw * videos.Count;
                    canvasH = vh;
                    break;
                case Layout.Top1Bottom2 when videos.Count == 3:
                case Layout.Top2Bottom1 when videos.Count == 3:
                    canvasW = vw * 2;
                    canvasH = vh * 2;
                    break;
                case Layout.Grid4 when videos.Count == 4:
                    canvasW = vw * 2;
                    canvasH = vh * 2;
                    break;
                default: // Vertical
                    canvasW = vw;
                    canvasH = vh * videos.Count;
                    break;
            }

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

            onProgress?.Invoke($"画布: {canvasW}x{canvasH} @ {targetFps}fps, 共{totalFrames}帧");

            // Setup temp directory for frames
            string tempDir = Path.Combine(Path.GetTempPath(), $"chronosync_export_{Guid.NewGuid():N}");
            Directory.CreateDirectory(tempDir);

            try
            {
                using var canvas = new Mat(canvasH, canvasW, MatType.CV_8UC3, Scalar.All(0));

                // Extract and save frames
                for (int fi = 0; fi < totalFrames; fi++)
                {
                    ct.ThrowIfCancellationRequested();

                    double time = exportStartTime + fi * frameInterval;

                    // Seek all videos to correct position
                    for (int vi = 0; vi < videos.Count; vi++)
                    {
                        double off = offsets.TryGetValue(videos[vi].Id, out var o) ? o : 0;
                        double target = Math.Max(0.01, Math.Min(videos[vi].Duration - 0.01, time + off));
                        captures[vi].Set(VideoCaptureProperties.PosMsec, target * 1000);
                    }

                    // Draw frames onto canvas based on layout
                    canvas.SetTo(Scalar.All(0));
                    DrawFrames(canvas, captures, videos, layout, vw, vh);

                    // Save frame as JPEG
                    string frameFile = Path.Combine(tempDir, $"frame{fi:D5}.jpg");
                    Cv2.ImWrite(frameFile, canvas);

                    if (fi % Math.Max(1, targetFps * 2) == 0)
                    {
                        int pct = (int)((double)fi / totalFrames * 100);
                        onProgress?.Invoke($"抽帧 {pct}% | 帧{fi}/{totalFrames}");
                    }
                }

                onProgress?.Invoke("FFmpeg编码中...");

                // Use FFMpegCore to encode
                string ffmpegDir = Path.GetDirectoryName(typeof(FFMpegCore.FFMpeg).Assembly.Location) ?? "";
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

                onProgress?.Invoke($"导出完成: {outputPath}");
            }
            finally
            {
                // Cleanup temp frames
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

    private static void DrawFrames(
        Mat canvas,
        List<VideoCapture> captures,
        List<VideoExportData> videos,
        Layout layout,
        int vw,
        int vh)
    {
        switch (layout)
        {
            case Layout.Horizontal:
                for (int i = 0; i < videos.Count; i++)
                {
                    using var frame = new Mat();
                    if (captures[i].Read(frame) && !frame.Empty())
                    {
                        using var resized = ResizeFrame(frame, vw, vh);
                        resized.CopyTo(new Mat(canvas, new Rect(i * vw, 0, vw, vh)));
                    }
                }
                break;

            case Layout.Top1Bottom2 when videos.Count == 3:
                // Video 1: center top
                DrawVideoToRegion(canvas, captures[0], vw, vh, (int)(vw * 0.5), 0, vw, vh);
                // Video 2: bottom left
                DrawVideoToRegion(canvas, captures[1], vw, vh, 0, vh, vw, vh);
                // Video 3: bottom right
                DrawVideoToRegion(canvas, captures[2], vw, vh, vw, vh, vw, vh);
                break;

            case Layout.Top2Bottom1 when videos.Count == 3:
                // Video 1: top left
                DrawVideoToRegion(canvas, captures[0], vw, vh, 0, 0, vw, vh);
                // Video 2: top right
                DrawVideoToRegion(canvas, captures[1], vw, vh, vw, 0, vw, vh);
                // Video 3: center bottom
                DrawVideoToRegion(canvas, captures[2], vw, vh, (int)(vw * 0.5), vh, vw, vh);
                break;

            case Layout.Grid4 when videos.Count == 4:
                for (int i = 0; i < 4; i++)
                {
                    int col = i % 2;
                    int row = i / 2;
                    DrawVideoToRegion(canvas, captures[i], vw, vh, col * vw, row * vh, vw, vh);
                }
                break;

            default: // Vertical
                for (int i = 0; i < videos.Count; i++)
                {
                    DrawVideoToRegion(canvas, captures[i], vw, vh, 0, i * vh, vw, vh);
                }
                break;
        }
    }

    private static void DrawVideoToRegion(
        Mat canvas, VideoCapture cap, int vw, int vh,
        int x, int y, int drawW, int drawH)
    {
        using var frame = new Mat();
        if (cap.Read(frame) && !frame.Empty())
        {
            using var resized = ResizeFrame(frame, drawW, drawH);
            var roi = new Mat(canvas, new Rect(
                Math.Max(0, x),
                Math.Max(0, y),
                Math.Min(drawW, canvas.Width - Math.Max(0, x)),
                Math.Min(drawH, canvas.Height - Math.Max(0, y))
            ));
            resized.CopyTo(roi);
        }
    }

    private static Mat ResizeFrame(Mat frame, int targetW, int targetH)
    {
        var resized = new Mat();
        Cv2.Resize(frame, resized, new Size(targetW, targetH));
        return resized;
    }

    private static string FindFfmpeg()
    {
        // Check common locations
        string[] paths =
        [
            Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ffmpeg.exe"),
            "ffmpeg",
            @"C:\ffmpeg\bin\ffmpeg.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "ffmpeg", "bin", "ffmpeg.exe")
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
