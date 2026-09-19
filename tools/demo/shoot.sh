#!/bin/zsh
# Capture README screenshots of the installed workflow, using demo data.
# Run it from Terminal: it needs permission to control Alfred and to record the screen.
# Usage: tools/demo/shoot.sh
here="${0:A:h}"
out="${here:h:h}/images"
helper="${TMPDIR:-/tmp/}alfred_window"
alfred() { osascript -e "tell application id \"com.runningwithcrayons.Alfred\" to search \"$1\"" }

swiftc -O "$here/alfred_window.swift" -o "$helper" || { echo "Couldn't build the window helper (needs Xcode Command Line Tools)" >&2; exit 1; }
"$here/demo.sh" on || exit 1
trap '"$here/demo.sh" off' EXIT
mkdir -p "$out"

shots=(
  "aliases|pmail "
  "actions|pmail ›k3v9x2mq7p@pxdmail.net "
  "create|pmnew Netflix"
  "email|pminbox ›k3v9x2mq7p@pxdmail.net ›E1 "
  "codes|pmcode "
)
for shot in $shots; do
  name="${shot%%|*}" query="${shot#*|}"
  alfred "$query"
  sleep 2
  id="$("$helper")" || { echo "Couldn't find the Alfred window" >&2; exit 1; }
  rm -f "$out/$name.png"
  screencapture -x -l "$id" "$out/$name.png" 2>/dev/null
  if [[ ! -s "$out/$name.png" ]]; then
    echo "Screen capture was blocked. Allow Terminal in System Settings → Privacy & Security → Screen & System Audio Recording, then run this again." >&2
    exit 1
  fi
  echo "✓ images/$name.png"
done
echo "Done. Press Esc to close Alfred."
