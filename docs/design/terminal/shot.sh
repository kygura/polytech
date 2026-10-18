#!/bin/sh
# usage: ./shot.sh name.html  -> name-dark.png, name-light.png (1600x1000)
d=$(cd "$(dirname "$0")" && pwd); n=${1%.html}
for t in dark light; do chromium --headless=new --no-sandbox --disable-gpu --hide-scrollbars --window-size=1600,1000 --virtual-time-budget=4000 --screenshot="$d/$n-$t.png" "file://$d/$1?theme=$t" 2>/dev/null; done
