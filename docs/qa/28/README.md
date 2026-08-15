# QA artifacts — slice #28 (startup reconciliation)

Run on 2026-08-16 against real `gh`, the throwaway private repo
`c3lew/quacket-qa-target`, and a real disk.

| file | what it is |
|---|---|
| `evidence.md` | every acceptance sentence and the evidence gathered for it — the judge's input |
| `leg-a-real-gh.log` | full console output of the real-`gh` walkthrough |
| `qa28-story30-recovered-done.png` | a recovered report arriving on the Done screen |
| `qa28-story29-capture-usable-while-github-hangs.png` | the capture box, usable, while GitHub never answers |
| `qa28-recovery-does-not-steal-a-half-typed-report.png` | a recovery landing mid-sentence leaves the typing alone |
| `harness-*.txt`, `qa.html.txt` | the throwaway harness, kept as text so nothing builds it |

## Reopen it, one command

```
bash docs/qa/28/replay.sh          # the palette in a browser (prints the three URLs)
bash docs/qa/28/replay.sh --legA   # the real-gh walkthrough, start to finish
```

`--legA` writes real issues to `c3lew/quacket-qa-target`. Never point it anywhere else.
