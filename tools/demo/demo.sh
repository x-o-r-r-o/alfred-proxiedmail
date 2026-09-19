#!/bin/zsh
# Switch the installed workflow to demo data for screenshots, and back.
# Usage: tools/demo/demo.sh on|off
bundle="com.x-o-r-r-o.alfred.proxiedmail"
dir="${TMPDIR:-/tmp/}proxiedmail-demo"
alfred() { osascript -e "tell application id \"com.runningwithcrayons.Alfred\" to $1" }

case "$1" in
  on)
    rm -rf "$dir"
    python3 "${0:A:h}/make_fixtures.py" "$dir" >/dev/null
    [[ -f "$dir/GET_proxy-bindings.json" ]] || { echo "Couldn't write demo data to $dir" >&2; exit 1; }
    alfred "set configuration \"PM_FIXTURES\" to value \"$dir\" in workflow \"$bundle\" without exportable" \
      || { echo "Couldn't set the demo variable in Alfred (is the workflow installed, and may this terminal control Alfred?)" >&2; exit 1; }
    echo "Demo mode on: pmail, pmnew, pminbox and pmcode now show sample data. Run 'tools/demo/demo.sh off' when done." ;;
  off)
    alfred "remove configuration \"PM_FIXTURES\" in workflow \"$bundle\"" \
      || { echo "Couldn't remove the demo variable in Alfred" >&2; exit 1; }
    rm -rf "$dir"
    echo "Demo mode off." ;;
  *) echo "Usage: $0 on|off"; exit 1 ;;
esac
