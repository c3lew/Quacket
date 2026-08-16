# QA artifacts — ticket #40 ("still pending" vs "could not file")

Run on 2026-08-16 against real `gh`, the throwaway private repo
`c3lew/quacket-qa-target`, and a real disk.

| file | what it is |
|---|---|
| `evidence.md` | the two acceptance sentences and their evidence — the judge's input |
| `leg-a-real-gh.log` | full console output of the real-`gh` walkthrough |
| `s1-events.json` … `s4-events.json` | what the shipped producer actually emitted — captured by leg A, replayed by leg B (`s4` is a pass per look, so [Check again] can be walked) |
| `qa40-*.png` | the browser observations, including the pre-fix row for comparison |
| `harness-leg-a.test.ts.txt` | the real-`gh` / real-disk harness |
| `harness-leg-b.tsx.txt`, `qa.html.txt` | the browser harness, kept as text so nothing builds it |

## Reopen it, one command

```
bash docs/qa/40/replay.sh          # the palette in a browser (prints the URLs)
bash docs/qa/40/replay.sh --legA   # the real-gh walkthrough, start to finish
```

`--legA` writes real issues to `c3lew/quacket-qa-target`. Never point it anywhere
else. It also rewrites the `s*-events.json` captures, which is the point: leg B
renders whatever the producer just said, not what QA typed.

## Not covered

The native shell — tray, global hotkey, the real Windows notification surface,
the updater. Both legs run outside Tauri.
