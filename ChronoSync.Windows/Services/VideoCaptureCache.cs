using System.Collections.Generic;
using OpenCvSharp;

namespace ChronoSync.Windows.Services;

/// <summary>
/// Cache of VideoCapture instances keyed by file path. Disposed when window closes.
/// Much faster than opening VideoCapture per call (~100-300ms saved per open).
/// VideoCapture is NOT thread-safe; consumers must serialize access to a given capture.
/// </summary>
public sealed class VideoCaptureCache : System.IDisposable
{
    private readonly Dictionary<string, VideoCapture> _cache = new();
    private readonly object _lock = new();
    private bool _disposed;

    public VideoCapture GetOrOpen(string videoPath)
    {
        lock (_lock)
        {
            if (_disposed) throw new System.ObjectDisposedException(nameof(VideoCaptureCache));
            if (_cache.TryGetValue(videoPath, out var existing)) return existing;
            var capture = new VideoCapture(videoPath);
            if (!capture.IsOpened())
            {
                capture.Dispose();
                throw new System.InvalidOperationException($"Cannot open video: {videoPath}");
            }
            _cache[videoPath] = capture;
            return capture;
        }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            if (_disposed) return;
            _disposed = true;
            foreach (var c in _cache.Values) c.Dispose();
            _cache.Clear();
        }
    }
}