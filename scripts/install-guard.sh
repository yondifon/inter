#!/bin/sh
# `make install` guard: refuse the two states that cannot produce a working
# install. The app must be launched from the installing user's GUI session, so
# a root-owned install is not something this step can fix later.
app=${1:-/Applications/Inter.app}

if [ "$(id -u)" -eq 0 ]; then
  echo "install: do not run make install with sudo — an app installed as root cannot be opened from your session"
  exit 1
fi

if [ -d "$app" ] && [ "$(stat -f %u "$app")" -eq 0 ]; then
  echo "install: $app is owned by root from an earlier sudo install; remove it first:"
  echo "  sudo rm -rf $app"
  exit 1
fi

exit 0
