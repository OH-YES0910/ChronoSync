using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Interop;
using System.Windows.Media.Imaging;
using ChronoSync.Windows.Controls;
using ChronoSync.Windows.Models;
using ChronoSync.Windows.ViewModels;
using OpenCvSharp;
using Cv2 = OpenCvSharp.Cv2;
using Window = System.Windows.Window;
using Rect = System.Windows.Rect;

namespace ChronoSync.Windows;

public partial class MainWindow : Window
{
    // Static converters for XAML binding
    public static readonly IValueConverter StringToVisConverter = new NullOrEmptyToVisibilityConverter();
    public static readonly IValueConverter InvertBoolConverter = new NegateBoolConverter();

    public MainWindow()
    {
        InitializeComponent();

        // Set window to monitor resolution on startup
        Loaded += (_, _) =>
        {
            var screen = SystemParameters.PrimaryScreenWidth;
            var screenHeight = SystemParameters.PrimaryScreenHeight;
            // Use ~90% of screen to avoid taskbar overlap
            Width = screen * 0.9;
            Height = screenHeight * 0.9;
            Left = (screen - Width) / 2;
            Top = (screenHeight - Height) / 2;
        };

        Closed += (_, _) =>
        {
            CaptureCache.Dispose();
            if (DataContext is MainViewModel vm)
                vm.Dispose();
        };
    }

    /// <summary>
    /// Shared VideoCapture cache. Reusing a capture avoids the 100-300ms open cost per call,
    /// which previously made extracting 100+ calibration frames painfully slow.
    /// </summary>
    public static Services.VideoCaptureCache CaptureCache { get; } = new();

    #region RegionSelectorView Event Handlers (Step 2)

    private void RegionSelector_TimeChanged(object sender, RoutedEventArgs e)
    {
        if (sender is not RegionSelectorView view) return;
        if (view.DataContext is not VideoViewModel vm) return;
        double t = vm.SliderValue;
        // Load frame on background thread
        _ = System.Threading.Tasks.Task.Run(() => vm.LoadFrame(t));
    }

    private void RegionSelector_RegionSelected(object sender, RoutedEventArgs e)
    {
        if (sender is not RegionSelectorView view) return;
        if (view.DataContext is not VideoViewModel vm) return;
        if (e.OriginalSource is not Rect rect || rect.IsEmpty) return;

        // Convert normalized 0-1 Rect to percentage TimerRegion
        var region = new TimerRegion
        {
            X = Math.Round(rect.X * 100, 1),
            Y = Math.Round(rect.Y * 100, 1),
            W = Math.Round(rect.Width * 100, 1),
            H = Math.Round(rect.Height * 100, 1)
        };
        vm.DetectedRegion = region;
        vm.SelectedRegion = rect;
    }

    private void RegionSelector_RandomSeek(object sender, RoutedEventArgs e)
    {
        if (sender is not RegionSelectorView view) return;
        if (view.DataContext is not VideoViewModel vm) return;
        if (vm.Duration <= 0) return;
        // 10%-90% of duration
        var rand = new Random();
        double t = vm.Duration * (0.1 + 0.8 * rand.NextDouble());
        vm.SliderValue = t;
        // TimeChanged will fire via the slider drag; force load frame
        _ = System.Threading.Tasks.Task.Run(() => vm.LoadFrame(t));
    }

    #endregion

    /// <summary>
    /// Convert an OpenCvSharp Mat to a WPF BitmapSource for display in Image controls.
    /// </summary>
    public static BitmapSource? MatToBitmapSource(Mat mat)
    {
        if (mat is null || mat.Empty()) return null;

        try
        {
            // Convert BGR to BGRA if needed
            using var rgba = new Mat();
            if (mat.Channels() == 3)
                Cv2.CvtColor(mat, rgba, ColorConversionCodes.BGR2BGRA);
            else
                rgba.SetTo(mat);

            int stride = rgba.Width * rgba.Channels();
            var bitmap = BitmapSource.Create(
                rgba.Width, rgba.Height,
                96, 96,
                System.Windows.Media.PixelFormats.Bgra32,
                null,
                rgba.Data,
                (int)(rgba.Rows * rgba.Step()),
                stride);

            bitmap.Freeze();
            return bitmap;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Extract a frame at a given time from a video file and return as BitmapSource.
    /// Reuses cached VideoCapture (much faster than opening per call).
    /// </summary>
    public static BitmapSource? ExtractFrame(string videoPath, double timeSeconds)
    {
        VideoCapture capture;
        try
        {
            capture = CaptureCache.GetOrOpen(videoPath);
        }
        catch
        {
            return null;
        }

        // NOTE: capture is owned by the cache; don't dispose.
        // Serialize access to the underlying capture (VideoCapture is not thread-safe).
        lock (capture)
        {
            double fps = capture.Get(VideoCaptureProperties.Fps);
            if (fps <= 0) return null;

            int targetFrame = (int)(timeSeconds * fps);
            capture.Set(VideoCaptureProperties.PosFrames, targetFrame);

            using var frame = new Mat();
            if (capture.Read(frame) && !frame.Empty())
                return MatToBitmapSource(frame);

            return null;
        }
    }
}

/// <summary>
/// Returns Visible if string is not null/empty, Collapsed otherwise.
/// </summary>
internal sealed class NullOrEmptyToVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        bool hasValue = value is string s && !string.IsNullOrEmpty(s);
        return hasValue ? Visibility.Visible : Visibility.Collapsed;
    }

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
    {
        throw new NotImplementedException();
    }
}

/// <summary>
/// Inverts a boolean value.
/// </summary>
internal sealed class NegateBoolConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        if (value is bool b) return !b;
        return false;
    }

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
    {
        if (value is bool b) return !b;
        return false;
    }
}
