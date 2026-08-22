const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// background.js runs as the MV3 service worker: Chrome evaluates it top to
// bottom on registration, then invokes the listeners it registered. Anything
// that throws in either step shows up as an error entry on chrome://extensions,
// so both are exercised here against a stubbed chrome API.
function loadServiceWorker(options = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const listeners = {};
  const calls = [];
  const fetches = [];
  const rejections = [];
  const event = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const respond = options.respond || (() => ({ status: 200, body: '{"ok":true}' }));
  const context = vm.createContext({
    chrome: {
      runtime: { onMessage: event('onMessage') },
      webNavigation: { onHistoryStateUpdated: event('onHistoryStateUpdated') },
      tabs: {
        onRemoved: event('onRemoved'),
        create: (createOptions) => {
          calls.push(['tabs.create', createOptions]);
          return Promise.resolve({ id: 1 });
        },
      },
      action: { onClicked: event('onClicked') },
      scripting: {
        executeScript: (scriptOptions) => {
          calls.push(['scripting.executeScript', scriptOptions]);
          return options.executeScriptFails
            ? Promise.reject(new Error('No tab with id: 7.'))
            : Promise.resolve([]);
        },
      },
    },
    fetch: async (url, init) => {
      fetches.push({ url, init });
      const { status, body } = respond(url, init);
      return { ok: status >= 200 && status < 300, status, text: async () => body };
    },
    URL,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context, { filename: 'background.js' });
  return { listeners, calls, fetches, rejections };
}

// Delivers a message the way chrome does and resolves with the response the
// listener sends back, or with a marker when it never sends one -- that silence
// is what surfaces to the sender as "The message port closed before a response
// was received".
function sendMessage(listeners, request) {
  return new Promise((resolve, reject) => {
    let returned;
    let response;
    let responded = false;
    const finish = () => resolve({ response, returned, noResponse: !responded });
    const timer = setTimeout(finish, 100);
    try {
      returned = listeners.onMessage(request, {}, (value) => {
        response = value;
        responded = true;
        clearTimeout(timer);
        // Deferred by a tick: an unrecognised message is answered before the
        // listener has returned, and its return value is part of the contract.
        setTimeout(finish, 0);
      });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
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

  // Regression: an injection into a tab that has already closed rejects, and an
  // unhandled rejection is logged as an extension error.
  it('swallows an injection that fails because the tab is gone', async () => {
    const { listeners } = loadServiceWorker({ executeScriptFails: true });
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    listeners.onHistoryStateUpdated({ tabId: 7, url: 'https://github.com/gorse-io/gorse' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off('unhandledRejection', onRejection);
    assert.deepEqual(rejections, []);
  });

  describe('message handling', () => {
    it('answers a neighbors request with the parsed body', async () => {
      const { listeners, fetches } = loadServiceWorker({
        respond: () => ({ status: 200, body: '{"is_authenticated":false,"scores":[]}' }),
      });
      const { response, returned } = await sendMessage(listeners, { neighbors: 'a:b', offset: 3 });
      assert.equal(returned, true);
      assert.equal(response.is_authenticated, false);
      assert.equal(fetches[0].url, 'https://gitrec.gorse.io/api/v2/neighbors/a:b?offset=3&n=3');
    });

    // Regression: an absent offset was interpolated as the string "undefined",
    // which the server hands to int() and fails the whole request on.
    it('defaults a missing neighbors offset to 0', async () => {
      const { listeners, fetches } = loadServiceWorker();
      await sendMessage(listeners, { neighbors: 'a:b' });
      assert.equal(fetches[0].url, 'https://gitrec.gorse.io/api/v2/neighbors/a:b?offset=0&n=3');
    });

    // Regression: the API reports failures as a plain-text body (see the
    // Response(e.message, status=...) handlers in app.py) and @login_required
    // endpoints answer anonymous callers with HTML. response.json() threw on
    // both, and the listener then never called sendResponse at all, so the
    // content script's callback never ran and the card never rendered.
    it('reports a plain-text error body instead of never responding', async () => {
      const { listeners } = loadServiceWorker({
        respond: () => ({ status: 404, body: 'item a:b does not exist' }),
      });
      const { response, noResponse } = await sendMessage(listeners, { neighbors: 'a:b' });
      assert.ok(!noResponse, 'the listener must always send a response');
      assert.equal(response.error, 'item a:b does not exist');
    });

    it('reports a non-JSON success body instead of never responding', async () => {
      const { listeners } = loadServiceWorker({
        respond: () => ({ status: 200, body: '<!doctype html><title>Sign in</title>' }),
      });
      const { response, noResponse } = await sendMessage(listeners, { delete: 'a:b' });
      assert.ok(!noResponse, 'the listener must always send a response');
      assert.match(response.error, /malformed/);
    });

    it('reports a network failure instead of never responding', async () => {
      const { listeners } = loadServiceWorker({
        respond: () => { throw new Error('Failed to fetch'); },
      });
      const { response, noResponse } = await sendMessage(listeners, { read: 'a:b' });
      assert.ok(!noResponse, 'the listener must always send a response');
      assert.equal(response.error, 'Failed to fetch');
    });

    // Regression: content.js sends { read: result.items }, and an undefined
    // items list matched no branch. The listener still returned true, leaving
    // the port open until it closed unanswered.
    it('answers a request it does not recognise', async () => {
      const { listeners } = loadServiceWorker();
      const { response, noResponse, returned } = await sendMessage(listeners, { read: undefined });
      assert.ok(!noResponse, 'the listener must always send a response');
      assert.match(response.error, /Unsupported/);
      assert.equal(returned, false);
    });

    it('keeps a single read id and a list of read ids in their own response shapes', async () => {
      const single = loadServiceWorker({ respond: () => ({ status: 200, body: '{"RowAffected":1}' }) });
      const one = await sendMessage(single.listeners, { read: 'a:b' });
      assert.equal(one.response.RowAffected, 1);
      assert.equal(single.fetches.length, 1);

      const many = loadServiceWorker({ respond: () => ({ status: 200, body: '{"RowAffected":1}' }) });
      const list = await sendMessage(many.listeners, { read: ['a:b', 'c:d'] });
      assert.ok(Array.isArray(list.response));
      assert.equal(list.response.length, 2);
      assert.equal(many.fetches.length, 2);
    });

    it('sends the session recommend body as JSON', async () => {
      const { listeners, fetches } = loadServiceWorker({ respond: () => ({ status: 200, body: '[]' }) });
      await sendMessage(listeners, { recommend: ['a:b'] });
      assert.equal(fetches[0].url, 'https://gitrec.gorse.io/api/session/recommend?n=6');
      assert.equal(fetches[0].init.method, 'POST');
      assert.equal(fetches[0].init.headers['Content-Type'], 'application/json');
      assert.equal(fetches[0].init.body, '["a:b"]');
    });

    it('treats an empty recommend list as a request for the signed-in feed', async () => {
      const { listeners, fetches } = loadServiceWorker();
      await sendMessage(listeners, { recommend: [] });
      assert.equal(fetches[0].url, 'https://gitrec.gorse.io/api/v2/extension/recommend');
      assert.equal(fetches[0].init.credentials, 'include');
    });
  });
});
