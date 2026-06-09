'use strict';

// Tests for the work-log ("what I built") engine: title-word extraction, theme
// ranking, the structured summary (filter empties, rank by commits), and the
// Markdown export.

const { test } = require('node:test');
const assert = require('node:assert');
const L = require('../server.js');

test('titleWords drops stopwords and short tokens', () => {
  assert.deepEqual(L.titleWords('Add OAuth login flow'), ['oauth', 'login', 'flow']); // "add" is a stopword
  assert.deepEqual(L.titleWords('Fix flaky integration tests'), ['fix', 'flaky', 'integration', 'tests']);
  assert.deepEqual(L.titleWords(''), []);
});

test('sessionTitle prefers ai-title and skips local-command / system noise', () => {
  assert.equal(L.sessionTitle({ title: 'Add OAuth', firstPrompt: 'whatever' }), 'Add OAuth');
  assert.equal(L.sessionTitle({ firstPrompt: 'Why is this query slow?' }), 'Why is this query slow?');
  assert.equal(L.sessionTitle({ firstPrompt: '<local-command-caveat>Caveat: ...' }), '(untitled)');
  assert.equal(L.sessionTitle({ firstPrompt: '<command-name>/clear</command-name>' }), '(untitled)');
  assert.equal(L.sessionTitle({}), '(untitled)');
});

test('topThemes keeps terms seen >=2, ranked desc, capped', () => {
  assert.deepEqual(L.topThemes({ tests: 5, auth: 3, once: 1 }, 6), [{ term: 'tests', count: 5 }, { term: 'auth', count: 3 }]);
  assert.equal(L.topThemes({ a: 9, b: 8, c: 7 }, 2).length, 2);
});

test('buildWorkLog summarizes, filters empty projects, ranks by commits', () => {
  const wl = L.buildWorkLog({
    from: '2026-06-01', to: '2026-06-09', cost: 100, sessions: 12,
    output: { commits: 9, prs: 2, filesEdited: 40 },
    time: { totalMs: 7200000 },
    themes: [{ term: 'auth', count: 3 }],
    projects: [
      { name: 'idle', cost: 0, commits: 0, filesEdited: 0, sessions: 0, topTitles: [] },
      { name: 'b', cost: 30, commits: 2, filesEdited: 5, sessions: 3, topTitles: ['t1'] },
      { name: 'a', cost: 70, commits: 7, filesEdited: 20, sessions: 6, topTitles: ['big', 'x'] },
    ],
  });
  assert.equal(wl.commits, 9);
  assert.equal(wl.activeMs, 7200000);
  assert.equal(wl.projectCount, 2);                            // "idle" filtered out
  assert.deepEqual(wl.projects.map((p) => p.name), ['a', 'b']); // sorted by commits desc
  assert.deepEqual(wl.projects[0].titles, ['big', 'x']);
});

test('worklogMarkdown renders a shareable summary', () => {
  const md = L.worklogMarkdown({
    from: '2026-06-01', to: '2026-06-09', cost: 100, activeMs: 7200000, sessions: 12, projectCount: 1,
    commits: 9, prs: 2, filesEdited: 40, themes: [{ term: 'auth', count: 3 }],
    projects: [{ name: 'a', commits: 7, prs: 1, filesEdited: 20, sessions: 6, cost: 70, titles: ['Add OAuth login'] }],
  });
  assert.match(md, /^# Work log — 2026-06-01 → 2026-06-09/);
  assert.match(md, /9 commits · 2 PRs · 40 files · 12 sessions · \$100\.00 · 2\.0h active/);
  assert.match(md, /Recurring themes: auth ×3\./);
  assert.match(md, /## By project/);
  assert.match(md, /- \*\*a\*\* — 7 commits, 1 PR, 20 files, 6 sessions, \$70\.00/);
  assert.match(md, /\n {2}- Add OAuth login/);
  assert.equal(L.worklogMarkdown(null), '');
});
