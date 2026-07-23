using System.IO;
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

    public string DisplayName => Path.GetFileNameWithoutExtension(VideoInfo?.FilePath ?? string.Empty);

    public string OffsetDisplay => Math.Abs(OffsetSeconds) < 0.0001
        ? "基准"
        : $"+{OffsetSeconds:F3}s";

    partial void OnDetectedRegionChanged(TimerRegion? value)
    {
        IsRegionDetected = value is not null;
        RegionDisplayText = value?.ToString() ?? "未选择区域";
    }

    partial void OnOffsetSecondsChanged(double value)
    {
        OnPropertyChanged(nameof(OffsetDisplay));
    }
}
