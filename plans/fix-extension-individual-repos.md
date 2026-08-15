# Engineering Plan: Fix GitRec Extension on GitHub Repository Pages

## Executive Summary

GitRec no longer renders "Related repositories" on `github.com/:owner/:repo`. GitHub migrated repository pages from server-rendered Rails templates (Primer CSS) to Primer React (`SplitPageLayout` + CSS modules). Three dependencies in `extension/content.js` broke:

1. **Activation gate** — `content.js:10` gates the entire repo path on `$("#repo-stars-counter-star").length > 0`. That element is gone, so `loadSimilarRepos()` is never called.
2. **Injection target** — `content.js:109` appends to `$(".BorderGrid:first")`, which matches nothing under the React sidebar.
3. **Timing** — the extension runs once at `document_end` via `$(document).ready()`. There is no `MutationObserver`, polling, or retry anywhere in `extension/` (verified by grep). React mounts the sidebar after that point.

The homepage still works because `splits.length === 0` takes a different branch (`content.js:18-21`) that never touches the star counter.

**Sequencing note:** the user-visible break is roughly four lines. Phase 0 and Phase 1 land that fix and ship it. Refactoring, tests, and navigation hardening follow on a known-working baseline. Do not invert this order — every selector below is a hypothesis until Phase 0 confirms it against live markup.

---

## Phase 0: Capture Ground Truth (blocking prerequisite)

**Goal:** Replace inherited guesses with observed DOM. Every selector in this plan came from reading [SimRepo PR #21](https://github.com/Mubelotix/SimRepo/pull/21); none has been checked against today's `github.com`.

- [ ] **0.1** Open a repository page (e.g. `github.com/gorse-io/gorse`) in a logged-in browser and capture the right sidebar's outer HTML — the container holding About / Releases / Packages / Contributors / Languages.
- [ ] **0.2** Record the exact attributes on the sidebar container and the wrapper that holds the section list. CSS-module class names are content-hashed (`CodeViewSidebar-module__borderGrid__<hash>`), so match on `[class*=...]` prefix, never the full string.
- [ ] **0.3** Check whether these legacy Primer utility classes still resolve to styles on repository pages: `BorderGrid-row`, `BorderGrid-cell`, `h4`, `mb-3`, `f6`, `color-fg-muted`, `Link--primary`, `repo-language-color`. This repo ships **no CSS of its own** (`find . -name "*.css"` returns nothing) — the injected card is entirely dependent on GitHub's stylesheets.
- [ ] **0.4** Capture the homepage dashboard markup and confirm whether `[aria-label='Explore']` (`content.js:161`) and `dashboard-changelog` / `dashboard-changelog__title` (`content.js:164-165`) still exist.
- [ ] **0.5** Confirm which soft-navigation events GitHub currently emits (`turbo:render`, `turbo:load`, `pjax:end`, `navigate`) by logging listeners on a repo-to-repo click.

**Exit criteria:** the selector chain in Phase 1.2 is rewritten to match observed markup, and 0.3/0.4 have yes/no answers that decide whether Phase 1.4 and Phase 1.5 are needed.

---

## Phase 1: Minimal Fix (ship this)

**Goal:** Restore rendering on repository pages with the smallest change that works. One commit, verified manually, before any refactor.

- [ ] **1.1 Replace the activation gate.** Drop the `#repo-stars-counter-star` check. GitRec only ever tested that element's *existence* (`.length > 0`) — it never reads the star value — so nothing else depends on it. Gate on path shape instead, and let sidebar resolution be the real confirmation (see 1.3):

  ```js
  // /:owner/:repo — reject reserved top-level routes by shape, not by list
  function extractRepoInfo(pathname = location.pathname) {
      const [owner, repo] = pathname.split('/').filter(Boolean);
      if (!owner || !repo) return null;
      if (owner.includes('.') || repo.includes('.')) return null;  // e.g. /site.com
      return { owner, repo, itemId: `${owner}:${repo}` };
  }
  ```

  **Do not build a reserved-path denylist.** The plan's earlier draft listed `/settings`, `/orgs`, `/marketplace`, `/explore`, `/notifications`, `/pulls`, `/issues`, `/search` — and still missed `/topics`, `/collections`, `/sponsors`, `/apps`, `/codespaces`, `/new`, `/login`, `/about`, `/features`, `/enterprise`, `/security`, `/trending`. The list is unbounded and GitHub keeps adding to it. A path that looks like a repo but has no repository sidebar simply fails sidebar resolution and injects nothing — which is the correct outcome for `/settings/profile` and for `/owner/repo/issues` alike.

- [ ] **1.2 Add a fallback selector chain** (rewrite from Phase 0 findings; ordering is most-specific-first):

  ```js
  const SIDEBAR_SELECTORS = [
      '[data-component="SplitPageLayout.Pane"] [class*="CodeViewSidebar-module__borderGrid__"]',
      'rails-partial[data-partial-name="codeViewRepoRoute.Sidebar"] .BorderGrid',
      '.Layout-sidebar .BorderGrid',
      '[data-testid="repository-sidebar"]',
      '.BorderGrid',
  ];

  function getSidebarElement(root = document) {
      for (const sel of SIDEBAR_SELECTORS) {
          const el = root.querySelector(sel);
          if (el) return el;
      }
      return null;
  }
  ```

  Note the earlier draft's `.Layout-sidebar > div` was removed — it is broad enough to match an unrelated first child and inject the card into the wrong container.

- [ ] **1.3 Wait for the sidebar before injecting.** `MutationObserver` on `document.body` with `{childList: true, subtree: true}`, resolving on first successful `getSidebarElement()`, plus a ~5s timeout that gives up silently. Timeout expiry is the signal that this is not a repository overview page.
- [ ] **1.4 Fix the injected card's own classes** — **only if 0.3 shows they are dead.** `content.js:102-103` builds the card with `BorderGrid-row` / `BorderGrid-cell`. Fixing the target selector while leaving these stale produces a card that mounts but renders unstyled, which reads as "still broken."
- [ ] **1.5 Fix the homepage selectors** — **only if 0.4 shows they are dead.** Same fallback-chain treatment for `[aria-label='Explore']`.
- [ ] **1.6 Manual verification** against a live repo page, a repo subpath, and the homepage. Then commit.

---

## Phase 2: Extract Testable Helpers

**Goal:** Make Phase 1's logic reachable from Node. This is a prerequisite for Phase 3, not optional cleanup.

`extension/content.js` is a flat script — no `import`/`export`, top-level `var` globals, hard dependencies on `$` (jQuery) and `renderLanguageColor` (from `colors.js`). A test file cannot `require` it as-is.

- [ ] **2.1 Create `extension/selectors.js`** holding the pure helpers: `extractRepoInfo`, `getSidebarElement`, and (if 1.5 applies) `getExploreContainer`. No jQuery, no globals, DOM access only through a `root` parameter defaulting to `document`.
- [ ] **2.2 Add a dual-context export tail:**

  ```js
  if (typeof module !== 'undefined' && module.exports) {
      module.exports = { extractRepoInfo, getSidebarElement };
  }
  ```

  In the browser this is a no-op; the functions land in the content script's isolated-world global scope exactly as `colors.js` does today.
- [ ] **2.3 Register it in both manifests** — add `"selectors.js"` to `content_scripts[0].js` **before** `content.js` in `extension/manifest.json` and `extension/manifest-firefox.json`.
- [ ] **2.4 Re-inject it from the background worker.** `background.js:62-66` currently re-injects only `content.js`. Add `selectors.js` to that `files` array, or the helpers go stale relative to a re-executed content script.

---

## Phase 3: Unit Tests

**Goal:** Regression coverage for the selector logic, so the next GitHub redesign produces a failing test rather than a silent break.

**Dependency decision — jsdom is required.** The earlier draft promised a "dependency-free" suite using `node --test` while also asking for "mock DOM structures." Node ships no DOM: no `document`, no `querySelector`, no HTML parser. Hand-rolled fake objects would test the fake's matching logic, not whether the selectors match GitHub's markup — worthless for the one thing worth proving. Accept the dependency.

- [ ] **3.1 Add `extension/package.json`** with `jsdom` as the sole `devDependency` and `"test": "node --test tests/"`.
- [ ] **3.2 Build fixtures in `extension/tests/fixtures/`** from the **Phase 0 captures**, not from invention: `sidebar-react.html` (current Primer React), `sidebar-rails.html` (legacy `.BorderGrid`), `dashboard.html`, and `no-sidebar.html`.
- [ ] **3.3 `tests/route.test.js`** — `extractRepoInfo` over repo roots (`/google/guava`), subpaths (`/owner/repo/tree/main`, `/owner/repo/blob/main/README.md`), the homepage (`/`), and reserved routes (`/explore`, `/settings/profile`, `/orgs/github/teams`). Reserved routes may legitimately return a truthy value here — Phase 1's design says sidebar resolution rejects them, so assert that contract, not a denylist.
- [ ] **3.4 `tests/selectors.test.js`** — load each fixture into jsdom, assert `getSidebarElement` picks the expected node, and assert it returns `null` for `no-sidebar.html` and `dashboard.html`. Include a fixture where both React and legacy markup are present to pin the precedence order.
- [ ] **3.5 Add the `just test` recipe** to `extension/justfile`:

  ```
  test:
      cd {{justfile_directory()}} && node --test tests/
  ```

  Use the directory form. `node --test tests/**/*.test.js` does not work — `just` invokes `sh`, which does not expand `**`.
- [ ] **3.6 Wire tests into CI.** `.github/workflows/build_test.yml` triggers on `master` only and runs a docker-compose health check; it will never execute these tests. Add a workflow that runs `npm --prefix extension ci && npm --prefix extension test` on pull requests touching `extension/**`. Without this the suite runs on one laptop and nowhere else.

---

## Phase 4: Navigation & Injection Lifecycle

**Goal:** Correct re-rendering on soft navigation, without stacking duplicate work.

**Pick one trigger, not two.** The current architecture already re-injects `content.js` on `chrome.webNavigation.onHistoryStateUpdated` (`background.js:60-68`). Adding `turbo:render` / `popstate` listeners inside `content.js` on top of that gives two independent triggers for the same navigation — and because `document` survives soft navigation, every re-injection registers *another* copy of those listeners. After five repository visits, one navigation fires six handlers and six API calls. Recommendation: keep the background worker as the single trigger and skip in-page navigation listeners entirely, unless Phase 0.5 shows `onHistoryStateUpdated` misses cases.

- [ ] **4.1 Fix the cross-tab URL dedupe bug.** `background.js:59` holds a single module-scope `var url` shared across **all** tabs. With two GitHub tabs open, navigating in tab B and then back in tab A suppresses injection entirely. The real failure mode is *missed* renders, not redundant ones (the earlier draft had this backwards). Key by `tabId`:

  ```js
  const lastUrlByTab = new Map();
  chrome.webNavigation.onHistoryStateUpdated.addListener(({tabId, url}) => {
      if (lastUrlByTab.get(tabId) === url) return;
      lastUrlByTab.set(tabId, url);
      chrome.scripting.executeScript({target: {tabId}, files: ['selectors.js', 'content.js']});
  });
  chrome.tabs.onRemoved.addListener(tabId => lastUrlByTab.delete(tabId));
  ```

  `chrome.tabs.onRemoved` requires the `"tabs"` permission, which is absent from both manifests today (they carry only `scripting` and `webNavigation`). Add it, or drop the cleanup listener and accept unbounded Map growth.

- [ ] **4.2 Guard against duplicate cards.** Check for an existing `#similar-repositories` before building, and remove it before re-appending (`content.js:108` already does the removal — preserve it).
- [ ] **4.3 Keep the card pinned to the bottom.** A `MutationObserver` on the resolved sidebar (`{childList: true}`) that re-appends `#similar-repositories` if React mounts Releases/Contributors/Languages after GitRec renders. Disconnect it before re-injection to avoid observer accumulation.
- [ ] **4.4 Reset content-script state in `content.js`, not `background.js`.** `itemId`, `similarOffset`, and `loaded` are content-script globals in the page's isolated world; the service worker runs in a separate context and cannot touch them. Re-executing `content.js` re-runs the top-level `var` initializers, which resets them — verify this actually holds rather than assuming it.

---

## Phase 5: Packaging & Verification

- [ ] **5.1 Version bump** to `0.10` in `extension/manifest.json` and `extension/manifest-firefox.json` (both currently `0.9`). Browsers compare version segments as integers, so `0.10` correctly sorts above `0.9`.
- [ ] **5.2 Confirm both manifests carry the `selectors.js` addition** from 2.3 and any `"tabs"` permission from 4.1.
- [ ] **5.3 Verify packaging** — `just package-chrome` and `just package-firefox` produce clean archives in `extension/dist/`.
- [ ] **5.4 End-to-end matrix:**

  | Scenario | Expected |
  |---|---|
  | Homepage (`github.com/`) | Explore recommendations widget renders |
  | Repo root (`/owner/repo`) | "Related repositories" at bottom of right sidebar, correctly styled |
  | Repo subpath (`/owner/repo/tree/main`) | Renders if sidebar present; silently no-ops if not |
  | Repo with no sidebar (`/owner/repo/issues`) | No injection, no console error |
  | Soft nav Home → Repo | Renders without a full reload |
  | Soft nav Repo A → Repo B | Recommendations update to Repo B; exactly one card |
  | Two tabs, alternating navigation | Both tabs render (regression test for 4.1) |
  | Pagination (Next / Previous) | Fetches and renders next/previous 3 |
  | Empty or 404 repo | No injection, no console error |
  | Logged out / rate limited | Friendly error or login link |
  | Firefox build | Matches Chrome behavior |

---

## Out of Scope (tracked separately)

- **`background.js:70-75` throws on every toolbar click.** `creating.then(onCreated, onError)` references two identifiers defined nowhere in the extension — a live `ReferenceError` in the service worker. One-line fix in the same file, but unrelated to this bug; do it in its own commit.
- **`content.js:131` depends on `$('meta[name=user-login]')`.** If that tag is absent the code fetches `api.github.com/users/undefined/starred`. Same generation of markup dependency as the rest; worth a Phase 0 check but not a blocker.
- **Pagination magic numbers.** `background.js` requests `n=6` neighbors while `content.js` steps the offset by 3 (`content.js:70`, `content.js:95`). Coupled constants that no one has documented. Leave alone during this fix.
- **Staged but unrelated:** `.agents/skills/exa-search/SKILL.md` and `skills-lock.json` are currently staged on this branch. Unstage them — they should not ride along in a bugfix commit.

---

## File Changes Summary

| File | Type | Description |
|---|---|---|
| `extension/selectors.js` | **New** | Pure helpers: `extractRepoInfo`, `getSidebarElement`, dual-context export tail. |
| `extension/content.js` | Modify | New activation gate, sidebar waiter, bottom-pinning observer; card classes and homepage selectors if Phase 0 requires. |
| `extension/background.js` | Modify | Per-tab URL dedupe; inject `selectors.js` alongside `content.js`. |
| `extension/manifest.json` | Modify | Add `selectors.js` to `content_scripts`; version `0.10`; `"tabs"` permission if 4.1 keeps cleanup. |
| `extension/manifest-firefox.json` | Modify | Same as above. |
| `extension/package.json` | **New** | `jsdom` devDependency; `test` script. |
| `extension/tests/**` | **New** | Fixtures captured in Phase 0 plus route and selector suites. |
| `extension/justfile` | Modify | `test` recipe. |
| `.github/workflows/*` | **New/Modify** | Run extension tests on PRs touching `extension/**`. |

---

## Changes From the Previous Draft

- **Added Phase 0.** Every selector was inherited from SimRepo's PRs and unverified against live GitHub. Building five phases on an unchecked guess is the largest risk in the project.
- **Resequenced.** The minimal fix now lands first (Phase 1) instead of arriving mid-refactor.
- **Dropped `parseCount` and `getStarCounterElement`.** Ported from SimRepo, where the star *value* gates a <100-star cutoff. GitRec only checks that the element exists and never reads the number. Both the helper and its test suite were dead weight.
- **Resolved the test-harness contradiction.** "Dependency-free" and "mock DOM structures" cannot both hold in Node. jsdom is now an explicit dependency, and Phase 2 adds the export mechanism the earlier draft assumed already existed.
- **Moved state reset out of `background.js`.** The service worker cannot reach content-script globals.
- **Corrected the multi-tab diagnosis.** The bug is missed injections from a globally-shared `url` variable, not redundant evaluations.
- **Cut in-page Turbo listeners by default.** Combined with existing background re-injection they double-fire and accumulate listeners on a surviving `document`.
- **Added tasks for the injected card's CSS classes and the homepage selectors**, both conditional on Phase 0 findings.
- **Added CI wiring, `"tabs"` permission, and the `sh`-can't-expand-`**` fix.**
