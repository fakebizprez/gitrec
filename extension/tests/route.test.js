const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractRepoInfo } = require('../selectors.js');

describe('extractRepoInfo', () => {
  it('parses /google/guava', () => {
    assert.deepEqual(extractRepoInfo('/google/guava'), {
      owner: 'google',
      repo: 'guava',
      itemId: 'google:guava',
    });
  });

  it('keeps owner/repo from /owner/repo/tree/main', () => {
    assert.deepEqual(extractRepoInfo('/owner/repo/tree/main'), {
      owner: 'owner',
      repo: 'repo',
      itemId: 'owner:repo',
    });
  });

  it('keeps owner/repo from /owner/repo/blob/main/README.md', () => {
    assert.deepEqual(extractRepoInfo('/owner/repo/blob/main/README.md'), {
      owner: 'owner',
      repo: 'repo',
      itemId: 'owner:repo',
    });
  });

  it('accepts dotted repo names such as /vercel/next.js', () => {
    const info = extractRepoInfo('/vercel/next.js');
    assert.ok(info);
    assert.deepEqual(info, {
      owner: 'vercel',
      repo: 'next.js',
      itemId: 'vercel:next.js',
    });
  });

  it('returns null for /', () => {
    assert.equal(extractRepoInfo('/'), null);
  });

  it('returns null for /explore', () => {
    assert.equal(extractRepoInfo('/explore'), null);
  });

  it('returns a truthy value for /settings/profile', () => {
    const info = extractRepoInfo('/settings/profile');
    assert.ok(info);
    assert.equal(info.owner, 'settings');
    assert.equal(info.repo, 'profile');
    assert.equal(info.itemId, 'settings:profile');
  });

  it('returns a truthy value for /orgs/github/teams', () => {
    const info = extractRepoInfo('/orgs/github/teams');
    assert.ok(info);
    assert.equal(info.owner, 'orgs');
    assert.equal(info.repo, 'github');
    assert.equal(info.itemId, 'orgs:github');
  });
});
