namespace ChronoSync.Windows.Models;

/// <summary>
/// Timer region in percentage coordinates relative to the video frame.
/// Maps to the selector/object-fit:contain coordinate system.
/// </summary>
public sealed class TimerRegion
{
    /// <summary>X position as percentage (0-100)</summary>
    public double X { get; init; }

    /// <summary>Y position as percentage (0-100)</summary>
    public double Y { get; init; }

    /// <summary>Width as percentage (0-100)</summary>
    public double W { get; init; }

    /// <summary>Height as percentage (0-100)</summary>
    public double H { get; init; }

    public override string ToString() => $"x={X:F1}% y={Y:F1}% w={W:F1}% h={H:F1}%";
}
