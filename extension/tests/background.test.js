const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// background.js runs as the MV3 service worker: Chrome evaluates it top to
// bottom on registration, then invokes the listeners it registered. Anything
// that throws in either step shows up as an error entry on chrome://extensions,
// so both are exercised here against a stubbed chrome API.
function loadServiceWorker() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const listeners = {};
  const calls = [];
  const event = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const context = vm.createContext({
    chrome: {
      runtime: { onMessage: event('onMessage') },
      webNavigation: { onHistoryStateUpdated: event('onHistoryStateUpdated') },
      tabs: {
        onRemoved: event('onRemoved'),
        create: (options) => {
          calls.push(['tabs.create', options]);
          return Promise.resolve({ id: 1 });
        },
      },
      action: { onClicked: event('onClicked') },
      scripting: {
        executeScript: (options) => {
          calls.push(['scripting.executeScript', options]);
          return Promise.resolve([]);
        },
      },
    },
    fetch: async () => ({ json: async () => ({}) }),
    URL,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context, { filename: 'background.js' });
  return { listeners, calls };
}

describe('background service worker', () => {
  it('evaluates and registers every listener it needs', () => {
    const { listeners } = loadServiceWorker();
    assert.equal(typeof listeners.onMessage, 'function');
    assert.equal(typeof listeners.onHistoryStateUpdated, 'function');
    assert.equal(typeof listeners.onRemoved, 'function');
    assert.equal(typeof listeners.onClicked, 'function');
  });

  // Regression: the click handler used to pass two callbacks that were never
  // defined anywhere -- `creating.then(onCreated, onError)` -- so clicking the
  // toolbar icon opened the tab and then threw
  // "ReferenceError: onCreated is not defined" in the service worker.
  it('opens the GitRec site when the toolbar icon is clicked, without throwing', () => {
    const { listeners, calls } = loadServiceWorker();
    assert.doesNotThrow(() => listeners.onClicked());
    // Checked field by field: the options object is created inside the vm
    // realm, so it does not share Object.prototype with this one.
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'tabs.create');
    assert.equal(calls[0][1].url, 'https://gitrec.gorse.io/');
  });

  it('re-injects the content scripts on a github.com SPA navigation', () => {
    const { listeners, calls } = loadServiceWorker();
    listeners.onHistoryStateUpdated({ tabId: 7, url: 'https://github.com/gorse-io/gorse/issues' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'scripting.executeScript');
    assert.equal(calls[0][1].target.tabId, 7);
    assert.deepEqual([...calls[0][1].files], ['selectors.js', 'content.js']);
  });

  it('ignores navigations outside github.com', () => {
    const { listeners, calls } = loadServiceWorker();
    listeners.onHistoryStateUpdated({ tabId: 7, url: 'https://example.com/gorse-io/gorse' });
    assert.equal(calls.length, 0);
  });
});
