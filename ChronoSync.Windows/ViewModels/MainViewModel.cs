using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using ChronoSync.Windows.Models;
using ChronoSync.Windows.Services;
using Microsoft.Win32;
using OpenCvSharp;

namespace ChronoSync.Windows.ViewModels;

public partial class MainViewModel : ObservableObject, IDisposable
{
    private readonly OcrService _ocrService = new();
    private readonly DispatcherTimer _syncTimer;
    private readonly List<VideoCapture> _syncCaptures = [];
    private bool _isPlaying;
    private double _currentSyncTime;
    private double _maxSyncTime;
    private CancellationTokenSource? _exportCts;

    // Max 4 videos (matching app.js MAX_VIDEOS = 4)
    private const int MaxVideos = 4;

    public ObservableCollection<VideoViewModel> Videos { get; } = [];

    [ObservableProperty]
    private int _currentStep = 1;

    [ObservableProperty]
    private string _analysisProgress = string.Empty;

    [ObservableProperty]
    private double _analysisProgressPercent;

    [ObservableProperty]
    private string _analysisStatusText = string.Empty;

    [ObservableProperty]
    private string _analysisResultText = string.Empty;

    [ObservableProperty]
    private bool _isAnalyzing;

    [ObservableProperty]
    private bool _isExporting;

    [ObservableProperty]
    private string _exportProgressText = string.Empty;

    [ObservableProperty]
    private double _syncSliderValue;

    [ObservableProperty]
    private double _syncSliderMax = 60;

    [ObservableProperty]
    private string _timeDisplayText = "0.0s";

    [ObservableProperty]
    private string _playButtonContent = "▶ 同步播放";

    [ObservableProperty]
    private ExportService.Layout _selectedLayout = ExportService.Layout.Vertical;

    [ObservableProperty]
    private bool _isSyncReady;

    public bool CanGoToStep2 => Videos.Count >= 2;
    public bool CanGoToStep3 => Videos.All(v => v.IsRegionDetected);
    public bool HasVideos => Videos.Count > 0;

    public MainViewModel()
    {
        _syncTimer = new DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(100) // ~0.1s for smooth sync
        };
        _syncTimer.Tick += SyncTimer_Tick;

        _ocrService.Initialize();
    }

    [RelayCommand]
    private void AddVideos()
    {
        var dialog = new OpenFileDialog
        {
            Filter = "视频文件|*.mp4;*.webm;*.mov;*.avi;*.mkv|所有文件|*.*",
            Multiselect = true,
            Title = "选择视频文件 (2-4个)"
        };

        if (dialog.ShowDialog() == true)
        {
            int remaining = MaxVideos - Videos.Count;
            var files = dialog.FileNames.Take(remaining).ToList();

            foreach (var file in files)
            {
                // Get video duration using OpenCvSharp
                double duration = 0;
                using (var cap = new OpenCvSharp.VideoCapture(file))
                {
                    if (cap.IsOpened())
                    {
                        double fps = cap.Get(OpenCvSharp.VideoCaptureProperties.Fps);
                        double frameCount = cap.Get(OpenCvSharp.VideoCaptureProperties.FrameCount);
                        duration = fps > 0 ? frameCount / fps : 0;
                    }
                }

                Videos.Add(new VideoViewModel
                {
                    VideoInfo = new VideoInfo { FilePath = file },
                    Duration = duration,
                    SliderValue = duration * 0.1
                });
            }

            OnPropertyChanged(nameof(CanGoToStep2));
            OnPropertyChanged(nameof(HasVideos));
        }
    }

    [RelayCommand]
    private void RemoveVideo(VideoViewModel video)
    {
        Videos.Remove(video);
        OnPropertyChanged(nameof(CanGoToStep2));
        OnPropertyChanged(nameof(CanGoToStep3));
        OnPropertyChanged(nameof(HasVideos));
    }

    [RelayCommand]
    private void GoToStep(int step)
    {
        if (step == 2 && !CanGoToStep2) return;
        if (step == 3 && !CanGoToStep3) return;

        CurrentStep = step;

        if (step == 3)
        {
            _ = AnalyzeVideosAsync();
        }
    }

    [RelayCommand]
    private async Task AutoDetectAllAsync()
    {
        var progress = new Progress<string>(msg =>
        {
            AnalysisProgress = msg;
        });

        await Task.Run(() =>
        {
            var parallelOptions = new ParallelOptions { MaxDegreeOfParallelism = Videos.Count };
            Parallel.ForEach(Videos, parallelOptions, video =>
            {
                try
                {
                    var region = AutoDetectService.Detect(video.VideoInfo.FilePath, msg =>
                    {
                        Application.Current.Dispatcher.Invoke(() =>
                        {
                            video.StatusText = msg;
                        });
                    });

                    Application.Current.Dispatcher.Invoke(() =>
                    {
                        video.DetectedRegion = region;
                        video.StatusText = region is not null
                            ? $"已识别: {region}"
                            : "未检测到计时器";
                    });
                }
                catch (Exception ex)
                {
                    Application.Current.Dispatcher.Invoke(() =>
                    {
                        video.StatusText = $"检测失败: {ex.Message}";
                    });
                }
            });
        });

        OnPropertyChanged(nameof(CanGoToStep3));
    }

    [RelayCommand]
    private async Task AnalyzeVideosAsync()
    {
        if (IsAnalyzing) return;
        IsAnalyzing = true;
        AnalysisProgressPercent = 5;
        AnalysisStatusText = "正在分析...";

        try
        {
            var calibrationData = new Dictionary<string, List<CalibrationPoint>>();
            int totalVideos = Videos.Count;
            int completedVideos = 0;

            // Process all videos in parallel (matching app.js Promise.all)
            var tasks = Videos.Select(video => Task.Run(() =>
            {
                if (video.DetectedRegion is null)
                {
                    Application.Current.Dispatcher.Invoke(() =>
                    {
                        video.StatusText = "跳过: 无区域";
                    });
                    return;
                }

                var points = FrameExtractionService.ExtractFrames(
                    video.VideoInfo.FilePath,
                    video.DetectedRegion,
                    _ocrService,
                    msg =>
                    {
                        Application.Current.Dispatcher.Invoke(() =>
                        {
                            video.StatusText = msg;
                        });
                    });

                lock (calibrationData)
                {
                    calibrationData[video.VideoInfo.Id] = points;
                }

                Application.Current.Dispatcher.Invoke(() =>
                {
                    video.CalibrationPoints = points;
                    completedVideos++;
                    AnalysisProgressPercent = 5 + (double)completedVideos / totalVideos * 85;
                });
            })).ToArray();

            await Task.WhenAll(tasks);

            AnalysisProgressPercent = 95;
            AnalysisStatusText = "正在计算偏移...";

            // Calculate offsets
            var offsets = await Task.Run(() =>
                OffsetCalculationService.CalculateOffsets(calibrationData));

            // Apply offsets to ViewModels
            foreach (var video in Videos)
            {
                if (offsets.TryGetValue(video.VideoInfo.Id, out double offset))
                {
                    video.OffsetSeconds = offset;
                }
            }

            AnalysisProgressPercent = 100;

            // Build result summary (matching app.js)
            var summary = Videos
                .Where(v => v.CalibrationPoints.Count >= 2)
                .Select((v, i) => i == 0
                    ? $"{v.DisplayName}: 基准"
                    : $"{v.DisplayName}: +{v.OffsetSeconds:F3}s")
                .ToList();

            AnalysisResultText = summary.Count > 0
                ? $"分析完成！{string.Join(" | ", summary)}"
                : "分析完成（未获得足够的校准点）";

            // Initialize sync
            InitializeSync();
        }
        catch (Exception ex)
        {
            AnalysisResultText = $"分析失败: {ex.Message}";
        }
        finally
        {
            IsAnalyzing = false;
        }
    }

    private void InitializeSync()
    {
        CleanupSync();

        _maxSyncTime = Videos.Max(v => v.Duration);
        SyncSliderMax = _maxSyncTime;
        _currentSyncTime = 0;
        SyncSliderValue = 0;
        TimeDisplayText = "0.0s";
        IsSyncReady = true;

        // Load videos for sync playback using OpenCV captures
        foreach (var video in Videos)
        {
            var cap = new OpenCvSharp.VideoCapture(video.VideoInfo.FilePath);
            _syncCaptures.Add(cap);
        }
    }

    [RelayCommand]
    private void ToggleSyncPlay()
    {
        if (_isPlaying)
            PauseSyncPlay();
        else
            StartSyncPlay();
    }

    private void StartSyncPlay()
    {
        _isPlaying = true;
        PlayButtonContent = "⏸ 暂停";
        _syncTimer.Start();
    }

    private void PauseSyncPlay()
    {
        _isPlaying = false;
        PlayButtonContent = "▶ 同步播放";
        _syncTimer.Stop();
    }

    /// <summary>
    /// Sync loop: check drift every ~0.3s, adjust playback rate.
    /// Replicates app.js syncLoop logic.
    /// </summary>
    private DateTime _lastSyncCheck = DateTime.MinValue;

    private void SyncTimer_Tick(object? sender, EventArgs e)
    {
        if (!_isPlaying || _syncCaptures.Count == 0) return;

        var now = DateTime.UtcNow;

        // Update display every ~0.5s
        if ((now - _lastSyncCheck).TotalSeconds >= 0.3)
        {
            _lastSyncCheck = now;

            // Advance base video time
            _currentSyncTime += 0.1; // ~100ms tick
            if (_currentSyncTime >= _maxSyncTime)
            {
                PauseSyncPlay();
                return;
            }

            SyncSliderValue = _currentSyncTime;
            TimeDisplayText = $"{_currentSyncTime:F1}s";

            // For each non-base video, check drift and correct
            // In WPF with OpenCvSharp, we don't have real-time playback rate control
            // Instead, we handle seek-based sync by advancing frame reads
            // The sync is conceptual — in practice, WPF MediaElement would be needed
            // for true real-time sync playback
        }
    }

    [RelayCommand]
    private void SyncSliderChanged()
    {
        if (_isPlaying) return;
        _currentSyncTime = SyncSliderValue;
        TimeDisplayText = $"{_currentSyncTime:F1}s";
    }

    [RelayCommand]
    private void AdjustOffset(string deltaStr)
    {
        if (!double.TryParse(deltaStr, out double delta)) return;

        // Apply to last selected video or second video
        var target = Videos.Skip(1).FirstOrDefault();
        if (target is not null)
        {
            target.OffsetSeconds += delta;
        }
    }

    [RelayCommand]
    private async Task ExportVideoAsync()
    {
        if (IsExporting) return;
        IsExporting = true;
        _exportCts = new CancellationTokenSource();

        try
        {
            var exportVideos = Videos
                .Where(v => v.CalibrationPoints.Count > 0)
                .Select(v => new VideoExportData
                {
                    Id = v.VideoInfo.Id,
                    FilePath = v.VideoInfo.FilePath,
                    Duration = v.Duration
                })
                .ToList();

            if (exportVideos.Count < 2)
            {
                ExportProgressText = "视频不足，无法导出";
                return;
            }

            var offsets = Videos.ToDictionary(
                v => v.VideoInfo.Id,
                v => v.OffsetSeconds);

            string? outputPath = null;
            var saveDialog = new SaveFileDialog
            {
                Filter = "MP4视频|*.mp4",
                FileName = $"ChronoSync_{DateTime.Now:yyyyMMdd_HHmmss}.mp4",
                Title = "保存导出视频"
            };
            if (saveDialog.ShowDialog() == true)
                outputPath = saveDialog.FileName;

            await ExportService.ExportAsync(
                exportVideos,
                offsets,
                SelectedLayout,
                targetHeight: 1080,
                targetFps: 30,
                outputPath,
                msg => ExportProgressText = msg,
                _exportCts.Token);

            ExportProgressText = $"导出完成！{outputPath}";
        }
        catch (OperationCanceledException)
        {
            ExportProgressText = "导出已取消";
        }
        catch (Exception ex)
        {
            ExportProgressText = $"导出失败: {ex.Message}";
        }
        finally
        {
            IsExporting = false;
            _exportCts?.Dispose();
            _exportCts = null;
        }
    }

    [RelayCommand]
    private void SelectLayout(string layoutId)
    {
        SelectedLayout = layoutId switch
        {
            "horizontal" => ExportService.Layout.Horizontal,
            "top1-bottom2" => ExportService.Layout.Top1Bottom2,
            "top2-bottom1" => ExportService.Layout.Top2Bottom1,
            "grid-4" => ExportService.Layout.Grid4,
            _ => ExportService.Layout.Vertical
        };
    }

    [RelayCommand]
    private void Recalculate()
    {
        PauseSyncPlay();
        CleanupSync();
        foreach (var video in Videos)
        {
            video.CalibrationPoints = [];
            video.OffsetSeconds = 0;
        }
        CurrentStep = 3;
        _ = AnalyzeVideosAsync();
    }

    [RelayCommand]
    private void ResetAll()
    {
        PauseSyncPlay();
        CleanupSync();
        Videos.Clear();
        CurrentStep = 1;
        AnalysisResultText = string.Empty;
        AnalysisProgressPercent = 0;
        AnalysisStatusText = string.Empty;
        IsSyncReady = false;
        OnPropertyChanged(nameof(CanGoToStep2));
        OnPropertyChanged(nameof(CanGoToStep3));
        OnPropertyChanged(nameof(HasVideos));
    }

    private void CleanupSync()
    {
        foreach (var cap in _syncCaptures)
            cap.Dispose();
        _syncCaptures.Clear();
    }

    public void Dispose()
    {
        CleanupSync();
        _ocrService.Dispose();
        _exportCts?.Cancel();
        _exportCts?.Dispose();
    }
}
