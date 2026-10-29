# Spreadsheet authoritative apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement inline task by task. Steps use checkbox syntax.

**Goal:** Implement approved Issue #24 spreadsheet-authoritative apply; one reviewed PR, merge, same private GAS deployment, remove worktree.
**Architecture:** New approval policy SHEET_AUTHORITATIVE stored in immutable approval and small ticket. Pure ApplyPolicy module replans the currently bound target against frozen sheet definitions; Jobs retains journals/reconciliation but accepts unrelated Gmail drift. A persisted post-apply report separates final differences from operation uncertainty. Legacy approvals remain strict.
**Tech Stack:** Plain JavaScript, node:test, Apps Script V8, existing Gmail/Sheets adapters.
**Spec:** docs/superpowers/specs/2026-10-29-sheet-authoritative-design.md; user's policy instruction; Issue #24.

## Global Constraints
- No real Gmail apply/retry during verification; owner/private URL/scopes remain unchanged.
- Preserve approval lifetime, owner/book checks, operation lock, sheet identity/definition checks, bounded attempts and no blind create retry.
- Force only approved managed keys; ALL includes NOOP rows, selected includes dependencies. Disabled/deletion rows govern deletions; Gmail-only filters are reported.
- Legacy saved approvals never silently acquire the new policy. New confirmations explicitly describe overwrite and post-apply verification.
- Properties hold summaries only; details stay in durable sheet data. Raw error text/filter definitions never enter Cloud diagnostics.

## Review Focus
- Label rename changes a linked filter's SPAM flag: ALL restores that unchanged row, selected preserves unselected drift and reports it.
- Remote edits after intent but before readback/old-ID deletion cannot cause duplicate creation or deletion of another managed ID.
- Late drift after a processed target yields a final difference report without infinite retries or false uncertainty.
- Large reports remain outside Properties; report identity/scope/rows are fenced on reload.
- Fresh ALL after legacy PAUSED resolves prior intent read-only; remaining confirmation retains original keys and never broadens silently.

### Task 1: Authoritative execution and persisted verification
**Files:** src/ApplyPolicy.js (new pure planning/report), src/Sync.js, src/Jobs.js, src/Runtime.js, scripts/build.js; tests/authoritative-jobs.test.js (new), integration tests as needed.
**Interfaces:** Approvals/tickets gain policy, scopeMode. ApplyPolicy exports name, plan(rows,labelRows,live,keys), entry(approval,source,rows,labelRows,live), report(approval,rows,labelRows,live). Jobs.view exposes policy and verification summary; jobs.verification(runId) returns persisted entries.
- [ ] Write failing real Jobs tests for ALL NOOP drift, selected/outside drift, pending LABEL plus SPAM change, current-ID edit/disappearance/delete, response loss, late final drift, sheet edits, legacy strict, fresh vs remaining scope and large report/reload.
- [ ] Run focused test expecting failures for missing policy/behavior.
- [ ] Implement pure planner, policy binding/validation, current-entry replan, policy-aware observation/reconciliation, final report persistence and read API.
- [ ] Run focused, full npm test, npm run check/build; verify actual stopped-data replay without mutations. Commit.

### Task 2: Confirmation and completion UI
**Files:** src/Web.js, Client.html, src/Menu.js, tests/authoritative-web.test.js (new), tests/client-authoritative.test.js (new), docs/background-jobs.md, README.md if applicable.
**Interfaces:** Web filterJobVerification returns jobs.verification with existing navigation decoration. Only SHEET_AUTHORITATIVE webApproval skips remote-hash invalidation. Client reads verification summary and fetches persisted entries on demand.
- [ ] Add failing confirmation tests for Gmail drift accepted vs sheet/expiry/supersession rejected; legacy/import/messages remain strict; confirmation copy includes overwrite policy.
- [ ] Add actual Client tests for completed-with-differences, readable report and no automatic apply resend; manual reload and stale/failed report read.
- [ ] Implement routes/copy and discrepancy detail cards, persist bounds, docs. Run focused/full/check/build; commit.

### Task 3: Review, integration and deployment
**Files:** ignored ledger/evidence; final changes only as reviewed.
- [ ] Package whole-branch independent review, rule on all findings, material fixes RED→GREEN and full suite/check/build.
- [ ] PR Closes #24; wait CI, merge, verify final main and CI.
- [ ] Push allowlisted installer, update existing runtime, exact source readback; immutable GAS version and existing private deployment; live read-only UI verification.
- [ ] Archive report/evidence; remove created worktree and merged branch. Issue closed; final results and limitations reported.
