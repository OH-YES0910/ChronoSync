namespace ChronoSync.Windows.Models;

/// <summary>
/// A single calibration point: video timestamp paired with OCR-read timer value.
/// </summary>
public sealed class CalibrationPoint
{
    /// <summary>Time position in the video (seconds)</summary>
    public double VideoTime { get; init; }

    /// <summary>Timer value read by OCR (seconds, e.g. 125.3 for 2:05.3)</summary>
    public double TimerValue { get; init; }

    public override string ToString() => $"time={VideoTime:F3}s timer={TimerValue:F3}s";
}
