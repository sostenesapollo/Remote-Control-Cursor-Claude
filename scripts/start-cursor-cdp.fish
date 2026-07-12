#!/usr/bin/env fish
# Quit Cursor fully (Cmd+Q), then run this so CDP is on 9223.
osascript -e 'quit app "Cursor"' 2>/dev/null
sleep 2
open -a Cursor --args --remote-debugging-port=9223
echo "Started Cursor with CDP on 9223. Verify: curl http://127.0.0.1:9223/json"
