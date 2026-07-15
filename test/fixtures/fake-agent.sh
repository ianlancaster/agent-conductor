#!/bin/sh
# Stand-in for a real agent CLI in E2E tests. Ignores all flags; echoes any
# piped initial prompt as PROMPT: lines, then reads interactively from the
# terminal and echoes every line as GOT: <line>.
echo "FAKE AGENT START"

if [ ! -t 0 ]; then
  while IFS= read -r line; do
    echo "PROMPT: $line"
  done
fi

exec </dev/tty
while IFS= read -r line; do
  echo "GOT: $line"
done
