---
name: interface-review
description: "Review a code change for interface regressions: read both sides of the diff, expand to the surfaces it renders in, classify each finding as introduced, regression or pre-existing, and give a verdict. Use on a branch, worktree, commit range or PR that touches src/renderer. Reads code only; for driving the running app use ux-walkthrough."
---

# Interface change review

This skill reviews a change rather than a screen. The author is asking "did I make this worse?". Report what the change caused and stay mostly quiet about what it merely touched.

Correctness, tests, security and performance belong to the Reviewer. Name such a concern once and move on.

The resource files [scope-resolution.md](scope-resolution.md) and [removed-signals.md](removed-signals.md) may mention `better-*` skills. Those are not installed here, so use the rules in this file.

## 1. Resolve the scope

Use the target you were given (`pr <n>`, a branch, a ref, a range). With none, the base is `dev`, the integration branch:

1. `HEAD` is ahead of `git merge-base origin/dev HEAD`: that range plus any uncommitted changes, stating both counts.
2. The working tree is dirty: the uncommitted changes.
3. Neither: stop. State the facts and offer the last commit by short SHA, a named target, or an open PR. Never fall back to `HEAD~1` on your own, and never report a review of nothing as `Approve`.

Exclude lockfiles, snapshots, generated output and binaries, and name what you excluded.

## 2. Expand to surfaces

A changed file is evidence, not the review subject. Review the surfaces it renders in: its direct importers, one hop. Go a second hop only for `styles/tokens.css`, `lib/theme.ts` and `components/ui` or `components/layout`, where one line reaches the whole product. Review at most five consumers and state how many you skipped.

## 3. Read the removed lines

Read the `-` side of every hunk against removed-signals.md. A removal is a regression only when nothing in the change replaces it.

## 4. Check against OrgAI's rules

Use Conventions in `.orgai/ARCHITECTURE.md`, plus `frontend-design` and `better-accessibility`:

- Tokens only; both themes; no uppercase micro-labels; one primary action per region.
- `components/ui` and `components/layout` used; nothing floating over the canvas; no `div` with `onClick`; no native `confirm()`.
- Status words from `lib/runStatus.ts`, costs through `costView` and `Cost`.
- Focus ring, keyboard path, names, reduced motion.
- e2e selectors updated in the same change.

## 5. Hold it to its intent

Read the brief, the PR text and the commit messages, then ask whether the interface delivers them. Look for what is absent: a new variant missing hover, focus, disabled or loading; a new component with no empty, error or narrow state; a control added to one surface but not its siblings. Do not report scope creep.

## 6. Classify and rate

Status, by what the diff touched:

- `Introduced`: the change created it.
- `Regression`: the change weakened something previously correct.
- `Pre-existing`: present nearby but not caused by this change.

Confirm with `git blame -L <line>,<line> <base> -- <file>` when it matters.

Severity: `HIGH` prevents a task, hides content from assistive technology, or breaks one theme or a required size. `MEDIUM` makes an interaction meaningfully harder or breaks a project convention visibly. `LOW` is isolated polish.

Use one row per root cause, at most 12 rows, and state how many you left out.

## 7. Never change the working tree

The review is read-only. `git fetch` is fine. `git checkout`, `git switch`, `git stash` and `gh pr checkout` are not. Mark visual and runtime claims `Not verified` unless you actually rendered them.

## Output

Open with a scope table: target, base ref and SHA, head ref and SHA, commits and uncommitted files, files in scope, excluded, surfaces expanded and skipped.

Then findings:

| Severity | Status | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- |

With no `Introduced` or `Regression` findings, say "No actionable interface findings in this change."

Then at most three `Pre-existing` findings, stated plainly as not this change's responsibility. They sit outside the row limit and the verdict.

End with `Block` when any `HIGH` `Introduced` or `Regression` finding remains, `Approve` otherwise, and list what was not verified.
