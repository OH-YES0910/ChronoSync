using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace ChronoSync.Windows.Controls;

public partial class RegionSelectorView : UserControl
{
    // Drag state
    private bool _isDragging;
    private Point _dragStartCanvas;
    private double _videoAspect = 16.0 / 9.0;

    // Debounce for slider ValueChanged -> avoid spamming frame extraction during drag
    private DispatcherTimer? _seekDebounce;

    public RegionSelectorView()
    {
        InitializeComponent();
        Loaded += (_, _) => RepositionOverlays();
        SizeChanged += (_, _) => RepositionOverlays();

        _seekDebounce = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromMilliseconds(60)
        };
        _seekDebounce.Tick += (_, _) =>
        {
            _seekDebounce!.Stop();
            RaiseEvent(new RoutedEventArgs(TimeChangedEvent, CurrentTime));
        };
    }

    #region Dependency Properties

    public static readonly DependencyProperty CurrentFrameProperty =
        DependencyProperty.Register(
            nameof(CurrentFrame),
            typeof(BitmapSource),
            typeof(RegionSelectorView),
            new PropertyMetadata(null, OnCurrentFrameChanged));

    public BitmapSource? CurrentFrame
    {
        get => (BitmapSource?)GetValue(CurrentFrameProperty);
        set => SetValue(CurrentFrameProperty, value);
    }

    private static void OnCurrentFrameChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        var view = (RegionSelectorView)d;
        view.FrameImage.Source = e.NewValue as BitmapSource;
        if (e.NewValue is BitmapSource bmp && bmp.PixelWidth > 0 && bmp.PixelHeight > 0)
        {
            view._videoAspect = (double)bmp.PixelWidth / bmp.PixelHeight;
        }
        view.Dispatcher.BeginInvoke(new Action(view.RepositionOverlays), DispatcherPriority.Loaded);
    }

    public static readonly DependencyProperty DurationProperty =
        DependencyProperty.Register(
            nameof(Duration),
            typeof(double),
            typeof(RegionSelectorView),
            new PropertyMetadata(100.0, OnDurationChanged));

    public double Duration
    {
        get => (double)GetValue(DurationProperty);
        set => SetValue(DurationProperty, value);
    }

    private static void OnDurationChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        var view = (RegionSelectorView)d;
        view.SeekSlider.Maximum = Math.Max(0.0001, (double)e.NewValue);
        view.UpdateTimeText();
    }

    public static readonly DependencyProperty CurrentTimeProperty =
        DependencyProperty.Register(
            nameof(CurrentTime),
            typeof(double),
            typeof(RegionSelectorView),
            new FrameworkPropertyMetadata(0.0,
                FrameworkPropertyMetadataOptions.BindsTwoWayByDefault,
                OnCurrentTimeChanged));

    public double CurrentTime
    {
        get => (double)GetValue(CurrentTimeProperty);
        set => SetValue(CurrentTimeProperty, value);
    }

    private static void OnCurrentTimeChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        var view = (RegionSelectorView)d;
        var newVal = (double)e.NewValue;
        if (!view.SeekSlider.IsKeyboardFocusWithin && Math.Abs(view.SeekSlider.Value - newVal) > 0.001)
        {
            view.SeekSlider.Value = Math.Clamp(newVal, view.SeekSlider.Minimum, view.SeekSlider.Maximum);
        }
        view.UpdateTimeText();
    }

    public static readonly DependencyProperty AutoDetectedRegionProperty =
        DependencyProperty.Register(
            nameof(AutoDetectedRegion),
            typeof(Rect),
            typeof(RegionSelectorView),
            new PropertyMetadata(Rect.Empty, OnAutoDetectedRegionChanged));

    public Rect AutoDetectedRegion
    {
        get => (Rect)GetValue(AutoDetectedRegionProperty);
        set => SetValue(AutoDetectedRegionProperty, value);
    }

    private static void OnAutoDetectedRegionChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        var view = (RegionSelectorView)d;
        view.RepositionOverlays();
        view.UpdateRegionInfo();
    }

    public static readonly DependencyProperty SelectedRegionProperty =
        DependencyProperty.Register(
            nameof(SelectedRegion),
            typeof(Rect),
            typeof(RegionSelectorView),
            new PropertyMetadata(Rect.Empty, OnSelectedRegionChanged));

    public Rect SelectedRegion
    {
        get => (Rect)GetValue(SelectedRegionProperty);
        set => SetValue(SelectedRegionProperty, value);
    }

    private static void OnSelectedRegionChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        var view = (RegionSelectorView)d;
        view.RepositionOverlays();
        view.UpdateRegionInfo();
    }

    #endregion

    #region Routed Events

    public static readonly RoutedEvent TimeChangedEvent =
        EventManager.RegisterRoutedEvent(nameof(TimeChanged), RoutingStrategy.Bubble,
            typeof(RoutedEventHandler), typeof(RegionSelectorView));

    public event RoutedEventHandler TimeChanged
    {
        add => AddHandler(TimeChangedEvent, value);
        remove => RemoveHandler(TimeChangedEvent, value);
    }

    public static readonly RoutedEvent RegionSelectedEvent =
        EventManager.RegisterRoutedEvent(nameof(RegionSelected), RoutingStrategy.Bubble,
            typeof(RoutedEventHandler), typeof(RegionSelectorView));

    public event RoutedEventHandler RegionSelected
    {
        add => AddHandler(RegionSelectedEvent, value);
        remove => RemoveHandler(RegionSelectedEvent, value);
    }

    public static readonly RoutedEvent RandomSeekRequestedEvent =
        EventManager.RegisterRoutedEvent(nameof(RandomSeekRequested), RoutingStrategy.Bubble,
            typeof(RoutedEventHandler), typeof(RegionSelectorView));

    public event RoutedEventHandler RandomSeekRequested
    {
        add => AddHandler(RandomSeekRequestedEvent, value);
        remove => RemoveHandler(RandomSeekRequestedEvent, value);
    }

    #endregion

    #region Coordinate Mapping (object-fit:contain)

    /// <summary>
    /// Compute the actual rectangle the video occupies inside FrameHost
    /// (matching CSS object-fit:contain: letterbox if aspect mismatches).
    /// </summary>
    private Rect GetVideoRectInCanvas()
    {
        double hostW = FrameHost.ActualWidth;
        double hostH = FrameHost.ActualHeight;
        if (hostW <= 0 || hostH <= 0) return Rect.Empty;

        double viewAspect = hostW / hostH;
        double w, h;
        if (viewAspect > _videoAspect)
        {
            // View wider than video -> letterbox left/right
            h = hostH;
            w = hostH * _videoAspect;
        }
        else
        {
            w = hostW;
            h = hostW / _videoAspect;
        }
        double x = (hostW - w) / 2.0;
        double y = (hostH - h) / 2.0;
        return new Rect(x, y, w, h);
    }

    /// <summary>
    /// Map a normalized 0-1 Rect (within the video frame) to canvas coordinates.
    /// </summary>
    private Rect NormalizedToCanvas(Rect norm)
    {
        var videoRect = GetVideoRectInCanvas();
        if (videoRect.IsEmpty || norm.IsEmpty) return Rect.Empty;
        return new Rect(
            videoRect.X + norm.X * videoRect.Width,
            videoRect.Y + norm.Y * videoRect.Height,
            norm.Width * videoRect.Width,
            norm.Height * videoRect.Height);
    }

    /// <summary>
    /// Map a canvas-coordinate Rect (clipped to video rect) to normalized 0-1.
    /// </summary>
    private Rect CanvasToNormalized(Rect canvasRect)
    {
        var videoRect = GetVideoRectInCanvas();
        if (videoRect.IsEmpty || videoRect.Width <= 0 || videoRect.Height <= 0) return Rect.Empty;

        // Clip to video rect
        double x = Math.Max(canvasRect.X, videoRect.X);
        double y = Math.Max(canvasRect.Y, videoRect.Y);
        double right = Math.Min(canvasRect.Right, videoRect.Right);
        double bottom = Math.Min(canvasRect.Bottom, videoRect.Bottom);
        double w = right - x;
        double h = bottom - y;
        if (w < 0) w = 0;
        if (h < 0) h = 0;

        return new Rect(
            (x - videoRect.X) / videoRect.Width,
            (y - videoRect.Y) / videoRect.Height,
            w / videoRect.Width,
            h / videoRect.Height);
    }

    #endregion

    #region Layout / Reposition

    private void RepositionOverlays()
    {
        var auto = NormalizedToCanvas(AutoDetectedRegion);
        if (!auto.IsEmpty && AutoDetectedRegion.Width > 0 && AutoDetectedRegion.Height > 0)
        {
            Canvas.SetLeft(AutoRect, auto.X);
            Canvas.SetTop(AutoRect, auto.Y);
            AutoRect.Width = auto.Width;
            AutoRect.Height = auto.Height;
            AutoRect.Visibility = Visibility.Visible;
        }
        else
        {
            AutoRect.Visibility = Visibility.Collapsed;
        }

        var sel = NormalizedToCanvas(SelectedRegion);
        if (!sel.IsEmpty && SelectedRegion.Width > 0 && SelectedRegion.Height > 0)
        {
            Canvas.SetLeft(SelectedRect, sel.X);
            Canvas.SetTop(SelectedRect, sel.Y);
            SelectedRect.Width = sel.Width;
            SelectedRect.Height = sel.Height;
            SelectedRect.Visibility = Visibility.Visible;
        }
        else
        {
            SelectedRect.Visibility = Visibility.Collapsed;
        }
    }

    private void UpdateTimeText()
    {
        TimeText.Text = $"{CurrentTime:F2}s / {Duration:F2}s";
    }

    private void UpdateRegionInfo()
    {
        // Show DetectedRegion if set, else SelectedRegion, else hint
        var detected = AutoDetectedRegion;
        var sel = SelectedRegion;

        if (!sel.IsEmpty && sel.Width > 0 && sel.Height > 0)
        {
            RegionInfoText.Text = $"已框选: x={sel.X * 100:F1}% y={sel.Y * 100:F1}% w={sel.Width * 100:F1}% h={sel.Height * 100:F1}%";
            RegionInfoText.Foreground = new SolidColorBrush(Color.FromRgb(0xFF, 0x3B, 0x30));
        }
        else if (!detected.IsEmpty && detected.Width > 0 && detected.Height > 0)
        {
            RegionInfoText.Text = $"已识别: x={detected.X * 100:F1}% y={detected.Y * 100:F1}% w={detected.Width * 100:F1}% h={detected.Height * 100:F1}%";
            RegionInfoText.Foreground = new SolidColorBrush(Color.FromRgb(0xFF, 0x95, 0x00));
        }
        else
        {
            RegionInfoText.Text = "未选择区域 — 在视频帧上拖动鼠标框选";
            RegionInfoText.Foreground = new SolidColorBrush(Color.FromRgb(0x66, 0x66, 0x66));
        }
    }

    #endregion

    #region Mouse Drag

    private void Overlay_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        var videoRect = GetVideoRectInCanvas();
        if (videoRect.IsEmpty) return;

        _dragStartCanvas = e.GetPosition(FrameHost);
        _isDragging = true;
        FrameHost.CaptureMouse();

        // Initialize SelectedRect at the click point
        Canvas.SetLeft(SelectedRect, _dragStartCanvas.X);
        Canvas.SetTop(SelectedRect, _dragStartCanvas.Y);
        SelectedRect.Width = 0;
        SelectedRect.Height = 0;
        SelectedRect.Visibility = Visibility.Visible;
        e.Handled = true;
    }

    private void Overlay_MouseMove(object sender, MouseEventArgs e)
    {
        if (!_isDragging) return;

        var cur = e.GetPosition(FrameHost);
        // Top-left = min(start, current), width/height = abs(current - start)
        var x = Math.Min(_dragStartCanvas.X, cur.X);
        var y = Math.Min(_dragStartCanvas.Y, cur.Y);
        var w = Math.Abs(cur.X - _dragStartCanvas.X);
        var h = Math.Abs(cur.Y - _dragStartCanvas.Y);

        // Clip to video rect (so box doesn't extend into letterbox bars)
        var videoRect = GetVideoRectInCanvas();
        if (!videoRect.IsEmpty)
        {
            if (x < videoRect.X) { w -= videoRect.X - x; x = videoRect.X; }
            if (y < videoRect.Y) { h -= videoRect.Y - y; y = videoRect.Y; }
            if (x + w > videoRect.Right) w = Math.Max(0, videoRect.Right - x);
            if (y + h > videoRect.Bottom) h = Math.Max(0, videoRect.Bottom - y);
        }
        if (w < 0) w = 0;
        if (h < 0) h = 0;

        Canvas.SetLeft(SelectedRect, x);
        Canvas.SetTop(SelectedRect, y);
        SelectedRect.Width = w;
        SelectedRect.Height = h;
    }

    private void Overlay_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        if (!_isDragging) return;
        _isDragging = false;
        FrameHost.ReleaseMouseCapture();

        var cur = e.GetPosition(FrameHost);
        var canvasRect = new Rect(
            Math.Min(_dragStartCanvas.X, cur.X),
            Math.Min(_dragStartCanvas.Y, cur.Y),
            Math.Abs(cur.X - _dragStartCanvas.X),
            Math.Abs(cur.Y - _dragStartCanvas.Y));

        var norm = CanvasToNormalized(canvasRect);
        // Reject tiny drags (< 2% in either dim)
        if (norm.Width < 0.02 || norm.Height < 0.02)
        {
            // Restore previous selected region (or hide)
            RepositionOverlays();
            return;
        }

        SelectedRegion = norm;
        UpdateRegionInfo();
        RaiseEvent(new RoutedEventArgs(RegionSelectedEvent, norm));
        e.Handled = true;
    }

    #endregion

    #region Seek Slider

    private void SeekSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        // Sync CurrentTime (TwoWay binding) and update display
        if (Math.Abs(CurrentTime - e.NewValue) > 0.001)
        {
            CurrentTime = e.NewValue;
        }
        UpdateTimeText();

        // Debounce TimeChanged so we don't spam frame extraction during drag
        _seekDebounce?.Stop();
        _seekDebounce?.Start();
    }

    private void SeekSlider_DragCompleted(object sender, DragCompletedEventArgs e)
    {
        // Fire immediately on release to ensure final frame loads
        _seekDebounce?.Stop();
        RaiseEvent(new RoutedEventArgs(TimeChangedEvent, CurrentTime));
    }

    private void RandomBtn_Click(object sender, RoutedEventArgs e)
    {
        RaiseEvent(new RoutedEventArgs(RandomSeekRequestedEvent));
    }

    #endregion
}