using ChronoSync.Windows.Models;

namespace ChronoSync.Windows.Services;

/// <summary>
/// Theil-Sen regression and offset calculation.
/// Replicates app.js calculateBestOffset():
/// 1. Theil-Sen regression for each video (videoTime = slope * timerValue + intercept)
/// 2. Outlier filtering: remove points with residual > 1.5s
/// 3. Calculate offset at median timer value (not T=0 extrapolation)
/// 4. Consistency check: MAD-based outlier adjustment
/// </summary>
public static class OffsetCalculationService
{
    /// <summary>
    /// Calculate offsets for all videos relative to the first video (baseline).
    /// </summary>
    /// <param name="videoData">Dictionary of videoId → calibration points</param>
    /// <returns>Dictionary of videoId → offset seconds (0 for baseline)</returns>
    public static Dictionary<string, double> CalculateOffsets(
        Dictionary<string, List<CalibrationPoint>> videoData)
    {
        var videosWithEnoughPoints = videoData
            .Where(kv => kv.Value.Count >= 2)
            .ToList();

        if (videosWithEnoughPoints.Count < 2)
            return videoData.Keys.ToDictionary(k => k, _ => 0.0);

        var offsets = new Dictionary<string, double>();

        // First video is baseline (offset = 0)
        var baseVideo = videosWithEnoughPoints[0];
        offsets[baseVideo.Key] = 0;

        var basePoints = baseVideo.Value;
        var baseReg = TheilSenRegression(basePoints);
        if (baseReg is null)
            return videoData.Keys.ToDictionary(k => k, _ => 0.0);

        // Collect all timer values for median calculation
        var allTimerValues = basePoints.Select(p => p.TimerValue).ToList();

        for (int i = 1; i < videosWithEnoughPoints.Count; i++)
        {
            var (videoId, points) = videosWithEnoughPoints[i];

            // Initial regression
            var reg = TheilSenRegression(points);
            if (reg is null)
            {
                offsets[videoId] = 0;
                continue;
            }

            // Outlier filtering: remove points with residual > 1.5s (matching app.js)
            var filteredPoints = points;
            if (points.Count > 3)
            {
                var residuals = points
                    .Select(p => Math.Abs(p.VideoTime - (reg.Slope * p.TimerValue + reg.Intercept)))
                    .ToList();
                var sortedResiduals = residuals.OrderBy(x => x).ToList();
                double median = sortedResiduals[sortedResiduals.Count / 2];
                double threshold = Math.Max(1.5, median * 2.5);
                var filtered = points
                    .Where((p, idx) => residuals[idx] < threshold)
                    .ToList();

                if (filtered.Count >= 2 && filtered.Count < points.Count)
                {
                    filteredPoints = filtered;
                    reg = TheilSenRegression(filteredPoints);
                    if (reg is null)
                    {
                        offsets[videoId] = 0;
                        continue;
                    }
                }
            }

            // Collect timer values for median
            allTimerValues.AddRange(filteredPoints.Select(p => p.TimerValue));

            // Calculate offset at median timer value (not T=0)
            allTimerValues.Sort();
            double medianTimer = allTimerValues[allTimerValues.Count / 2];

            double baseTimeAtMedian = baseReg.Slope * medianTimer + baseReg.Intercept;
            double targetTimeAtMedian = reg.Slope * medianTimer + reg.Intercept;
            double offset = targetTimeAtMedian - baseTimeAtMedian;

            offsets[videoId] = offset;
        }

        // Consistency check: MAD-based outlier adjustment (matching app.js)
        var nonZeroOffsets = offsets.Values.Where(o => Math.Abs(o) > 0.0001).ToList();
        if (nonZeroOffsets.Count > 1)
        {
            nonZeroOffsets.Sort();
            double medianOffset = nonZeroOffsets[nonZeroOffsets.Count / 2];
            double mad = nonZeroOffsets.Average(o => Math.Abs(o - medianOffset));

            foreach (var (videoId, offset) in offsets)
            {
                if (Math.Abs(offset) < 0.0001) continue;

                if (Math.Abs(offset - medianOffset) > Math.Max(2.0, mad * 3))
                {
                    // Weighted correction toward median (matching app.js)
                    offsets[videoId] = offset * 0.3 + medianOffset * 0.7;
                }
            }
        }

        return offsets;
    }

    /// <summary>
    /// Theil-Sen robust regression.
    /// Returns videoTime = slope * timerValue + intercept.
    /// Replicates app.js theilSenRegression(points).
    /// </summary>
    public static TheilSenResult? TheilSenRegression(List<CalibrationPoint> points)
    {
        if (points.Count < 2) return null;

        // Calculate all pair slopes: ΔvideoTime / ΔtimerValue
        var slopes = new List<double>();
        for (int i = 0; i < points.Count; i++)
        {
            for (int j = i + 1; j < points.Count; j++)
            {
                double dt = points[j].TimerValue - points[i].TimerValue;
                if (Math.Abs(dt) > 0.001) // Avoid division by zero
                {
                    double dv = points[j].VideoTime - points[i].VideoTime;
                    slopes.Add(dv / dt);
                }
            }
        }

        if (slopes.Count == 0) return null;

        // Median slope
        slopes.Sort();
        double medianSlope = slopes[slopes.Count / 2];

        // Median intercept: intercept = videoTime - slope × timerValue
        var intercepts = points
            .Select(p => p.VideoTime - medianSlope * p.TimerValue)
            .OrderBy(x => x)
            .ToList();
        double medianIntercept = intercepts[intercepts.Count / 2];

        return new TheilSenResult
        {
            Slope = medianSlope,
            Intercept = medianIntercept
        };
    }
}
