# QA artifacts — slice #28 (startup reconciliation)

Run on 2026-08-16 against real `gh`, the throwaway private repo
`c3lew/quacket-qa-target`, and a real disk. Two runs are kept: the first found
the duplicate-report blocker (#37); the `*-rerun*` files are the run after that
fix landed.

| file | what it is |
|---|---|
| `evidence-rerun.md` | the re-run after #37 — every acceptance sentence and its evidence (the judge's input) |
| `leg-a-real-gh-rerun.log` | full console output of the re-run's real-`gh` walkthrough |
| `qa28-rerun-*.png` | the re-run's browser observations |
| `harness-leg-a-s9.ts.txt` | the scenario added in the re-run: an identical title must not count as a match. Append it to `harness-leg-a.test.ts.txt` to replay it |
| `evidence.md` | the first run — kept because it is what #37 was filed from |
| `leg-a-real-gh.log` | full console output of the first run's real-`gh` walkthrough |
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
