const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { getSidebarElement, waitForSidebar } = require('../selectors.js');

const fixturesDir = path.join(__dirname, 'fixtures');

function loadDocument(name) {
  const html = fs.readFileSync(path.join(fixturesDir, name), 'utf8');
  return new JSDOM(html).window.document;
}

describe('getSidebarElement', () => {
  it('returns the React borderGrid node for sidebar-react', () => {
    const document = loadDocument('sidebar-react.html');
    const el = getSidebarElement(document);
    assert.ok(el);
    assert.ok(String(el.className).includes('CodeViewSidebar-module__borderGrid__'));
  });

  it('returns the rails-partial .BorderGrid for sidebar-rails', () => {
    const document = loadDocument('sidebar-rails.html');
    const el = getSidebarElement(document);
    assert.ok(el);
    assert.ok(el.classList.contains('BorderGrid'));
    assert.ok(el.closest('rails-partial[data-partial-name="codeViewRepoRoute.Sidebar"]'));
  });

  it('prefers the React borderGrid node when both sidebars exist', () => {
    const document = loadDocument('sidebar-both.html');
    const el = getSidebarElement(document);
    assert.ok(el);
    assert.ok(String(el.className).includes('CodeViewSidebar-module__borderGrid__'));
  });

  it('returns null when there is no sidebar', () => {
    const document = loadDocument('no-sidebar.html');
    assert.equal(getSidebarElement(document), null);
  });

  it('returns null on the dashboard fixture', () => {
    const document = loadDocument('dashboard.html');
    assert.equal(getSidebarElement(document), null);
  });
});

describe('waitForSidebar', () => {
  it('resolves immediately when the sidebar is already present', async () => {
    const document = loadDocument('sidebar-react.html');
    const el = await waitForSidebar(document, 100);
    assert.ok(el);
    assert.ok(String(el.className).includes('CodeViewSidebar-module__borderGrid__'));
  });

  it('resolves when the React pane is appended later', async () => {
    const { window } = new JSDOM('<!doctype html><html><body></body></html>');
    const document = window.document;
    const pending = waitForSidebar(document, 500);
    setTimeout(() => {
      const pane = document.createElement('div');
      pane.setAttribute('data-component', 'SplitPageLayout.Pane');
      const grid = document.createElement('div');
      grid.className = 'CodeViewSidebar-module__borderGrid__Lpx5q';
      pane.appendChild(grid);
      document.body.appendChild(pane);
    }, 20);
    const el = await pending;
    assert.ok(el);
    assert.ok(String(el.className).includes('CodeViewSidebar-module__borderGrid__'));
  });

  it('resolves null after timeout when no sidebar appears', async () => {
    const { window } = new JSDOM('<!doctype html><html><body></body></html>');
    const el = await waitForSidebar(window.document, 50);
    assert.equal(el, null);
  });
});
