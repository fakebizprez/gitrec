var itemId = null;
var similarOffset = 0;
var loaded = false;

// Repository descriptions, names and languages come from the GitHub API and
// are written into HTML templates below. They are attacker-controlled -- any
// account can publish a repository whose description contains markup -- and
// jQuery runs event handlers such as <img onerror> on append even though
// $.parseHTML strips <script>. Everything interpolated into a template goes
// through here first.
function escapeHtml(value) {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Returns a human-readable reason the background worker could not answer, or
// null when the response is usable. Reading chrome.runtime.lastError here also
// marks it as handled, which is what keeps "Unchecked runtime.lastError" out of
// the console when the service worker is restarting.
function messageError(result) {
    const failure = chrome.runtime.lastError;
    if (failure) {
        return failure.message || 'GitRec is unavailable.';
    }
    if (!result) {
        return 'GitRec is unavailable.';
    }
    return result.error || null;
}

$(document).ready(function () {
    if (globalThis.__gitrecSidebarObserver) {
        globalThis.__gitrecSidebarObserver.disconnect();
        globalThis.__gitrecSidebarObserver = null;
    }
    if (!loaded) {
        loaded = true;
        const info = extractRepoInfo(location.pathname);
        if (info) {
            itemId = info.itemId;
            const splits = location.pathname.split('/').filter(s => s);
            // mark read
            if (splits.length == 2) {
                chrome.runtime.sendMessage({ read: itemId }, () => { void chrome.runtime.lastError; });
            }
            waitForSidebar().then((sidebar) => {
                if (sidebar) loadSimilarRepos();
            });
        } else if (location.pathname === '/' || location.pathname === '') {
            // get recommend
            loadRecommendRepos();
        }
    }
})

function loadSimilarRepos() {
    chrome.runtime.sendMessage({ neighbors: itemId, offset: similarOffset }, function (result) {
        const error = messageError(result);
        if (error) {
            renderSimilarDiv({ message: error });
        } else if (result.is_authenticated) {
            renderSimilarDiv(result);
        } else {
            // Fetch repos in client-side
            const scores = result.scores || [];
            let responses = [];
            for (const score of scores) {
                const full_name = score.Id.replace(':', '/');
                responses.push(fetchRepo(full_name));
            }
            Promise.all(responses).then((repos) => {
                result.repos = repos;
                for (const [i, score] of scores.entries()) {
                    // Tagged even when the lookup failed: the "repository has
                    // been removed" branch of renderSimilarDiv reports the item
                    // back to the server by id, and used to send an undefined
                    // one because only successful lookups carried it.
                    result.repos[i].item_id = score.Id;
                    if (!repos[i].full_name && repos[i].message !== 'Not Found') {
                        // A missing repository is reported to the server by
                        // renderSimilarDiv and skipped. Promoting its "Not
                        // Found" to the card-level message used to replace the
                        // whole list with that error and skip the cleanup.
                        result.message = repos[i].message;
                    }
                }
                renderSimilarDiv(result);
            })
        }
    });
}

async function renderSimilarDiv(result) {
    let count = 0;
    let rows = "";
    let previous = "";
    let next = "";
    if (result.message) {
        // The rate limit notice is our own markup and keeps its link; every
        // other message is server or GitHub API text, so it is escaped.
        const errorMessage = String(result.message).startsWith('API rate limit exceeded')
            ? `API rate limit exceeded. Login <a href="https://gitrec.gorse.io" target="_blank">GitRec</a> to get a higher rate limit.`
            : escapeHtml(result.message);
        rows = `<div class="text-small color-fg-muted">${errorMessage}</div>`
    } else if ((result.repos || []).length > 0) {
        for (const repo of result.repos) {
            if (repo.full_name) {
                if (repo.item_id != repo.full_name.replace('/', ':').toLowerCase()) {
                    // The repository has been renamed.
                    chrome.runtime.sendMessage({ delete: repo.item_id }, () => { void chrome.runtime.lastError; });
                } else if (count < 3) {
                    count++;
                    rows += `
<div class="py-2 my-2 color-border-muted">
    <a class="f6 text-bold Link--primary d-flex no-underline wb-break-all d-inline-block" href="/${escapeHtml(repo.full_name)}">${escapeHtml(repo.full_name)}</a>
    <p class="f6 color-fg-muted mb-2" itemprop="description">${escapeHtml(repo.description)}</p>
    ${renderLanguageSpan(repo.language)}
    <span class="f6 color-fg-muted text-normal">
        <svg aria-label="star" role="img" height="16" viewBox="0 0 16 16" version="1.1" width="16" data-view-component="true" class="octicon octicon-star">
            <path fill-rule="evenodd" d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25zm0 2.445L6.615 5.5a.75.75 0 01-.564.41l-3.097.45 2.24 2.184a.75.75 0 01.216.664l-.528 3.084 2.769-1.456a.75.75 0 01.698 0l2.77 1.456-.53-3.084a.75.75 0 01.216-.664l2.24-2.183-3.096-.45a.75.75 0 01-.564-.41L8 2.694v.001z"></path>
        </svg>
        ${escapeHtml(repo.stargazers_count)}
    </span>
</div>`
                }
            } else if (repo.message == 'Not Found') {
                // The repository has been removed.
                chrome.runtime.sendMessage({ delete: repo.item_id }, () => { void chrome.runtime.lastError; });
            }
        }
        if (!rows) {
            // Every repository in the batch was renamed or removed.
            rows = '<div class="text-small color-fg-muted">No similar repositories found</div>';
        }
        // Render previous button
        previous = similarOffset > 0 ?
            `<a id="previous-button" class="text-small" href="#">← Previous</a>` :
            '';
        // Render next button
        next = similarOffset < 9 ?
            `<a id="next-button" class="text-small" style="float: right" href="#">Next →</a>` :
            ``;
    } else {
        rows = '<div class="text-small color-fg-muted">No similar repositories found</div>'
    }
    const template = `
<div id="similar-repositories">
    <h2>Related repositories</h2>
    ${rows}${previous}${next}
</div>`;
    const sidebar = getSidebarElement();
    if (!sidebar) {
        return;
    }
    ensureGitrecCardStyles();
    $("#similar-repositories").remove();
    $(sidebar).append($($.parseHTML(template)));
    pinSimilarCard(sidebar);
    $("a#previous-button").click(function () {
        $("#previous-button").remove();
        $("#next-button").remove();
        similarOffset -= 3;
        loadSimilarRepos();
        return false;
    });
    $("a#next-button").click(function () {
        $("#previous-button").remove();
        $("#next-button").remove();
        similarOffset += 3;
        loadSimilarRepos();
        return false;
    });
}

function ensureGitrecCardStyles() {
    if (!document.getElementById('gitrec-card-styles')) {
        const style = document.createElement('style');
        style.id = 'gitrec-card-styles';
        style.textContent = `
    #similar-repositories { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--borderColor-muted, var(--color-border-muted, rgba(128,128,128,.25))); }
    #similar-repositories h2 { font-size: 14px; font-weight: 600; margin: 0 0 12px; }
  `;
        document.documentElement.appendChild(style);
    }
}

// Puts the card back if a GitHub re-render moves it out of the sidebar. This
// only checks that the card is still inside the sidebar, never that it is the
// sidebar's last child: other extensions -- SimRepo, for one -- observe the
// same sidebar and re-append their own card whenever it is not last. Two
// extensions each demanding the last slot move their cards past each other
// forever inside the microtask queue and lock up the tab.
function pinSimilarCard(sidebar) {
    if (globalThis.__gitrecSidebarObserver) {
        globalThis.__gitrecSidebarObserver.disconnect();
        globalThis.__gitrecSidebarObserver = null;
    }
    const observer = new MutationObserver(function () {
        const card = document.getElementById('similar-repositories');
        if (card && !sidebar.contains(card)) {
            sidebar.appendChild(card);
        }
    });
    observer.observe(sidebar, { childList: true });
    globalThis.__gitrecSidebarObserver = observer;
}

function loadRecommendRepos() {
    chrome.runtime.sendMessage({ recommend: [] }, function (result) {
        const error = messageError(result);
        if (error) {
            showRecommend({ message: error });
            return;
        }
        if (result.is_authenticated) {
            showRecommend(result);
            return;
        }
        const login = $('meta[name=user-login]').attr('content');
        if (!login) {
            // Signed out of GitHub: there are no stars to recommend from, and
            // /users/undefined/starred would just come back as "Not Found".
            showRecommend({ message: 'Sign in to GitHub to get recommendations.' });
            return;
        }
        fetch(`https://api.github.com/users/${login}/starred?per_page=100`).then(r => r.json()).then(starred => {
            if (starred.message) {
                showRecommend(starred);
                return;
            }
            const repoNames = starred.map((value) => value.full_name.replace('/', ':'));
            chrome.runtime.sendMessage({ recommend: repoNames }, function (scores) {
                const scoresError = messageError(scores);
                if (scoresError || !Array.isArray(scores)) {
                    showRecommend({ message: scoresError || 'GitRec returned an unexpected response.' });
                    return;
                }
                // Fetch repos in client-side
                const responses = scores.map((score) => fetchRepo(score.Id.replace(':', '/')));
                Promise.all(responses).then((repos) => {
                    for (const [i, score] of scores.entries()) {
                        repos[i].item_id = score.Id;
                    }
                    showRecommend({ is_authenticated: false, repos });
                })
            });
        }).catch((e) => {
            showRecommend({ message: `Could not reach the GitHub API: ${e.message}` });
        });
    });
}

async function showRecommend(result) {
    let exploreDiv = $("[aria-label='Explore']");
    exploreDiv.children("[aria-label='GitRec']").remove();
    let template = `
<div class="mb-3 dashboard-changelog color-bg-default border color-border-muted p-3 rounded-3" aria-label="GitRec">
  <h2 class="f5 text-bold mb-3 width-full dashboard-changelog__title">Explore repositories</h2>`;
    const repos = result.repos || [];
    if (result.message) {
        // As in renderSimilarDiv: only the rate limit notice is our own markup.
        const errorMessage = String(result.message).startsWith('API rate limit exceeded')
            ? `API rate limit exceeded. Login <a href="https://gitrec.gorse.io" target="_blank">GitRec</a> to get a higher rate limit.`
            : escapeHtml(result.message);
        template += `<div class="d-block no-underline f6 mb-3" id="error-message">${errorMessage}</div>`
    } else if (repos.length > 0) {
        for (const [i, repo] of repos.entries()) {
            template += `
<div class="py-2 my-2${i == repos.length - 1 ? '' : ' border-bottom color-border-muted'}">
    <a class="f6 text-bold Link--primary d-flex no-underline wb-break-all d-inline-block" href="/${escapeHtml(repo.full_name)}">${escapeHtml(repo.full_name)}</a>
    <p class="f6 color-fg-muted mb-2" itemprop="description">${escapeHtml(repo.description)}</p>
    ${renderLanguageSpan(repo.language)}
    <span class="f6 color-fg-muted text-normal">
        <svg aria-label="star" role="img" height="16" viewBox="0 0 16 16" version="1.1" width="16" data-view-component="true" class="octicon octicon-star">
            <path fill-rule="evenodd" d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25zm0 2.445L6.615 5.5a.75.75 0 01-.564.41l-3.097.45 2.24 2.184a.75.75 0 01.216.664l-.528 3.084 2.769-1.456a.75.75 0 01.698 0l2.77 1.456-.53-3.084a.75.75 0 01.216-.664l2.24-2.183-3.096-.45a.75.75 0 01-.564-.41L8 2.694v.001z"></path>
        </svg>
    ${escapeHtml(repo.stargazers_count)}
    </span>
</div>`;
        }
        if (result.is_authenticated) {
            template += `
  <div class="ml-1 pt-2 color-border-muted">
    <a class="text-small Link--muted" href="#" id="renew-button">Next batch →</a>
  </div>`;
        } else {
            template += `
  <div class="ml-1 pt-2 color-border-muted">
    <a class="text-small Link--muted" href="https://gitrec.gorse.io">Login GitRec for better experience →</a>
  </div>`;
        }
    }
    template += `</div>`;
    exploreDiv.append($($.parseHTML(template)));
    $("a#renew-button").click(function () {
        $("#renew-button").remove();
        // An undefined items list used to reach the worker as a message it had
        // no branch for, so its callback never ran and the next batch never
        // loaded.
        chrome.runtime.sendMessage({ read: result.items || [] }, () => {
            void chrome.runtime.lastError;
            chrome.runtime.sendMessage({ recommend: [] }, function (next) {
                const error = messageError(next);
                showRecommend(error ? { message: error } : next);
            });
        });
        return false;
    });
}

async function fetchRepo(name) {
    try {
        const response = await fetch(`https://api.github.com/repos/${name}`);
        return await response.json();
    } catch (e) {
        // Resolved rather than rejected: these run inside a Promise.all, and one
        // unreachable lookup used to reject the whole batch and render nothing.
        return { message: e.message };
    }
}

function renderLanguageSpan(language) {
    if (language) {
        // renderLanguageColor only ever returns a hex value from the table in
        // colors.js, so the colour needs no escaping; the name does.
        return `
<span class="mr-2 f6 color-fg-muted text-normal">
    <span class="">
        <span class="repo-language-color" style="background-color: ${renderLanguageColor(language)}"></span>
        <span itemprop="programmingLanguage">${escapeHtml(language)}</span>
    </span>
</span>`;
    } else {
        return '';
    }
}
