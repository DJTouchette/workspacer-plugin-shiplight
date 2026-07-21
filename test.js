#!/usr/bin/env node
// Static tests for Shiplight's pure helpers (run: node test.js).
// server.js exports these and only starts the sidecar when run directly.
const assert = require('assert');
const {
  parseWatchEntry, parseRemote, stripRef, entrySlug, entryUrl,
  rollupFromState, adoVotesToReview, adoBuildConclusion, adoChecksFromRuns,
} = require('./server.js');

// parseWatchEntry: 2 segments GitHub, 3 segments Azure DevOps.
assert.deepStrictEqual(parseWatchEntry('owner/name'), { kind: 'github', slug: 'owner/name' });
assert.deepStrictEqual(parseWatchEntry('org/proj/repo'), { kind: 'ado', org: 'org', project: 'proj', repo: 'repo' });
assert.strictEqual(parseWatchEntry('single'), null);
assert.strictEqual(parseWatchEntry(''), null);

// parseRemote: every remote shape each platform emits.
assert.deepStrictEqual(parseRemote('git@github.com:DJTouchette/workspacer.git'),
  { kind: 'github', slug: 'DJTouchette/workspacer' });
assert.deepStrictEqual(parseRemote('https://github.com/DJTouchette/workspacer'),
  { kind: 'github', slug: 'DJTouchette/workspacer' });
assert.deepStrictEqual(parseRemote('git@ssh.dev.azure.com:v3/myorg/My%20Project/my-repo'),
  { kind: 'ado', org: 'myorg', project: 'My Project', repo: 'my-repo' });
assert.deepStrictEqual(parseRemote('https://myorg@dev.azure.com/myorg/proj/_git/repo'),
  { kind: 'ado', org: 'myorg', project: 'proj', repo: 'repo' });
assert.deepStrictEqual(parseRemote('https://dev.azure.com/myorg/proj/_git/repo.git'),
  { kind: 'ado', org: 'myorg', project: 'proj', repo: 'repo' });
assert.deepStrictEqual(parseRemote('https://myorg.visualstudio.com/DefaultCollection/proj/_git/repo'),
  { kind: 'ado', org: 'myorg', project: 'proj', repo: 'repo' });
assert.deepStrictEqual(parseRemote('https://myorg.visualstudio.com/proj/_git/repo'),
  { kind: 'ado', org: 'myorg', project: 'proj', repo: 'repo' });
assert.strictEqual(parseRemote(''), null);

// slug/url round-trips.
const ado = { kind: 'ado', org: 'o', project: 'p x', repo: 'r' };
assert.strictEqual(entrySlug(ado), 'o/p x/r');
assert.strictEqual(entryUrl(ado), 'https://dev.azure.com/o/p%20x/_git/r');
assert.strictEqual(entryUrl({ kind: 'github', slug: 'a/b' }), 'https://github.com/a/b');

// Ref cleanup, including PR merge refs.
assert.strictEqual(stripRef('refs/heads/main'), 'main');
assert.strictEqual(stripRef('refs/pull/42/merge'), 'PR #42');
assert.strictEqual(stripRef('main'), 'main');

// GitHub rollup state mapping.
assert.strictEqual(rollupFromState('SUCCESS'), 'passing');
assert.strictEqual(rollupFromState('PENDING'), 'pending');
assert.strictEqual(rollupFromState('FAILURE'), 'failing');
assert.strictEqual(rollupFromState(null), null);

// ADO vote → review mapping. Rejection outranks approval.
assert.strictEqual(adoVotesToReview([{ vote: 10 }]), 'APPROVED');
assert.strictEqual(adoVotesToReview([{ vote: 5 }, { vote: 0 }]), 'APPROVED');
assert.strictEqual(adoVotesToReview([{ vote: 10 }, { vote: -10 }]), 'CHANGES_REQUESTED');
assert.strictEqual(adoVotesToReview([{ vote: -5 }]), 'CHANGES_REQUESTED');
assert.strictEqual(adoVotesToReview([{ vote: 0, isRequired: true }]), 'REVIEW_REQUIRED');
assert.strictEqual(adoVotesToReview([{ vote: 0 }]), null);
assert.strictEqual(adoVotesToReview([]), null);

// ADO build result mapping — partiallySucceeded needs eyes.
assert.strictEqual(adoBuildConclusion('succeeded'), 'success');
assert.strictEqual(adoBuildConclusion('canceled'), 'cancelled');
assert.strictEqual(adoBuildConclusion('failed'), 'failure');
assert.strictEqual(adoBuildConclusion('partiallySucceeded'), 'failure');
assert.strictEqual(adoBuildConclusion(undefined), null);

// PR checks derived from the branch's latest build.
const runs = [
  { branch: 'feat', status: 'completed', conclusion: 'failure' },
  { branch: 'feat', status: 'completed', conclusion: 'success' }, // older
  { branch: 'main', status: 'in_progress', conclusion: null },
];
assert.strictEqual(adoChecksFromRuns(runs, 'feat'), 'failing'); // newest wins
assert.strictEqual(adoChecksFromRuns(runs, 'main'), 'pending');
assert.strictEqual(adoChecksFromRuns(runs, 'nope'), null);

console.log('shiplight: all tests passed');
