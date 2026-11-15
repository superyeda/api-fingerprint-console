#!/bin/bash
set -u
ROOT="$(/usr/bin/dirname "$0")"
/usr/bin/python3 "${ROOT:?}/launch.py"
status=$?
if [ "$status" -ne 0 ]; then
  printf '\n启动未完成，按回车关闭窗口。'
  read -r _
fi
exit "$status"
