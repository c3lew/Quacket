# QA artifacts — slice #29 (a previous report as a status, not a wall)

Run on 2026-08-16 against real `gh`, the throwaway private repo
`c3lew/quacket-qa-target`, and a real disk.

| file | what it is |
|---|---|
| `evidence.md` | every acceptance sentence and its evidence — the judge's input |
| `leg-a-real-gh.log` | full console output of the real-`gh` walkthrough |
| `qa29-ac*.png` | the browser observations, one per acceptance point |
| `harness-leg-a.test.ts.txt` | the real-`gh` / real-disk harness |
| `harness-leg-b.tsx.txt`, `qa.html.txt` | the browser harness, kept as text so nothing builds it |
| `harness-hidden.test.ts.txt` | the follow-up check: does a hidden palette still notify with a draft in progress |

## Reopen it, one command

```
bash docs/qa/29/replay.sh          # the palette in a browser (prints the URLs)
bash docs/qa/29/replay.sh --legA   # the real-gh walkthrough, start to finish
```

`--legA` writes real issues to `c3lew/quacket-qa-target`. Never point it anywhere
else.

## Not covered

The native shell — tray, global hotkey, the real Windows notification surface,
the updater. Both legs run outside Tauri, so "an OS notification was raised"
means the app issued it with that exact text, not that Windows drew a toast.
