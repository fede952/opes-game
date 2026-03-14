# PWA Icons

## What's already here

| File | Status | Used for |
|---|---|---|
| `icon.svg` | ✅ **committed** | Browser favicon, Android Chrome PWA icon (scales to any size) |
| `icon-192.png` | ⚠️ **needs to be added** | Standard Android home-screen icon |
| `icon-512.png` | ⚠️ **needs to be added** | High-res splash screen (Android) |

## How to generate the PNG files from the SVG

You only need to do this once before a production deployment.

**Option A — Squoosh (browser, no install):**
1. Open squoosh.app
2. Upload `icon.svg`
3. Export as PNG at 192×192 → save as `icon-192.png`
4. Repeat at 512×512 → save as `icon-512.png`

**Option B — Inkscape CLI:**
```bash
inkscape icon.svg --export-type=png --export-filename=icon-192.png -w 192 -h 192
inkscape icon.svg --export-type=png --export-filename=icon-512.png -w 512 -h 512
```

**Option C — ImageMagick:**
```bash
convert -background none icon.svg -resize 192x192 icon-192.png
convert -background none icon.svg -resize 512x512 icon-512.png
```

## PNG requirements

- Format: **PNG** with transparency preserved
- The 512×512 file doubles as the **maskable** icon. All artwork sits inside
  the central 80% safe zone (≈ 410×410 px), so Android can safely crop it
  into a circle, squircle, or square without clipping the design.

## iOS "Add to Home Screen"

iOS ignores the Web App Manifest entirely. Safari uses the
`<link rel="apple-touch-icon" href="/icons/icon-192.png">` tag in `index.html`.
The same 192×192 PNG works for both Android and iOS home screens.
Until the PNG is added, iOS will use a screenshot of the page as the icon.
