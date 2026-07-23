using System.Globalization;
using System.Windows;
using System.Windows.Data;
using ChronoSync.Windows.ViewModels;

namespace ChronoSync.Windows;

public partial class MainWindow : Window
{
    // Static converters for XAML binding
    public static readonly IValueConverter StringToVisConverter = new NullOrEmptyToVisibilityConverter();
    public static readonly IValueConverter InvertBoolConverter = new NegateBoolConverter();

    public MainWindow()
    {
        InitializeComponent();
        Closed += (_, _) =>
        {
            if (DataContext is MainViewModel vm)
                vm.Dispose();
        };
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
