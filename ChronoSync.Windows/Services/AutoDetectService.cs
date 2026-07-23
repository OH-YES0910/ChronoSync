using ChronoSync.Windows.Models;
using OpenCvSharp;

namespace ChronoSync.Windows.Services;

/// <summary>
/// Automatic timer region detection service.
/// Replicates app.js autoDetectRegion() algorithm:
/// 1. Sample 8 frames across video duration
/// 2. Scan top-right area (x>70%, y<25%) for warm pixels
/// 3. Row histogram to find warm bands
/// 4. Column histogram to find rectangle segments
/// 5. White text validation (exclude LED strips)
/// 6. Cluster voting (center distance <5% groups together)
/// 7. Select largest cluster, average coordinates
/// </summary>
public static class AutoDetectService
{
    /// <summary>
    /// Warm pixel condition from app.js: r > 120 && (r - b) > 60 && r > g * 0.6
    /// </summary>
    private static bool IsWarmPixel(byte b, byte g, byte r)
    {
        return r > 120 && (r - b) > 60 && r > g * 0.6;
    }

    /// <summary>
    /// Auto-detect timer region from a video file.
    /// Returns null if detection fails.
    /// </summary>
    public static TimerRegion? Detect(string videoPath, Action<string>? onProgress = null)
    {
        using var capture = new VideoCapture(videoPath);
        if (!capture.IsOpened()) return null;

        int vw = capture.FrameWidth;
        int vh = capture.FrameHeight;
        double fps = capture.Get(VideoCaptureProperties.Fps);
        double frameCount = capture.Get(VideoCaptureProperties.FrameCount);
        double duration = fps > 0 ? frameCount / fps : 0;

        if (duration < 2) return null;

        // Sample 8 frames across duration (matching app.js)
        var sampleTimes = new List<double>();
        for (int i = 0; i < 8; i++)
        {
            double t = duration * (0.1 + 0.8 * i / 7.0);
            if (t > 1 && t < duration - 1)
                sampleTimes.Add(t);
        }

        var detections = new List<DetectionResult>();
        int frameIndex = 0;

        foreach (var t in sampleTimes)
        {
            onProgress?.Invoke($"采样帧 {++frameIndex}/{sampleTimes.Count}...");

            // Seek to target time
            int targetFrame = (int)(t * fps);
            capture.Set(VideoCaptureProperties.PosFrames, targetFrame);

            using var frame = new Mat();
            if (!capture.Read(frame) || frame.Empty()) continue;

            // Quick black frame check (matching app.js)
            var centerPixel = frame.At<Vec3b>(vh / 2, vw / 2);
            int centerAvg = (centerPixel.Item0 + centerPixel.Item1 + centerPixel.Item2) / 3;
            if (centerAvg < 10) continue;

            var result = FindTimer(frame, vw, vh);
            if (result is not null)
            {
                result.SeekTime = t;
                detections.Add(result);
            }
        }

        if (detections.Count == 0)
        {
            onProgress?.Invoke("未检测到计时器");
            return null;
        }

        // Cluster voting: center distance <5% groups together (matching app.js)
        var clusters = ClusterDetections(detections, vw, vh);
        if (clusters.Count == 0) return null;

        // Select cluster with most votes
        var bestCluster = clusters.OrderByDescending(c => c.Items.Count).First();

        // Average coordinates within cluster
        int minX = (int)bestCluster.Items.Average(x => x.MinX);
        int maxX = (int)bestCluster.Items.Average(x => x.MaxX);
        int minY = (int)bestCluster.Items.Average(x => x.MinY);
        int maxY = (int)bestCluster.Items.Average(x => x.MaxY);

        int tW = maxX - minX;
        int tH = maxY - minY;

        // Add padding (matching app.js)
        int padX = Math.Max((int)(tW * 0.15), (int)(vw * 0.003));
        int padY = Math.Max((int)(tH * 0.2), (int)(vh * 0.002));
        int fx = Math.Max(0, minX - padX);
        int fy = Math.Max(0, minY - padY);
        int fw = Math.Min(vw, maxX + padX) - fx;
        int fh = Math.Min(vh, maxY + padY) - fy;

        // Convert pixel coordinates to selector percentage (object-fit:contain mapping)
        const double SELECTOR_ASPECT = 16.0 / 9.0;
        double videoAspect = (double)vw / vh;

        double scaleX, scaleY, offX, offY;
        if (videoAspect > SELECTOR_ASPECT)
        {
            scaleX = 1;
            scaleY = SELECTOR_ASPECT / videoAspect;
            offX = 0;
            offY = (1 - scaleY) / 2;
        }
        else
        {
            scaleY = 1;
            scaleX = videoAspect / SELECTOR_ASPECT;
            offX = (1 - scaleX) / 2;
            offY = 0;
        }

        double xPct = Math.Round((offX + (double)fx / vw * scaleX) * 100, 1);
        double yPct = Math.Round((offY + (double)fy / vh * scaleY) * 100, 1);
        double wPct = Math.Round(((double)fw / vw * scaleX) * 100, 1);
        double hPct = Math.Round(((double)fh / vh * scaleY) * 100, 1);

        onProgress?.Invoke($"已识别: x={xPct}% y={yPct}% w={wPct}% h={hPct}%");

        return new TimerRegion
        {
            X = xPct,
            Y = yPct,
            W = wPct,
            H = hPct
        };
    }

    /// <summary>
    /// Find timer region in a single frame.
    /// Replicates app.js findTimer(imageData).
    /// </summary>
    private static DetectionResult? FindTimer(Mat frame, int vw, int vh)
    {
        // Scan area: x>70%, y in [5%, 25%] (matching app.js)
        int sx = (int)(vw * 0.70);
        int sy = (int)(vh * 0.05);
        int ey = (int)(vh * 0.25);
        int scanH = ey - sy;
        int scanW = vw - sx;

        // Step 1: Row histogram — count warm pixels per row
        var rowHist = new int[scanH];
        for (int y = sy; y < ey; y++)
        {
            for (int x = sx; x < vw; x++)
            {
                var pixel = frame.At<Vec3b>(y, x);
                if (IsWarmPixel(pixel.Item0, pixel.Item1, pixel.Item2))
                {
                    rowHist[y - sy]++;
                }
            }
        }

        // Find row histogram peak
        int maxRowCount = 0, centerRow = 0;
        for (int i = 0; i < scanH; i++)
        {
            if (rowHist[i] > maxRowCount)
            {
                maxRowCount = rowHist[i];
                centerRow = i;
            }
        }
        if (maxRowCount < 5) return null;

        // Row expansion: take all rows >= 20% of peak (matching app.js)
        double rowThresh = maxRowCount * 0.20;
        int top = scanH, bottom = 0;
        for (int i = 0; i < scanH; i++)
        {
            if (rowHist[i] >= rowThresh)
            {
                if (i < top) top = i;
                if (i > bottom) bottom = i;
            }
        }
        if (top > bottom) return null;

        int minY = sy + top;
        int maxY = sy + bottom;
        int rowH = maxY - minY + 1;

        // Step 2: Column histogram within determined row range
        var colHist = new int[scanW];
        for (int y = minY; y <= maxY; y++)
        {
            for (int x = sx; x < vw; x++)
            {
                var pixel = frame.At<Vec3b>(y, x);
                if (IsWarmPixel(pixel.Item0, pixel.Item1, pixel.Item2))
                {
                    colHist[x - sx]++;
                }
            }
        }

        // Column threshold: >= 25% of row height
        int colThresh = (int)(rowH * 0.25);

        // Collect continuous column segments
        var segments = new List<Segment>();
        int curRun = 0, curStart = 0;
        for (int i = 0; i < scanW; i++)
        {
            if (colHist[i] >= colThresh)
            {
                if (curRun == 0) curStart = i;
                curRun++;
            }
            else
            {
                if (curRun > 0)
                {
                    segments.Add(new Segment(curStart, curRun));
                    curRun = 0;
                }
            }
        }
        if (curRun > 0) segments.Add(new Segment(curStart, curRun));

        // Select segment with highest warm pixel count (matching app.js)
        Segment? bestSeg = null;
        int bestScore = 0;
        foreach (var seg in segments)
        {
            int sum = 0;
            for (int i = seg.Start; i < seg.Start + seg.Length; i++)
                sum += colHist[i];
            if (sum > bestScore)
            {
                bestScore = sum;
                bestSeg = seg;
            }
        }
        if (bestSeg is null) return null;

        int minX = sx + bestSeg.Start;
        int maxX = sx + bestSeg.Start + bestSeg.Length;

        // White text check: timer has white digits, LED strips don't
        int whiteCount = 0;
        int totalPixels = (maxX - minX) * (maxY - minY);
        for (int y = minY; y <= maxY; y++)
        {
            for (int x = minX; x < maxX; x++)
            {
                var pixel = frame.At<Vec3b>(y, x);
                byte r = pixel.Item2, g = pixel.Item1, b = pixel.Item0;
                if (r > 200 && g > 200 && b > 200
                    && Math.Abs(r - g) < 30 && Math.Abs(r - b) < 30)
                {
                    whiteCount++;
                }
            }
        }

        if (whiteCount < 10 || (double)whiteCount / totalPixels < 0.01)
            return null;

        return new DetectionResult(minX, maxX, minY, maxY, bestScore);
    }

    /// <summary>
    /// Cluster detections by center point proximity (5% threshold).
    /// Replicates app.js clustering logic.
    /// </summary>
    private static List<Cluster> ClusterDetections(
        List<DetectionResult> detections, int vw, int vh)
    {
        var clusters = new List<Cluster>();

        foreach (var d in detections)
        {
            double cx = (double)(d.MinX + d.MaxX) / 2 / vw;
            double cy = (double)(d.MinY + d.MaxY) / 2 / vh;

            bool matched = false;
            foreach (var cl in clusters)
            {
                if (Math.Abs(cx - cl.Cx) < 0.05 && Math.Abs(cy - cl.Cy) < 0.05)
                {
                    cl.Items.Add(d);
                    // Update cluster center
                    cl.Cx = cl.Items.Average(x => (double)(x.MinX + x.MaxX) / 2 / vw);
                    cl.Cy = cl.Items.Average(y => (double)(y.MinY + y.MaxY) / 2 / vh);
                    matched = true;
                    break;
                }
            }

            if (!matched)
                clusters.Add(new Cluster(cx, cy, d));
        }

        return clusters;
    }

    private sealed class DetectionResult(int minX, int maxX, int minY, int maxY, int count)
    {
        public int MinX { get; } = minX;
        public int MaxX { get; } = maxX;
        public int MinY { get; } = minY;
        public int MaxY { get; } = maxY;
        public int Count { get; } = count;
        public double SeekTime { get; set; }
    }

    private sealed class Segment(int start, int length)
    {
        public int Start { get; } = start;
        public int Length { get; } = length;
    }

    private sealed class Cluster(double cx, double cy, DetectionResult firstItem)
    {
        public double Cx { get; set; } = cx;
        public double Cy { get; set; } = cy;
        public List<DetectionResult> Items { get; } = [firstItem];
    }
}
