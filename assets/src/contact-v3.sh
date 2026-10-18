#!/usr/bin/env bash
# Contact sheet for the furniture v3 polish (OME-1377): wallclock, neonsign and pouf frames from furniture-v2.png,
# each at 1× and 4× (nearest-neighbour) on the room's wall colour. Usage: contact-v3.sh <atlas-dir> <out.png> [label]
set -euo pipefail
dir=$1 out=$2 label=${3:-}
tmp=$(mktemp -d)
python3 - "$dir/furniture-v2.json" >"$tmp/list" <<'PY'
import json, sys
fr = json.load(open(sys.argv[1]))["frames"]
for k, v in fr.items():
    if any(s in k for s in ("wallclock", "neonsign", "pouf/")):
        f = v["frame"]
        print(k.split("/", 1)[1].replace("/back", "").replace("/", "-"), f"{f['w']}x{f['h']}+{f['x']}+{f['y']}")
PY
tiles=()
while read -r name geo; do
  magick "$dir/furniture-v2.png" -crop "$geo" +repage "$tmp/$name.png"
  magick \( "$tmp/$name.png" -background '#6b5a7a' -flatten \) \( "$tmp/$name.png" -filter point -resize 400% -background '#6b5a7a' -flatten \) \
    -background '#2a2133' -gravity south +append -bordercolor '#2a2133' -border 4 \
    -fill '#f3e6c9' -gravity north -splice 0x14 -pointsize 11 -annotate +0+1 "$name" "$tmp/t-$name.png"
  tiles+=("$tmp/t-$name.png")
done <"$tmp/list"
magick montage "${tiles[@]}" -tile 4x -geometry +2+2 -background '#2a2133' "$tmp/sheet.png"
if [ -n "$label" ]; then
  magick "$tmp/sheet.png" -fill '#f3e6c9' -background '#2a2133' -gravity north -splice 0x20 -pointsize 15 -annotate +0+2 "$label" "$out"
else
  cp "$tmp/sheet.png" "$out"
fi
rm -r "$tmp"
