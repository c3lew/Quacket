# Attaching images to GitHub issues programmatically

> Research for issue #4. Researched 2026-07-16 against GitHub official docs, `cli/cli` maintainer statements, community discussions, and empirical `gh api` probes (read-only; nothing was uploaded or created).

## TL;DR + recommendation

GitHub has **no public API** for the "drag-and-drop" attachment flow that produces `github.com/user-attachments/assets/<uuid>` URLs. The endpoint behind it (`POST github.com/upload/policies/assets`) **only accepts browser session cookies — a `gh` CLI token does not work** (verified empirically: a token-authenticated POST returns an HTML error page, not JSON; the `gh` maintainers have repeatedly closed attachment-support requests as "no API, not planned").

**Recommended mechanism: commit the annotated screenshot to an orphan assets branch in the *target repo itself* via the documented Contents API** (`PUT /repos/{owner}/{repo}/contents/{path}`), then reference it in the issue body:

- **Public repo** → embed inline with the immutable raw URL: `![shot](https://raw.githubusercontent.com/{owner}/{repo}/{commit_sha}/{path})` — renders inline via GitHub's camo proxy.
- **Private repo** → camo cannot authenticate, so inline `![...]` rendering is impossible with any token-based mechanism. Embed a **blob link** instead: `[screenshot](https://github.com/{owner}/{repo}/blob/{commit_sha}/{path})` — one click, renders on GitHub, and visibility is exactly the repo's visibility (no leak).

Why this wins: it is 100% documented API surface, works with the exact token `gh auth` already holds (`repo` scope), asset visibility automatically equals repo visibility (screenshots of a private repo can never leak), and Quacket only ever files issues to the **user's own repos**, so push access is guaranteed. The cost: an extra branch in the repo (contained, deletable) and no inline rendering for private repos (a fundamental platform limitation, not a flaw of this option).

Optional future add-on: a "power mode" using the undocumented cookie flow for true inline attachments in private repos — explicitly *not* recommended as the core mechanism (see option A).

## Comparison table

| Option | Documented API? | Works with `gh` token? | Scope needed | Asset privacy | Inline render in issue | Pollution / cleanup | Reliability risk |
|---|---|---|---|---|---|---|---|
| **A. Undocumented `user-attachments` upload** (browser drag-drop endpoint) | No | **No — requires browser `user_session` cookie** | n/a (cookie = full account access) | Best: inherits repo visibility; private-repo assets need login + short-lived signed S3 URLs | Yes — public *and* private | None (GitHub-hosted CDN) | **High** — internal endpoint, may change without notice; cookie extraction fragile on Windows |
| **B. Commit to assets branch in target repo (Contents API)** ⭐ | Yes | Yes | `repo` (already held) | Exactly repo visibility — no leak possible | Public: yes (raw URL via camo). Private: **no** — link only | Orphan branch + binary blobs in repo; deletable | **Low** — stable documented API |
| B'. Separate dedicated assets repo | Yes | Yes | `repo` | **Leak risk**: a public assets repo exposes private-repo screenshots; a private assets repo breaks rendering for everyone else | Same as B, keyed to *assets repo* visibility | Central; keeps target repos clean | Low, but visibility-mismatch footgun |
| **C. Gists** | Partially — **API is text-only; binary requires git push to the gist's repo** | Yes (API for create; git-over-HTTPS for binary) | `gist` (already held) | **Weak** — "secret" gists are access-by-URL, *anyone* with the link can view → private screenshots leak | Yes (gist raw URLs are anonymous, camo-friendly) | Gists pile up in the user's gist list | Medium — two-step (API create + git push) is clunky |
| **D. Release assets** | Yes | Yes | `repo` | Public repo: anonymous download. Private repo: auth required → broken inline | Public: yes. Private: no | **Worst** — needs a tag + release per upload (or a rolling junk release); very visible in repo UI | Low API risk, high weirdness |
| **E. `gh` CLI native** | — | — | — | — | — | — | **Does not exist.** cli/cli #1895/#4228/#4465/#12960/#13637 all closed: "If there's an API for this, we'll support it. But until then…" (maintainer @BagToad, 2025) |

## Per-option detail

### A. Undocumented browser upload endpoint (`upload/policies/assets` → S3 → `user-attachments`)

**Current shape** (as reverse-engineered by the `gh-image` extension and community discussions #29993/#46951):

1. Authenticate with a **`user_session` browser cookie** (not a token).
2. GET the target repo page and scrape an `uploadToken` from embedded JS (only issued to users with write access).
3. `POST github.com/upload/policies/assets` (name, size, content_type, repository_id, authenticity/upload token) → returns pre-signed S3 form fields.
4. POST the file to S3 with those fields.
5. Callback `PUT github.com/upload/assets/{id}` to finalize → final URL `https://github.com/user-attachments/assets/<uuid>`.

**Auth**: token auth is rejected. Empirically verified here: `gh api --method POST https://github.com/upload/policies/assets ...` with the `gho_` OAuth token returns GitHub's generic HTML error page. Community reports show 404/422 for PAT attempts; the `gh` team confirms "the upload flow requires a browser".

**Privacy**: the *gold standard*. Since May 2023 ("More secure private attachments" changelog), attachments uploaded in a private repo's context require login + repo access; views go through short-lived signed `private-user-images.githubusercontent.com` URLs. Public-repo attachments are anonymous-by-URL.

**Why not for Quacket core**: (1) stealing `user_session` from the browser's encrypted cookie store is exactly what Chrome's App-Bound Encryption on Windows is designed to block — fragile and antivirus-triggering for a shipped desktop app; (2) the cookie is an unscoped full-account credential — far worse to hold than the `gh` token; (3) the endpoint is internal and changes without notice; (4) asking users to paste a session cookie is a non-starter UX for non-technical users.

### B. Assets branch in the target repo via Contents API ⭐ recommended

- `PUT /repos/{owner}/{repo}/contents/.quacket/assets/{timestamp}-{slug}.png` with base64 body, `branch: "quacket-assets"` (create the orphan branch on first use via git-data or Contents API). Documented, versioned API, `repo` scope — which `gh auth` tokens already carry (verified: current token has `gist, read:org, repo, workflow`).
- Reference by **commit SHA**, not branch name, so the URL is immutable even if the branch is later pruned or force-pushed.
- **Public repo**: `raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}` is anonymous → camo proxies it → true inline `![...]` rendering.
- **Private repo**: `raw.githubusercontent.com` requires auth; camo has no credentials → inline images render as **broken**. Use a `github.com/.../blob/{sha}/{path}` **link** instead: works for every viewer who can see the issue (same ACL), one click away. This is the correct trade — access control is inherited perfectly.
- **Pollution**: one extra branch, binary blobs in repo objects. Contained: the branch never touches default-branch history, and deleting the branch (accepting broken old links) or the whole path is trivial. 10 MB-class screenshots are far below any limit (Contents API caps at 100 MB per file, warns >50 MB).
- **Size limits**: screenshots (PNG, typically <5 MB) are a non-issue.

### B'. Dedicated assets repo (e.g. `{user}/quacket-assets`)

Same mechanics, one central place, target repos stay pristine. Fatal flaw: the assets repo has **one** visibility. Public → every screenshot of every private repo is world-readable (unacceptable default for a screenshot tool). Private → nothing renders inline anywhere and even blob links break for collaborators without access to the assets repo. Only sensible if Quacket ever targets exclusively-public repos; not worth the mismatch risk.

### C. Gists

- The REST Gists API **cannot create binary files** — file content is a JSON string; images must be pushed to the gist's underlying git repo afterwards (two-step: `POST /gists` with a placeholder, then git push over HTTPS with the token).
- "Secret" gists are **not private**: not listed/searchable, but anyone holding the URL can view the raw image anonymously. For a tool whose screenshots may show private-repo UI, secrets, or user data, security-by-obscurity is the wrong default.
- Rendering works (gist raw URLs are anonymous, camo-friendly) and the token already has `gist` scope — but the privacy model plus the clunky two-step disqualify it.

### D. Release assets

- Fully documented (`POST` to the release's `upload_url`, `Content-Type` set, raw binary body). Reliable.
- But an asset must hang off a **release**, which must hang off a **tag** — so either Quacket creates a junk rolling release ("quacket-screenshots") that sits at the top of the repo's Releases page, or a tag per batch. Highly visible pollution in exactly the part of the repo UI users curate.
- Private repos: `browser_download_url` requires auth → same broken-inline problem as B, with strictly worse pollution. Dominated by B.

### E. `gh` CLI native

`gh issue create` / `gh issue comment` have **no attachment support**. Requested since 2020 (#1895), re-requested for agentic workflows (#12960, closed 2025 as duplicate; maintainer: *"we don't have an API… using releases and branches for things like this have known limitations. Maintaining these fragile things are not desirable. If there's an API for this, we'll support it."*). Community extensions (`gh-image`, `gh-attach`, `gitshot`) all fall back to option A's cookie flow. Conclusion: nothing to build on today, but **watch cli/cli** — if GitHub ever ships a public attachments API, `gh` will adopt it quickly and Quacket should migrate to it.

## Implications for Quacket

1. **Ship option B as the single mechanism.** Fork on repo visibility at issue-create time (`GET /repos/{owner}/{repo}` → `private` field, one call, already needed for repo pickers):
   - public → `![annotated screenshot](raw URL pinned to commit SHA)`
   - private → `[View annotated screenshot](blob URL pinned to commit SHA)` (optionally plus the `![...]` line commented out, in case GitHub ever proxies private raws)
2. **Set expectations in UI for private repos**: the issue will contain a screenshot *link*, not an inline image. This is a GitHub platform limitation — *no* token-based mechanism can inline-render in private repos; only the browser drag-drop flow can.
3. **Escape hatch UX**: after creating the issue, offer "Open in browser" — the user can drag the same PNG into the issue on github.com if they want the inline `user-attachments` rendering in a private repo. Zero engineering, uses GitHub's own flow.
4. **Branch hygiene**: use one well-named orphan branch (`quacket-assets`), path-namespaced files (`.quacket/assets/2026-07-16-title-slug.png`), reference by SHA. Document that deleting the branch breaks old issue images.
5. **Failure mode**: Contents API write requires push access. Quacket targets the user's own repos so this always holds; still, surface a clear error if a 403/404 comes back (e.g. archived repo).
6. **Watch for a public attachments API** (community discussions #29993/#46951 are the canonical asks; cli/cli will implement fast if it lands). If it ships, migrate: it would give inline-private rendering with token auth and zero repo pollution.

## Sources

- GitHub Docs — [Attaching files](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files) (types, 10 MB image limit, private-repo access rules)
- GitHub Changelog — [More secure private attachments](https://github.blog/changelog/2023-05-09-more-secure-private-attachments/) (private attachments require login since 2023)
- GitHub Docs — [About anonymized URLs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-anonymized-urls) (camo proxy; cannot fetch authenticated content)
- GitHub Docs — [REST: Contents](https://docs.github.com/en/rest/repos/contents), [REST: Release assets](https://docs.github.com/en/rest/releases/assets), [REST: Gists](https://docs.github.com/en/rest/gists/gists) (text content; >10 MB requires git clone), [Creating gists](https://docs.github.com/en/get-started/writing-on-github/editing-and-sharing-content-with-gists/creating-gists) ("Secret gists aren't private")
- cli/cli — [#12960 support image/file attachments](https://github.com/cli/cli/issues/12960) (closed as duplicate; maintainer @BagToad quote), [#13256 user-attachments CDN proposal](https://github.com/cli/cli/issues/13256), [#13637](https://github.com/cli/cli/issues/13637), [#4465](https://github.com/cli/cli/issues/4465), [discussion #4745](https://github.com/cli/cli/discussions/4745)
- Community discussions — [#29993 Equivalent API for upload/policies/assets](https://github.com/orgs/community/discussions/29993), [#46951 upload files to an existing issue by REST API](https://github.com/orgs/community/discussions/46951), [#31303 upload/policies/assets 404](https://github.com/community/community/discussions/31303)
- [gh-image extension](https://github.com/drogers0/gh-image) (documents the current cookie → uploadToken → policies/assets → S3 → finalize flow; "undocumented internal GitHub API that may change without notice"; `user_session` = full account access)
- Marek Šuppa — [Uploading images to GitHub PRs from the CLI](https://mareksuppa.com/til/github-pr-images-from-cli/) (token cannot call the endpoint; recommends release assets for CLI-only)
- Rehab Ragab — [How GitHub Handles Attachments](https://rehababotalep.github.io/posts/github-attachments/) (short-lived signed S3 URLs for private attachments)
- Empirical (this research, read-only): `gh api --method POST https://github.com/upload/policies/assets` with the local `gho_` OAuth token (`gist, read:org, repo, workflow` scopes) returns GitHub's HTML error page — token auth is rejected; endpoint is cookie-only.
