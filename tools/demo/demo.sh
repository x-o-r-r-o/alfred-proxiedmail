#!/bin/zsh
# Switch the installed workflow to demo data for screenshots, and back.
# Usage: tools/demo/demo.sh on|off
bundle="com.x-o-r-r-o.alfred.proxiedmail"
dir="${TMPDIR}proxiedmail-demo"
case "$1" in
  on)
    rm -rf "$dir"
    python3 "${0:A:h}/make_fixtures.py" "$dir" >/dev/null
    osascript -e "tell application id \"com.runningwithcrayons.Alfred\" to set configuration \"PM_FIXTURES\" to value \"$dir\" in workflow \"$bundle\" without exportable"
    echo "Demo mode on: pmail, pmnew, pminbox and pmcode now show sample data. Run 'tools/demo/demo.sh off' when done." ;;
  off)
    osascript -e "tell application id \"com.runningwithcrayons.Alfred\" to remove configuration \"PM_FIXTURES\" in workflow \"$bundle\""
    rm -rf "$dir"
    echo "Demo mode off." ;;
  *) echo "Usage: $0 on|off"; exit 1 ;;
esac
