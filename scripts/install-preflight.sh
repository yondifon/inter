#!/bin/sh
# `make install` pre-flight: warn about tasks in flight before the retiring
# broker stops them. The new build's `inflight` answers:
#   0  nothing in flight — continue silently
#   1  tasks in flight — prompt on a terminal, warn and continue in a script
#   2  could not check — the running broker's database is not readable by
#      this build, which is the normal case on an upgrade (the new binary
#      refuses an older schema); warn and continue, the install is about to
#      start the new broker anyway.
#
# INTER_INSTALL_YES=1 skips the prompt: an install that cannot be overridden
# is worse than one that destroys work quietly.
bin=$1
install_yes=$2

"$bin" inflight
code=$?
case "$code" in
  0) exit 0 ;;
  2)
    echo "install: could not check for in-flight tasks — the running broker's database is not readable by this build; continuing"
    exit 0
    ;;
esac

if [ -t 0 ] && [ -z "$install_yes" ]; then
  printf 'Stop them and continue? [y/N] '
  read -r reply
  case "$reply" in
    [yY]*) exit 0 ;;
    *) echo "install aborted"; exit 1 ;;
  esac
fi
echo "install: continuing anyway (non-interactive)"
exit 0
