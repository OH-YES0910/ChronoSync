using System.IO;
using System.Text.RegularExpressions;
using ChronoSync.Windows.Models;
using Tesseract;
using Cv2 = OpenCvSharp.Cv2;
using Mat = OpenCvSharp.Mat;
using Size = OpenCvSharp.Size;
using OcvRect = OpenCvSharp.Rect;

namespace ChronoSync.Windows.Services;

/// <summary>
/// OCR service for reading timer values from video frames.
/// Replicates app.js readTimerValue + parseTimerText + Tesseract worker logic.
/// </summary>
public sealed class OcrService : IDisposable
{
    private TesseractEngine? _engine;
    private bool _initialized;

    /// <summary>
    /// Initialize the Tesseract OCR engine.
    /// Corresponds to app.js ocrInit().
    /// </summary>
    public bool Initialize(string? tessDataPath = null)
    {
        if (_initialized) return true;

        try
        {
            var basePath = tessDataPath
                ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "tessdata");

            if (!Directory.Exists(basePath))
                Directory.CreateDirectory(basePath);

            _engine = new TesseractEngine(basePath, "eng", EngineMode.Default);
            _engine.SetVariable("tessedit_char_whitelist", "0123456789.:");
            _engine.SetVariable("tessedit_pageseg_mode", "8"); // PSM_SINGLE_WORD
            _initialized = true;
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Read the timer value from a frame at the given region.
    /// Corresponds to app.js readTimerValue(video, region).
    /// </summary>
    public OcrResult ReadTimerValue(Mat frame, TimerRegion region)
    {
        if (!_initialized || _engine is null || frame is null)
            return new OcrResult(string.Empty, null, 0);

        try
        {
            int vw = frame.Width;
            int vh = frame.Height;

            const double SELECTOR_ASPECT = 16.0 / 9.0;
            double videoAspect = (double)vw / vh;

            double scaleX, scaleY, offsetX, offsetY;
            if (videoAspect > SELECTOR_ASPECT)
            {
                scaleX = 1;
                scaleY = SELECTOR_ASPECT / videoAspect;
                offsetX = 0;
                offsetY = (1 - scaleY) / 2;
            }
            else
            {
                scaleY = 1;
                scaleX = videoAspect / SELECTOR_ASPECT;
                offsetX = (1 - scaleX) / 2;
                offsetY = 0;
            }

            double videoX = (region.X / 100 - offsetX) / scaleX * vw;
            double videoY = (region.Y / 100 - offsetY) / scaleY * vh;
            double videoW = (region.W / 100) / scaleX * vw;
            double videoH = (region.H / 100) / scaleY * vh;

            int rx = Math.Max(0, (int)Math.Min(videoX, vw));
            int ry = Math.Max(0, (int)Math.Min(videoY, vh));
            int rw = Math.Max(1, (int)Math.Min(videoW, vw - rx));
            int rh = Math.Max(1, (int)Math.Min(videoH, vh - ry));

            using var roi = new Mat(frame, new OcvRect(rx, ry, rw, rh));
            using var resized = new Mat();
            Cv2.Resize(roi, resized, new Size(640, 144));

            var pngBytes = resized.ImEncode(".png");

            using var pix = Pix.LoadFromMemory(pngBytes);
            using var page = _engine.Process(pix);
            string text = (page.GetText() ?? string.Empty).Trim();
            float confidence = page.GetMeanConfidence();

            double? value = ParseTimerText(text);

            return new OcrResult(text, value, confidence);
        }
        catch
        {
            return new OcrResult(string.Empty, null, 0);
        }
    }

    /// <summary>
    /// Parse timer text to extract seconds value.
    /// Corresponds to app.js parseTimerText().
    /// Format: MM:SS.mmm (e.g. "2:05.341")
    /// Alarm icon misread correction: if mins > 4, mins = mins % 100
    /// </summary>
    public static double? ParseTimerText(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;

        var cleaned = Regex.Replace(text, @"[^0-9:.,]", "").Trim();
        var match = Regex.Match(cleaned, @"(\d+):(\d{1,2})(?:[.,](\d+))?");
        if (!match.Success) return null;

        int mins = int.Parse(match.Groups[1].Value);
        int secs = int.Parse(match.Groups[2].Value);
        double ms = match.Groups[3].Success
            ? double.Parse("0." + match.Groups[3].Value)
            : 0;

        if (mins > 4) mins = mins % 100;
        if (mins <= 4 && secs < 60)
            return mins * 60 + secs + ms;

        return null;
    }

    public void Dispose()
    {
        _engine?.Dispose();
        _engine = null;
        _initialized = false;
    }
}

public sealed record OcrResult(string Text, double? Value, float Confidence);
