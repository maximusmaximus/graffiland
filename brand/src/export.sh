#!/usr/bin/env bash
# Rebuild the whole kit from src/build.py: SVG -> svgo -> PNG/ICO/PDF -> preview sheet.
# Needs: python3 (fonttools, uharfbuzz, shapely, Pillow), rsvg-convert, node/npx (svgo), pdfunite optional.
set -euo pipefail
F="$(cd "$(dirname "$0")/.." && pwd)"; cd "$F"
python3 src/build.py
if command -v npx >/dev/null; then npx -y svgo@3 --config src/svgo.config.cjs -q -r -f svg -f social; fi
rm -rf png pdf; mkdir -p png favicon pdf social
for s in svg/*.svg; do n=$(basename "$s" .svg)
  case "$n" in
    sprayland-mark-favicon) continue ;;
    sprayland-mark-small-*) rsvg-convert -w 512 "$s" -o "png/$n-512.png" ;;
    *) for w in 512 2048; do rsvg-convert -w $w "$s" -o "png/$n-$w.png"; done ;;
  esac
done
# favicons (simplified mark at <=48 px)
rsvg-convert -w 32  svg/sprayland-mark-favicon.svg -o favicon/favicon-32.png
rsvg-convert -w 180 svg/sprayland-mark-favicon.svg -o favicon/apple-touch-icon-180.png
rsvg-convert -w 512 svg/sprayland-mark-dark.svg    -o favicon/icon-512.png
cp svg/sprayland-mark-favicon.svg favicon/favicon.svg
T=$(mktemp -d); for s in 16 32 48; do rsvg-convert -w $s svg/sprayland-mark-favicon.svg -o "$T/ico$s.png"; done
python3 - "$T" <<'P'
import sys; from PIL import Image
t=sys.argv[1]; ims=[Image.open(f'{t}/ico{s}.png').convert('RGBA') for s in (16,32,48)]
ims[2].save('favicon/favicon.ico',sizes=[(16,16),(32,32),(48,48)],append_images=ims[:2])
P
# social
rsvg-convert -w 1000 social/sprayland-social-avatar.svg -o social/sprayland-social-avatar-1000.png
rsvg-convert -w 400  social/sprayland-social-avatar.svg -o social/sprayland-social-avatar-400.png
rsvg-convert -w 1200 social/sprayland-og-image.svg -o social/sprayland-og-image-1200x630.png
rsvg-convert -w 2400 social/sprayland-og-image.svg -o social/sprayland-og-image-2400x1260.png
# one PDF, one logo per page (page size = artwork size)
P=""; for n in lockup-dark lockup-light lockup-black lockup-stacked-dark lockup-stacked-light lockup-stacked-black \
              mark-dark mark-light mark-black mark-favicon wordmark-dark wordmark-light wordmark-black; do P="$P svg/sprayland-$n.svg"; done
rsvg-convert -f pdf $P -o pdf/sprayland-logos.pdf
python3 src/preview.py "$T"
rm -rf "$T"
echo "export ok"
