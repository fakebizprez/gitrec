const API_BASE = 'https://gitrec.gorse.io';

// The API answers errors with a plain-text body and a non-2xx status (see the
// `Response(e.message, status=...)` handlers in app.py), and @login_required
// endpoints answer anonymous callers with an HTML redirect. Calling
// response.json() on either of those throws, which used to leave the message
// listener without a response and hang the content script forever, so every
// request funnels through here and always resolves to an object.
async function requestJson(path, options) {
    const response = await fetch(`${API_BASE}${path}`, options);
    const body = await response.text();
    if (!response.ok) {
        const message = body.trim();
        return { error: message || `GitRec request failed with status ${response.status}` };
    }
    try {
        return JSON.parse(body);
    } catch (_e) {
        return { error: 'GitRec returned a malformed response.' };
    }
}

// Returns a promise for the response to send back, or null when the message is
// not one this worker knows how to answer.
function handleRequest(request) {
    if (request.read) {
        const itemIds = Array.isArray(request.read) ? request.read : [request.read];
        const responses = itemIds.map((itemId) =>
            requestJson(`/api/read/${itemId}`, { method: 'POST', credentials: 'include' }));
        // An array request keeps its array response; a single id keeps its
        // single response, as the callers in content.js expect.
        return Array.isArray(request.read) ? Promise.all(responses) : responses[0];
    }
    if (request.delete) {
        return requestJson(`/api/delete/${request.delete}`, { method: 'POST', credentials: 'include' });
    }
    if (request.neighbors) {
        // offset defaults to 0: the server parses it with int(), so sending
        // "undefined" would fail the whole request with a 500.
        const offset = request.offset || 0;
        return requestJson(
            `/api/v2/neighbors/${request.neighbors}?offset=${offset}&n=3`,
            { credentials: 'include' });
    }
    if (request.recommend) {
        if (Array.isArray(request.recommend) && request.recommend.length > 0) {
            return requestJson('/api/session/recommend?n=6', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request.recommend),
            });
        }
        return requestJson('/api/v2/extension/recommend', { credentials: 'include' });
    }
    return null;
}

chrome.runtime.onMessage.addListener(
    function (request, _sender, sendResponse) {
        const pending = handleRequest(request);
        if (!pending) {
            // Answer even an unrecognised message: returning true without ever
            // calling sendResponse is what produces "The message port closed
            // before a response was received".
            sendResponse({ error: 'Unsupported GitRec request.' });
            return false;
        }
        pending.then(sendResponse, (error) => {
            sendResponse({ error: (error && error.message) || String(error) });
        });
        return true;
    }
);

const lastUrlByTab = new Map();
chrome.webNavigation.onHistoryStateUpdated.addListener(function (details) {
    if (lastUrlByTab.get(details.tabId) === details.url) {
        return;
    }
    lastUrlByTab.set(details.tabId, details.url);
    try {
        if (new URL(details.url).hostname !== 'github.com') {
            return;
        }
    } catch (_e) {
        return;
    }
    chrome.scripting.executeScript({
        target: { tabId: details.tabId },
        files: ['selectors.js', 'content.js'],
    }).catch(() => {
        // The tab can be gone, or navigated somewhere the extension cannot
        // touch, by the time this runs. Nothing to recover, but an unhandled
        // rejection would be logged as an extension error.
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
    lastUrlByTab.delete(tabId);
});

chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({
        url: `${API_BASE}/`
    });
});
