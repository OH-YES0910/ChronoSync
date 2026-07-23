namespace ChronoSync.Windows.Models;

/// <summary>
/// Theil-Sen regression result: videoTime = slope * timerValue + intercept
/// </summary>
public sealed class TheilSenResult
{
    public double Slope { get; init; }
    public double Intercept { get; init; }
}

/// <summary>
/// Per-video offset calculation result.
/// </summary>
public sealed class OffsetResult
{
    public string VideoId { get; init; } = string.Empty;
    public double OffsetSeconds { get; init; }
    public int CalibrationPointCount { get; init; }
    public bool IsValid => CalibrationPointCount >= 2;
}
