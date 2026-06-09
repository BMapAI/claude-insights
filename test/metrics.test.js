'use strict';

// Tests for the Prometheus exposition. Checks the gauge HELP/TYPE lines, a few
// values (incl. derived tokens), label escaping for project names, and the
// empty-input guard.

const { test } = require('node:test');
const assert = require('node:assert');
const L = require('../server.js');

const OV = {
  totals: { cost: 1234.5, tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, sessions: 5, userPrompts: 7, toolUses: 9 },
  cacheSavings: 50,
  reliability: { errorRate: 0.1, wastedCost: 2.5 },
  output: { commits: 3, filesEdited: 8 },
  projects: [{ name: 'acme-api', cost: 1000 }, { name: 'weird "quoted"', cost: 234.5 }],
};

test('promMetrics emits gauge HELP/TYPE and values', () => {
  const out = L.promMetrics(OV);
  assert.match(out, /# HELP claude_ledger_spend_usd /);
  assert.match(out, /# TYPE claude_ledger_spend_usd gauge/);
  assert.match(out, /\nclaude_ledger_spend_usd 1234\.5000\n/);
  assert.match(out, /\nclaude_ledger_tokens 100\n/);            // 10+20+30+40
  assert.match(out, /\nclaude_ledger_tool_error_rate 0\.100000\n/);
  assert.match(out, /\nclaude_ledger_commits 3\n/);
});

test('promMetrics labels per-project spend and escapes quotes', () => {
  const out = L.promMetrics(OV);
  assert.match(out, /claude_ledger_project_spend_usd\{project="acme-api"\} 1000\.0000/);
  assert.match(out, /claude_ledger_project_spend_usd\{project="weird \\"quoted\\""\} 234\.5000/);
});

test('promMetrics is empty for no data', () => {
  assert.equal(L.promMetrics(null), '');
});
