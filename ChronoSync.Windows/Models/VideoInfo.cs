using System.IO;

namespace ChronoSync.Windows.Models;

public sealed class VideoInfo
{
    public string Id { get; init; } = Guid.NewGuid().ToString("N")[..9];
    public required string FilePath { get; init; }
    public string Name => Path.GetFileName(FilePath);
    public double Duration { get; set; }
    public int VideoWidth { get; set; }
    public int VideoHeight { get; set; }
}
