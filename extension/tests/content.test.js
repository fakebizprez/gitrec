const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SIDEBAR_HTML = `<!doctype html><html><body>
  <div class="Layout-sidebar"><div class="BorderGrid"></div></div>
  <div aria-label="Explore"></div>
</body></html>`;

// Loads the real content-script bundle into a jsdom page, the way the manifest
// loads it into a GitHub tab. The default URL is a path the ready handler does
// nothing with, so each test drives the function it cares about directly.
function loadPage(options = {}) {
  const messages = [];
  const dom = new JSDOM(options.html || SIDEBAR_HTML, {
    runScripts: 'dangerously',
    url: options.url || 'https://github.com/explore',
  });
  dom.window.chrome = {
    runtime: {
      lastError: options.lastError,
      sendMessage: (request, callback) => {
        messages.push(request);
        const reply = options.reply ? options.reply(request) : {};
        if (callback) setTimeout(() => callback(reply), 0);
      },
    },
  };
  if (options.fetchResponse) {
    dom.window.fetch = async () => ({ json: async () => options.fetchResponse() });
  }
  for (const file of ['jquery-3.6.1.min.js', 'colors.js', 'selectors.js', 'content.js']) {
    const script = dom.window.document.createElement('script');
    script.textContent = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    dom.window.document.head.appendChild(script);
  }
  return { window: dom.window, document: dom.window.document, messages };
}

function waitFor(predicate, description) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1000;
    const poll = () => {
      let value;
      try {
        value = predicate();
      } catch (e) {
        return reject(e);
      }
      if (value) return resolve(value);
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${description}`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

const REPO = {
  full_name: 'gorse-io/gorse',
  item_id: 'gorse-io:gorse',
  description: 'A recommender system',
  language: 'Go',
  stargazers_count: 8000,
};

describe('escapeHtml', () => {
  it('neutralises the characters that start markup', () => {
    const { window } = loadPage();
    assert.equal(window.escapeHtml('<img src=x onerror="boom">'),
      '&lt;img src=x onerror=&quot;boom&quot;&gt;');
    assert.equal(window.escapeHtml("it's & fine"), 'it&#39;s &amp; fine');
  });

  it('renders an absent value as the empty string', () => {
    const { window } = loadPage();
    assert.equal(window.escapeHtml(undefined), '');
    assert.equal(window.escapeHtml(null), '');
    assert.equal(window.escapeHtml(0), '0');
  });
});

describe('renderSimilarDiv', () => {
  // Regression: repository descriptions are attacker-controlled and were
  // interpolated straight into the card template. $.parseHTML drops <script>
  // but keeps every other element, so markup in a description became live DOM
  // -- an <img onerror> in the page GitHub served.
  it('renders a description containing markup as text', async () => {
    const { window, document } = loadPage();
    const description = '<img src=x onerror="globalThis.pwned = true">';
    await window.renderSimilarDiv({ repos: [{ ...REPO, description }] });

    const card = document.getElementById('similar-repositories');
    assert.ok(card, 'the card should have rendered');
    assert.equal(card.querySelectorAll('img').length, 0);
    assert.equal(card.querySelector('[itemprop="description"]').textContent, description);
    assert.equal(window.pwned, undefined);
  });

  it('renders a repository name containing markup as text', async () => {
    const { window, document } = loadPage();
    await window.renderSimilarDiv({
      repos: [{ ...REPO, full_name: 'owner/re<b>po</b>', item_id: 'owner:re<b>po</b>' }],
    });

    const link = document.querySelector('#similar-repositories a.Link--primary');
    assert.equal(link.querySelectorAll('b').length, 0);
    assert.equal(link.textContent, 'owner/re<b>po</b>');
  });

  it('renders a language name containing markup as text', async () => {
    const { window, document } = loadPage();
    await window.renderSimilarDiv({ repos: [{ ...REPO, language: '<b>Go</b>' }] });

    const language = document.querySelector('#similar-repositories [itemprop="programmingLanguage"]');
    assert.equal(language.querySelectorAll('b').length, 0);
    assert.equal(language.textContent, '<b>Go</b>');
  });

  it('renders a server error message as text', async () => {
    const { window, document } = loadPage();
    await window.renderSimilarDiv({ message: '<b>item does not exist</b>' });

    const card = document.getElementById('similar-repositories');
    assert.equal(card.querySelectorAll('b').length, 0);
    assert.match(card.textContent, /item does not exist/);
  });

  it('keeps the sign-in link in the rate limit notice', async () => {
    const { window, document } = loadPage();
    await window.renderSimilarDiv({ message: 'API rate limit exceeded for 1.2.3.4' });

    const link = document.querySelector('#similar-repositories a[href="https://gitrec.gorse.io"]');
    assert.ok(link, 'the rate limit notice keeps its own markup');
  });

  it('reports no results when the response carries no repositories', async () => {
    const { window, document } = loadPage();
    await window.renderSimilarDiv({ is_authenticated: true });
    assert.match(document.getElementById('similar-repositories').textContent, /No similar repositories/);
  });
});

describe('loadSimilarRepos', () => {
  it('shows the error the worker reported', async () => {
    const { window, document } = loadPage({ reply: () => ({ error: 'item a:b does not exist' }) });
    window.itemId = 'a:b';
    window.loadSimilarRepos();

    const card = await waitFor(() => document.getElementById('similar-repositories'), 'the card');
    assert.match(card.textContent, /item a:b does not exist/);
  });

  it('shows an error when the worker cannot answer at all', async () => {
    const { window, document } = loadPage({ reply: () => undefined });
    window.itemId = 'a:b';
    window.loadSimilarRepos();

    const card = await waitFor(() => document.getElementById('similar-repositories'), 'the card');
    assert.match(card.textContent, /unavailable/i);
  });

  // Regression: a repository that 404s on the GitHub API is reported back so
  // the server can drop it, but the id was only attached to lookups that
  // succeeded, so the cleanup message went out as { delete: undefined }.
  it('reports a removed repository by its item id', async () => {
    const { window, messages } = loadPage({
      reply: (request) => (request.neighbors
        ? { is_authenticated: false, scores: [{ Id: 'gone:repo' }] }
        : {}),
      fetchResponse: () => ({ message: 'Not Found' }),
    });
    window.itemId = 'a:b';
    window.loadSimilarRepos();

    const deletion = await waitFor(
      () => messages.find((message) => 'delete' in message), 'the cleanup message');
    assert.equal(deletion.delete, 'gone:repo');
  });
});

describe('loadRecommendRepos', () => {
  // Regression: signed out of GitHub there is no user-login meta tag, and the
  // extension asked the GitHub API for /users/undefined/starred.
  it('does not call the GitHub API when signed out of GitHub', async () => {
    let fetched = false;
    const page = loadPage({ reply: () => ({ is_authenticated: false }) });
    page.window.fetch = async () => { fetched = true; throw new Error('should not be called'); };
    page.window.loadRecommendRepos();

    const card = await waitFor(
      () => page.document.querySelector('[aria-label="GitRec"]'), 'the explore card');
    assert.match(card.textContent, /Sign in to GitHub/);
    assert.equal(fetched, false);
  });
});
