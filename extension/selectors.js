// This file is loaded twice in the same isolated world: once as a manifest
// content script on page load, and again via chrome.scripting.executeScript on
// every GitHub SPA navigation. Top-level `const`/`let`/`class` bindings survive
// between injections and make the second injection fail to parse with
// "Identifier ... has already been declared", so everything lives inside an IIFE
// and is exported by property assignment, which is safely repeatable.
(function () {
  const SIDEBAR_SELECTORS = [
    '[data-component="SplitPageLayout.Pane"] [class*="CodeViewSidebar-module__borderGrid__"]',
    'rails-partial[data-partial-name="codeViewRepoRoute.Sidebar"] .BorderGrid',
    '.Layout-sidebar .BorderGrid',
    '[data-testid="repository-sidebar"]',
    '.BorderGrid',
  ];

  function extractRepoInfo(pathname) {
    if (pathname == null && typeof location !== 'undefined') {
      pathname = location.pathname;
    }
    const splits = String(pathname || '').split('/').filter((s) => s);
    if (splits.length < 2) {
      return null;
    }
    const owner = splits[0];
    const repo = splits[1];
    return { owner, repo, itemId: `${owner}:${repo}` };
  }

  function getSidebarElement(root) {
    if (root === undefined) {
      root = typeof document !== 'undefined' ? document : null;
    }
    if (!root || typeof root.querySelector !== 'function') {
      return null;
    }
    for (const selector of SIDEBAR_SELECTORS) {
      const el = root.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function waitForSidebar(root, timeoutMs) {
    if (root === undefined) {
      root = typeof document !== 'undefined' ? document : null;
    }
    if (timeoutMs === undefined) {
      timeoutMs = 5000;
    }

    const existing = getSidebarElement(root);
    if (existing) {
      return Promise.resolve(existing);
    }

    const view =
      (root && root.defaultView) ||
      (root && root.ownerDocument && root.ownerDocument.defaultView);
    const Observer =
      (view && view.MutationObserver) ||
      (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    const target =
      root && root.nodeType === 9 ? root.documentElement || root : root;

    if (!Observer || !target || typeof target.nodeType !== 'number') {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      let observer;
      const timeoutId = setTimeout(() => {
        if (observer) observer.disconnect();
        resolve(null);
      }, timeoutMs);

      observer = new Observer(() => {
        const el = getSidebarElement(root);
        if (el) {
          clearTimeout(timeoutId);
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(target, { childList: true, subtree: true });
    });
  }

  const api = {
    extractRepoInfo,
    getSidebarElement,
    waitForSidebar,
    SIDEBAR_SELECTORS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof globalThis !== 'undefined') {
    // Property assignment, not declaration: re-injection overwrites instead of
    // throwing a redeclaration SyntaxError.
    Object.assign(globalThis, api);
  }
})();
