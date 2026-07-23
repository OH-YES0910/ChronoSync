using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace ChronoSync.Windows.Controls;

public partial class RegionSelectorView : UserControl
{
    // Drag state
    private bool _isDragging;
    private Point _dragStartCanvas;
    private Rect _dragStartSelectedRect; // current SelectedRect in canvas coords before drag
    private double _videoAspect = 16.0 / 9.0;

    public RegionSelectorView()
    {
        InitializeComponent();
        Loaded += (_, _) => RepositionOverlays();
        SizeChanged += (_, _) => RepositionOverlays();
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
        view.Dispatcher.BeginInvoke(new Action(view.RepositionOverlays), System.Windows.Threading.DispatcherPriority.Loaded);
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
        // Only update slider if not actively dragging and differs meaningfully
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
        var sel = SelectedRegion;
        if (!sel.IsEmpty && sel.Width > 0 && sel.Height > 0)
        {
            RegionInfoText.Text = $"已选: x={sel.X * 100:F1}% y={sel.Y * 100:F1}% w={sel.Width * 100:F1}% h={sel.Height * 100:F1}%";
            RegionInfoText.Foreground = new SolidColorBrush(Color.FromRgb(0xFF, 0x3B, 0x30));
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
        _dragStartSelectedRect = NormalizedToCanvas(SelectedRegion);

        _isDragging = true;
        OverlayCanvas.CaptureMouse();
        SelectedRect.Visibility = Visibility.Visible;
        e.Handled = true;
    }

    private void Overlay_MouseMove(object sender, MouseEventArgs e)
    {
        if (!_isDragging) return;

        var cur = e.GetPosition(FrameHost);
        var x = Math.Min(_dragStartCanvas.X, cur.X);
        var y = Math.Min(_dragStartCanvas.Y, cur.Y);
        var w = Math.Abs(cur.X - _dragStartCanvas.X);
        var h = Math.Abs(cur.Y - _dragStartCanvas.Y);

        var rect = new Rect(x, y, w, h);
        // Clip to video rect
        var videoRect = GetVideoRectInCanvas();
        if (!videoRect.IsEmpty)
        {
            if (rect.X < videoRect.X) { rect = new Rect(videoRect.X, rect.Y, Math.Max(0, rect.Width - (videoRect.X - rect.X)), rect.Height); }
            if (rect.Y < videoRect.Y) { rect = new Rect(rect.X, videoRect.Y, rect.Width, Math.Max(0, rect.Height - (videoRect.Y - rect.Y))); }
            if (rect.Right > videoRect.Right) rect = new Rect(rect.X, rect.Y, Math.Max(0, videoRect.Right - rect.X), rect.Height);
            if (rect.Bottom > videoRect.Bottom) rect = new Rect(rect.X, rect.Y, rect.Width, Math.Max(0, videoRect.Bottom - rect.Y));
        }

        Canvas.SetLeft(SelectedRect, rect.X);
        Canvas.SetTop(SelectedRect, rect.Y);
        SelectedRect.Width = rect.Width;
        SelectedRect.Height = rect.Height;
    }

    private void Overlay_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        if (!_isDragging) return;
        _isDragging = false;
        OverlayCanvas.ReleaseMouseCapture();

        var cur = e.GetPosition(FrameHost);
        var rect = new Rect(
            Math.Min(_dragStartCanvas.X, cur.X),
            Math.Min(_dragStartCanvas.Y, cur.Y),
            Math.Abs(cur.X - _dragStartCanvas.X),
            Math.Abs(cur.Y - _dragStartCanvas.Y));

        var norm = CanvasToNormalized(rect);
        // Reject tiny drags (< 1% in either dim)
        if (norm.Width < 0.01 || norm.Height < 0.01)
        {
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

    private void SeekSlider_DragCompleted(object sender, System.Windows.Controls.Primitives.DragCompletedEventArgs e)
    {
        CurrentTime = SeekSlider.Value;
        UpdateTimeText();
        RaiseEvent(new RoutedEventArgs(TimeChangedEvent, CurrentTime));
    }

    private void SeekSlider_PreviewMouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        // Handles click-without-drag: slider Thumb.DragCompleted only fires on actual drag
        if (Mouse.Captured == null)
        {
            CurrentTime = SeekSlider.Value;
            UpdateTimeText();
            RaiseEvent(new RoutedEventArgs(TimeChangedEvent, CurrentTime));
        }
    }

    private void RandomBtn_Click(object sender, RoutedEventArgs e)
    {
        RaiseEvent(new RoutedEventArgs(RandomSeekRequestedEvent));
    }

    #endregion
}