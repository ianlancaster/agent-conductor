#!/bin/sh
# Stand-in for a real agent CLI in E2E tests. Ignores all flags; echoes any
# piped initial prompt as PROMPT: lines, then reads interactively from the
# terminal and echoes every line as GOT: <line>.
echo "FAKE SESSION START"
# Claude-style input prompt glyph: the delivery queue treats visible runtime
# chrome as "process is up" — without it, deliveries queue until an event.
echo "❯ "

if [ ! -t 0 ]; then
  while IFS= read -r line; do
    echo "PROMPT: $line"
  done
fi

exec </dev/tty
while IFS= read -r line; do
  echo "GOT: $line"
done
