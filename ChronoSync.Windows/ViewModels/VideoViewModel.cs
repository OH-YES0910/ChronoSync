using System.IO;
using System.Windows;
using System.Windows.Media.Imaging;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using ChronoSync.Windows.Models;

namespace ChronoSync.Windows.ViewModels;

public partial class VideoViewModel : ObservableObject
{
    [ObservableProperty]
    private VideoInfo _videoInfo = null!;

    [ObservableProperty]
    private TimerRegion? _detectedRegion;

    [ObservableProperty]
    private string _regionDisplayText = "未选择区域";

    [ObservableProperty]
    private string _statusText = string.Empty;

    [ObservableProperty]
    private double _offsetSeconds;

    [ObservableProperty]
    private List<CalibrationPoint> _calibrationPoints = [];

    [ObservableProperty]
    private bool _isAnalyzing;

    [ObservableProperty]
    private bool _isRegionDetected;

    [ObservableProperty]
    private double _sliderValue;

    [ObservableProperty]
    private double _duration;

    [ObservableProperty]
    private BitmapSource? _thumbnail;

    [ObservableProperty]
    private BitmapSource? _currentFrame;

    /// <summary>Auto-detected region as normalized 0-1 Rect (for RegionSelectorView overlay).</summary>
    [ObservableProperty]
    private Rect _autoDetectedRegion = Rect.Empty;

    /// <summary>User-drawn region as normalized 0-1 Rect (for RegionSelectorView overlay).</summary>
    [ObservableProperty]
    private Rect _selectedRegion = Rect.Empty;

    public string DisplayName => Path.GetFileNameWithoutExtension(VideoInfo?.FilePath ?? string.Empty);

    public string OffsetDisplay => Math.Abs(OffsetSeconds) < 0.0001
        ? "基准"
        : $"+{OffsetSeconds:F3}s";

    /// <summary>
    /// Load the first frame as thumbnail.
    /// </summary>
    public void LoadThumbnail()
    {
        if (VideoInfo?.FilePath is null) return;
        Thumbnail = MainWindow.ExtractFrame(VideoInfo.FilePath, 0.5);
    }

    /// <summary>
    /// Load a frame at the given time for display.
    /// </summary>
    public void LoadFrame(double timeSeconds)
    {
        if (VideoInfo?.FilePath is null) return;
        CurrentFrame = MainWindow.ExtractFrame(VideoInfo.FilePath, timeSeconds);
    }

    partial void OnDetectedRegionChanged(TimerRegion? value)
    {
        IsRegionDetected = value is not null;
        RegionDisplayText = value?.ToString() ?? "未选择区域";
        if (value is not null)
        {
            AutoDetectedRegion = new Rect(
                value.X / 100.0,
                value.Y / 100.0,
                value.W / 100.0,
                value.H / 100.0);
        }
        else
        {
            AutoDetectedRegion = Rect.Empty;
        }
    }

    partial void OnOffsetSecondsChanged(double value)
    {
        OnPropertyChanged(nameof(OffsetDisplay));
    }
}
