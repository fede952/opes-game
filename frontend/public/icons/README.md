# PWA Icons

Drop your PNG icon files here before running a production build.

| File | Size | Purpose |
|---|---|---|
| `icon-192.png` | 192×192 px | Standard home-screen icon (Android, Chrome) |
| `icon-512.png` | 512×512 px | High-res icon + splash screen (Android) |

## Requirements
- Format: **PNG** (not SVG — iOS and Android require PNG for PWA icons)
- Colour space: sRGB
- The 512×512 file is also used as the **maskable** icon — keep the main
  artwork inside the central 80% "safe zone" so it's not cropped when the OS
  applies a circular or squircle mask.

## Suggested design
A Roman gold coin (roman-gold `#D4AF37`) on a dark background (roman-dark
`#2C2A29`) with the letter **Ω** or **SPQR** in the centre.

## iOS "Add to Home Screen"
iOS uses `<link rel="apple-touch-icon">` (declared in index.html) rather
than the manifest. The same 192×192 PNG works fine for both.
