param(
    [Parameter(Mandatory = $true)]
    [string]$InputPath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$processorSource = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class PixelArtSpriteProcessor
{
    private const int LogicalSize = 64;
    private const int UsableSize = 58;
    private const int OutputSize = 256;

    public static void Process(string inputPath, string outputPath)
    {
        using (var source = new Bitmap(inputPath))
        using (var working = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb))
        {
            using (var graphics = Graphics.FromImage(working))
            {
                graphics.CompositingMode = CompositingMode.SourceCopy;
                graphics.DrawImageUnscaled(source, 0, 0);
            }

            var pixels = ReadPixels(working);
            ClearConnectedBackground(pixels, working.Width, working.Height);
            var bounds = FindVisibleBounds(pixels, working.Width, working.Height);
            if (bounds.Width == 0 || bounds.Height == 0)
                throw new InvalidOperationException("Aucun pixel visible detecte dans " + inputPath);

            var logical = ResampleToLogicalGrid(pixels, working.Width, bounds);
            var outputPixels = UpscaleLogicalGrid(logical);

            using (var output = new Bitmap(OutputSize, OutputSize, PixelFormat.Format32bppArgb))
            {
                WritePixels(output, outputPixels);
                var fullOutputPath = Path.GetFullPath(outputPath);
                Directory.CreateDirectory(Path.GetDirectoryName(fullOutputPath));
                output.Save(fullOutputPath, ImageFormat.Png);
            }
        }
    }

    private static int[] ReadPixels(Bitmap bitmap)
    {
        var rectangle = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
        var data = bitmap.LockBits(rectangle, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var result = new int[bitmap.Width * bitmap.Height];
            for (var y = 0; y < bitmap.Height; y++)
            {
                var row = IntPtr.Add(data.Scan0, y * data.Stride);
                Marshal.Copy(row, result, y * bitmap.Width, bitmap.Width);
            }
            return result;
        }
        finally
        {
            bitmap.UnlockBits(data);
        }
    }

    private static void WritePixels(Bitmap bitmap, int[] pixels)
    {
        var rectangle = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
        var data = bitmap.LockBits(rectangle, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        try
        {
            for (var y = 0; y < bitmap.Height; y++)
            {
                var row = IntPtr.Add(data.Scan0, y * data.Stride);
                Marshal.Copy(pixels, y * bitmap.Width, row, bitmap.Width);
            }
        }
        finally
        {
            bitmap.UnlockBits(data);
        }
    }

    private static void ClearConnectedBackground(int[] pixels, int width, int height)
    {
        var visited = new bool[pixels.Length];
        var queue = new Queue<int>();

        for (var x = 0; x < width; x++)
        {
            queue.Enqueue(x);
            queue.Enqueue(((height - 1) * width) + x);
        }
        for (var y = 1; y < height - 1; y++)
        {
            queue.Enqueue(y * width);
            queue.Enqueue((y * width) + width - 1);
        }

        while (queue.Count > 0)
        {
            var index = queue.Dequeue();
            if (visited[index])
                continue;
            visited[index] = true;

            if (!IsBackgroundPixel(pixels[index]))
                continue;

            pixels[index] = 0;
            var x = index % width;
            var y = index / width;
            if (x > 0) queue.Enqueue(index - 1);
            if (x < width - 1) queue.Enqueue(index + 1);
            if (y > 0) queue.Enqueue(index - width);
            if (y < height - 1) queue.Enqueue(index + width);
        }
    }

    private static bool IsBackgroundPixel(int argb)
    {
        var alpha = (argb >> 24) & 255;
        if (alpha < 16)
            return true;

        var red = (argb >> 16) & 255;
        var green = (argb >> 8) & 255;
        var blue = argb & 255;
        var minimum = Math.Min(red, Math.Min(green, blue));
        var maximum = Math.Max(red, Math.Max(green, blue));
        return minimum >= 205 && maximum - minimum <= 24;
    }

    private static Rectangle FindVisibleBounds(int[] pixels, int width, int height)
    {
        var left = width;
        var top = height;
        var right = -1;
        var bottom = -1;

        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                if (((pixels[(y * width) + x] >> 24) & 255) < 128)
                    continue;
                left = Math.Min(left, x);
                right = Math.Max(right, x);
                top = Math.Min(top, y);
                bottom = Math.Max(bottom, y);
            }
        }

        return right < left || bottom < top
            ? Rectangle.Empty
            : Rectangle.FromLTRB(left, top, right + 1, bottom + 1);
    }

    private static int[] ResampleToLogicalGrid(int[] source, int sourceWidth, Rectangle bounds)
    {
        var result = new int[LogicalSize * LogicalSize];
        var scale = Math.Min((double)UsableSize / bounds.Width, (double)UsableSize / bounds.Height);
        var targetWidth = Math.Max(1, (int)Math.Round(bounds.Width * scale));
        var targetHeight = Math.Max(1, (int)Math.Round(bounds.Height * scale));
        var offsetX = (LogicalSize - targetWidth) / 2;
        var offsetY = (LogicalSize - targetHeight) / 2;

        for (var targetY = 0; targetY < targetHeight; targetY++)
        {
            var sourceY = bounds.Top + Math.Min(
                bounds.Height - 1,
                (int)Math.Floor(((targetY + 0.5) * bounds.Height) / targetHeight));
            for (var targetX = 0; targetX < targetWidth; targetX++)
            {
                var sourceX = bounds.Left + Math.Min(
                    bounds.Width - 1,
                    (int)Math.Floor(((targetX + 0.5) * bounds.Width) / targetWidth));
                var color = source[(sourceY * sourceWidth) + sourceX];
                if (((color >> 24) & 255) < 128)
                    continue;

                result[((offsetY + targetY) * LogicalSize) + offsetX + targetX] = QuantizeOpaque(color);
            }
        }

        return result;
    }

    private static int QuantizeOpaque(int argb)
    {
        var red = QuantizeChannel((argb >> 16) & 255);
        var green = QuantizeChannel((argb >> 8) & 255);
        var blue = QuantizeChannel(argb & 255);
        return unchecked((int)0xFF000000) | (red << 16) | (green << 8) | blue;
    }

    private static int QuantizeChannel(int value)
    {
        return Math.Min(255, Math.Max(0, (int)Math.Round(value / 17.0) * 17));
    }

    private static int[] UpscaleLogicalGrid(int[] logical)
    {
        var result = new int[OutputSize * OutputSize];
        var scale = OutputSize / LogicalSize;
        for (var y = 0; y < LogicalSize; y++)
        {
            for (var x = 0; x < LogicalSize; x++)
            {
                var color = logical[(y * LogicalSize) + x];
                if (((color >> 24) & 255) == 0)
                    continue;
                for (var dy = 0; dy < scale; dy++)
                {
                    var row = ((y * scale) + dy) * OutputSize;
                    for (var dx = 0; dx < scale; dx++)
                        result[row + (x * scale) + dx] = color;
                }
            }
        }
        return result;
    }
}
'@

if (-not ("PixelArtSpriteProcessor" -as [type])) {
    $runtimeDirectory = Split-Path -Parent ([System.Drawing.Bitmap].Assembly.Location)
    $drawingAssemblies = @(
        (Get-ChildItem -LiteralPath (Join-Path $runtimeDirectory "ref") -Filter "*.dll").FullName
        [System.Drawing.Bitmap].Assembly.Location
        (Join-Path $runtimeDirectory "System.Private.Windows.GdiPlus.dll")
        (Join-Path $runtimeDirectory "System.Private.Windows.Core.dll")
    )
    Add-Type -TypeDefinition $processorSource -ReferencedAssemblies $drawingAssemblies
}
[PixelArtSpriteProcessor]::Process($InputPath, $OutputPath)
