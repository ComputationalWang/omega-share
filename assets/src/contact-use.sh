#!/usr/bin/env bash
# "In use" loops (OME-1405) from furniture-v2.png: a contact sheet (each loop as idle + frames, 1× and 4×, on the wall colour)
# and one 4× GIF per loop at its manifest frame time. Usage: contact-use.sh <atlas-dir> <out.png> [gif-dir]
set -euo pipefail
dir=$1 out=$2 gifs=${3:-}
tmp=$(mktemp -d)
python3 - "$dir/furniture-v2.json" >"$tmp/list" <<'PY'
import json, sys
a = json.load(open(sys.argv[1]))
ms = {p["id"]: p["use"]["ms"] for p in a["meta"]["omega"]["pieces"] if "use" in p}
geo = lambda k: "{w}x{h}+{x}+{y}".format(**a["frames"][k]["frame"])
for name, keys in a["animations"].items():
    _, pid, colour, _, d = name.split("/")
    print(f"{pid}-{colour}-{d}", ms[pid], geo(f"furniture/{pid}/{colour}/{d}/back"), *map(geo, keys))
PY
rows=()
while read -r name ms idle rest; do
  frames=()
  for g in "$idle" $rest; do
    i=${#frames[@]}
    magick "$dir/furniture-v2.png" -crop "$g" +repage "$tmp/$name-$i.png"
    frames+=("$tmp/$name-$i.png")
  done
  cells=()
  for i in "${!frames[@]}"; do
    lab=$([ "$i" = 0 ] && echo idle || echo "use $((i - 1))")
    magick \( "${frames[$i]}" -background '#6b5a7a' -flatten \) \( "${frames[$i]}" -filter point -resize 400% -background '#6b5a7a' -flatten \) \
      -background '#2a2133' -gravity south +append -bordercolor '#2a2133' -border 3 \
      -fill '#f3e6c9' -gravity north -splice 0x13 -pointsize 10 -annotate +0+1 "$lab" "$tmp/c-$name-$i.png"
    cells+=("$tmp/c-$name-$i.png")
  done
  magick "${cells[@]}" -background '#2a2133' -gravity south +append \
    -fill '#f3e6c9' -gravity west -splice 150x0 -pointsize 12 -annotate +6+0 "$name\n${ms} ms/frame" "$tmp/r-$name.png"
  rows+=("$tmp/r-$name.png")
  if [ -n "$gifs" ]; then
    mkdir -p "$gifs"
    magick -delay "$((ms / 10))" "${frames[@]:1}" -filter point -resize 400% -background '#6b5a7a' -alpha remove -loop 0 "$gifs/$name.gif"
  fi
done <"$tmp/list"
magick "${rows[@]}" -background '#2a2133' -gravity west -append -bordercolor '#2a2133' -border 6 "$out"
rm -r "$tmp"
