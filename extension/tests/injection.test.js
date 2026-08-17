const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// background.js re-injects these files with chrome.scripting.executeScript on
// every GitHub SPA navigation, into the same isolated world the manifest
// content scripts already ran in. A classic script evaluated twice in one
// global throws "Identifier X has already been declared" if it declares
// anything with top-level const/let/class, so every re-injected file must
// tolerate repeated evaluation in a shared context.
const REINJECTED_FILES = ['selectors.js', 'content.js'];

function evaluateTwice(file) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const context = vm.createContext({
    // content.js touches these at evaluation time.
    $: Object.assign(
      function () {
        return { ready: () => {}, remove: () => {}, click: () => {}, append: () => {}, children: () => ({ remove: () => {} }) };
      },
      { parseHTML: () => [] }
    ),
    chrome: { runtime: { sendMessage: () => {} } },
    document: { getElementById: () => null },
    location: { pathname: '/explore' },
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context, { filename: file });
  vm.runInContext(source, context, { filename: file });
  return context;
}

describe('re-injection safety', () => {
  for (const file of REINJECTED_FILES) {
    it(`${file} can be evaluated twice in the same global`, () => {
      assert.doesNotThrow(() => evaluateTwice(file));
    });
  }

  it('selectors.js still exposes its helpers as globals after re-injection', () => {
    const context = evaluateTwice('selectors.js');
    assert.equal(typeof context.extractRepoInfo, 'function');
    assert.equal(typeof context.getSidebarElement, 'function');
    assert.equal(typeof context.waitForSidebar, 'function');
    assert.ok(Array.isArray(context.SIDEBAR_SELECTORS));
    // Compared field by field: the value is created inside the vm realm, so it
    // does not share Object.prototype with this one.
    const info = context.extractRepoInfo('/google/guava');
    assert.equal(info.owner, 'google');
    assert.equal(info.repo, 'guava');
    assert.equal(info.itemId, 'google:guava');
  });
});
