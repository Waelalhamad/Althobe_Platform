# Brand — الثوب العربي

Status: assets received 2026-09-24; vector logo received 2026-09-27. Used in the warehouse app.

Source files live in [`packages/ui/brand/`](../packages/ui/brand/):

```
logo.svg        the logo, vector (Illustrator export) — the master file
logo.png        the earlier raster logo, 186×192 px — superseded by logo.svg
palette.jpg     the four brand colours
fonts/          Somar by ArbFONTS, 18 .otf weights
```

Tagline, as it appears under the logo: **أصالة الآباء بأيدي الأبناء**

## Colour

| Token | Hex | Name | Use |
| --- | --- | --- | --- |
| `--brand-primary` | `#8A1913` | Deep red | Primary buttons, app header, active navigation, focus accents |
| `--brand-blush` | `#EBD8D2` | Blush | Page and card surfaces, selected rows |
| `--brand-stone` | `#DAD3CB` | Warm stone | Borders, dividers, secondary surfaces |
| `--brand-mauve` | `#AA999A` | Mauve grey | Muted text, placeholders, disabled states |

Rules:

- The deep red is an **accent**, not a background for large areas. White text on `#8A1913`
  passes contrast comfortably; use it for buttons and the header.
- Body text is near-black on blush or white, never mauve — `#AA999A` fails contrast as body text
  and is for secondary information only.
- **Scan feedback must not reuse the brand red.** "Not found" and "wrong item" use a distinct,
  brighter error red plus a sound and an icon; "found" uses green. Staff read these at a glance,
  from a distance, while holding a scanner, so the colour must never be ambiguous with the
  header.
- Every colour is defined once as a CSS custom property in `packages/ui`, with a dark-mode
  counterpart. Components never hard-code hex values.

## Typography

**Somar** (ArbFONTS) for Arabic and Latin.

- Bundle only four weights for the web: Regular (400), Medium (500), SemiBold (600), Bold (700),
  converted to `woff2`, with `font-display: swap`. The other 14 files stay in the brand folder.
- Numbers — quantities, barcodes, SKUs — use tabular figures so columns line up.
- **Digits 0–9 are drawn with the device's system font** (Segoe UI / Roboto / Arial), not Somar:
  Somar's Latin "0" is a small circle that reads as the Arabic five «٥», and its bold "8" looks
  like "a". In a stock system a misread quantity is a real error, so digits must be unambiguous.
  Implemented as a digits-only font face (`unicode-range`) in `packages/ui/src/theme.css`; all
  other text stays Somar.
- Barcodes and SKUs are always shown left-to-right, even inside RTL layouts (`dir="ltr"` on the
  element), because they are read and typed digit by digit.

## Logo

The master is `packages/ui/brand/logo.svg` (1200×1200 artboard, artwork centred). The app uses two
derived, tightly cropped files in `apps/warehouse/public/` — regenerate them if the master changes:

| File | Content | Used for |
| --- | --- | --- |
| `logo.svg` | Full logo: mark, «الثوب العربي», "Arab Thobe Co." | Login screen |
| `logo-mark.svg` | Round figure mark only | App header (on a white badge), browser tab icon |

The logo's red is `#86161A`, a hair darker than the palette's `#8A1913`; indistinguishable in use.


- Use the logo on the login screen and in the app header. Never stretch, recolour, or place it
  on the deep red.
- Keep clear space around it of at least the height of the Arabic wordmark.

## Open asset requests

| Needed | Why |
| --- | --- |
| **Somar licence confirmation** | ArbFONTS is a commercial foundry; confirm the licence covers embedding the font in a web app |
