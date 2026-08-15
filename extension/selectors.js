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

function getSidebarElement(root = document) {
  if (!root || typeof root.querySelector !== 'function') {
    return null;
  }
  for (const selector of SIDEBAR_SELECTORS) {
    const el = root.querySelector(selector);
    if (el) return el;
  }
  return null;
}

function waitForSidebar(root = document, timeoutMs = 5000) {
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractRepoInfo, getSidebarElement, waitForSidebar, SIDEBAR_SELECTORS };
}
