#!/usr/bin/env node
// Shiplight — running pipelines + open PRs for your project, at a glance.
//
// Sidecar: polls GitHub and/or Azure DevOps for the watched repos (explicit
// setting, or inferred from the projects your agents touch), serves the pane
// UI from ./ui, and posts OS notifications on state *transitions* (a pipeline
// being triggered or concluding, a PR getting approved / changes-requested /
// opened / merged) — never on states that were already true when it started
// watching.
//
// Sources:
//   GitHub       — a PAT (settings.token → REST + GraphQL) or the gh CLI.
//   Azure DevOps — a PAT (settings.adoToken → REST 7.1).
// Both normalize into one {runs, prs} shape; everything downstream (lamp,
// notifications, pane) is source-agnostic. Zero dependencies — Node >= 22.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { connect } = require('./wks.js');

const DIR = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
const PORT = Number(process.env.PORT || (manifest.server && manifest.server.port) || 9211);

// Settings: WKS_SETTINGS (defaults merged by the hub) over the raw overlay
// file; every read below still applies a code default.
let envSettings = {};
try { envSettings = JSON.parse(process.env.WKS_SETTINGS || '{}'); } catch {}

function log(msg) {
  console.log('[' + manifest.id + '] ' + msg);
}

// ── Watch entries ────────────────────────────────────────────────────────────
// entry: { kind:'github', slug:'owner/name' }
//      | { kind:'ado', org, project, repo }   (slug = 'org/project/repo')
function entrySlug(e) {
  return e.kind === 'ado' ? e.org + '/' + e.project + '/' + e.repo : e.slug;
}

function entryUrl(e) {
  if (e.kind === 'ado') {
    return 'https://dev.azure.com/' + encodeURIComponent(e.org) + '/'
      + encodeURIComponent(e.project) + '/_git/' + encodeURIComponent(e.repo);
  }
  return 'https://github.com/' + e.slug;
}

// A settings entry: 'owner/name' (GitHub) or 'org/project/repo' (Azure DevOps).
function parseWatchEntry(s) {
  const parts = String(s || '').trim().split('/').filter(Boolean);
  if (parts.length === 2) return { kind: 'github', slug: parts.join('/') };
  if (parts.length === 3) return { kind: 'ado', org: parts[0], project: parts[1], repo: parts[2] };
  return null;
}

// A git remote URL → watch entry. Azure DevOps forms first — the generic
// last-two-segments GitHub fallback would misread them.
//   git@ssh.dev.azure.com:v3/org/project/repo
//   https://[user@]dev.azure.com/org/project/_git/repo
//   https://org.visualstudio.com/[DefaultCollection/]project/_git/repo
//   git@github.com:owner/name.git | https://github.com/owner/name
function parseRemote(url) {
  if (!url) return null;
  const s = url.trim().replace(/\.git$/i, '');
  const dec = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
  let m = s.match(/ssh\.dev\.azure\.com[:/]v3\/([^/]+)\/([^/]+)\/([^/]+)$/i);
  if (m) return { kind: 'ado', org: dec(m[1]), project: dec(m[2]), repo: dec(m[3]) };
  m = s.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)$/i);
  if (m) return { kind: 'ado', org: dec(m[1]), project: dec(m[2]), repo: dec(m[3]) };
  m = s.match(/\/\/(?:[^/@]+@)?([^/.]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+)$/i);
  if (m) return { kind: 'ado', org: dec(m[1]), project: dec(m[2]), repo: dec(m[3]) };
  m = s.match(/[:/]([^/:]+)\/([^/]+)$/);
  if (m) return { kind: 'github', slug: m[1] + '/' + m[2] };
  return null;
}

// ── Normalization helpers (shared by all sources) ────────────────────────────
// run: { id, workflow, title, status, conclusion, branch, event, url, startedAt, updatedAt }
// pr:  { number, title, author, avatar, draft, branch, review, checks, url,
//        updatedAt, additions, deletions }   (additions null = unknown, UI hides)

function stripRef(ref) {
  const s = String(ref || '');
  const pr = s.match(/^refs\/pull\/(\d+)\/(?:merge|head)$/);
  if (pr) return 'PR #' + pr[1];
  return s.replace(/^refs\/heads\//, '');
}

function rollupFromContexts(contexts) {
  let pending = false, ok = false;
  for (const c of contexts || []) {
    const s = String(c.conclusion || c.state || '').toUpperCase();
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED'].includes(s)) return 'failing';
    if (['PENDING', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'EXPECTED', ''].includes(s)) pending = true;
    else ok = true;
  }
  if (pending) return 'pending';
  return ok ? 'passing' : null;
}

function rollupFromState(state) {
  const s = String(state || '').toUpperCase();
  if (!s) return null;
  if (s === 'SUCCESS') return 'passing';
  if (s === 'PENDING' || s === 'EXPECTED') return 'pending';
  return 'failing';
}

// Azure DevOps reviewer votes: 10 approved, 5 approved-with-suggestions,
// 0 no vote, -5 waiting for author, -10 rejected.
function adoVotesToReview(reviewers) {
  const rs = Array.isArray(reviewers) ? reviewers : [];
  let max = 0, min = 0, required = false;
  for (const r of rs) {
    const v = Number(r.vote) || 0;
    if (v > max) max = v;
    if (v < min) min = v;
    if (r.isRequired) required = true;
  }
  if (min <= -5) return 'CHANGES_REQUESTED';
  if (max >= 5) return 'APPROVED';
  return required ? 'REVIEW_REQUIRED' : null;
}

function adoBuildConclusion(result) {
  if (result === 'succeeded') return 'success';
  if (result === 'canceled') return 'cancelled';
  if (!result) return null;
  return 'failure'; // failed | partiallySucceeded — both need eyes
}

// Notification-worthy transition for a run, given its previous baseline state
// (undefined = never seen) and its current one. 'started' = a new run showed
// up still active; 'concluded' = it reached done since the last poll —
// including runs that started AND finished inside one poll interval, which
// would otherwise never notify at all.
function runTransition(prev, now) {
  if (now === 'active' && prev === undefined) return 'started';
  if (now === 'done' && prev !== 'done') return 'concluded';
  return null;
}

// Latest build on a PR's source branch stands in for its checks rollup
// (Azure DevOps has no cheap per-PR rollup in the PR list call).
function adoChecksFromRuns(runs, branch) {
  for (const r of runs || []) {
    if (r.branch !== branch) continue;
    if (r.status !== 'completed') return 'pending';
    return r.conclusion === 'success' ? 'passing' : r.conclusion === 'cancelled' ? null : 'failing';
  }
  return null;
}

module.exports = {
  parseWatchEntry, parseRemote, stripRef, entrySlug, entryUrl,
  rollupFromContexts, rollupFromState, adoVotesToReview, adoBuildConclusion, adoChecksFromRuns,
  runTransition,
};
if (require.main !== module) return;

// ── Runtime state ────────────────────────────────────────────────────────────
// Any startup throw must leave a readable line in the sidecar log — a bare
// "exit status 1" in the plugins manager is undebuggable.
process.on('uncaughtException', (err) => {
  console.error('[' + manifest.id + '] fatal: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});

const wks = connect({ source: manifest.id });
const BUS_OK = wks.busAvailable !== false;
if (!BUS_OK) {
  log(
    'Node ' + process.versions.node + ' has no built-in WebSocket (need >= 22): ' +
    'running degraded — notifications and repo inference are OFF; ' +
    'explicit repos + tokens still work. Upgrade Node to restore full function.',
  );
}
const settings = Object.assign({}, wks.settings, envSettings);

const POLL_SECONDS = Math.max(10, Number(settings.pollSeconds) || 30);
// Comma-separated only — Azure DevOps project names may contain spaces.
const EXPLICIT = String(settings.repo || '')
  .split(',').map(parseWatchEntry).filter(Boolean);
const PAT = String(settings.token || '').trim();
const ADO_PAT = String(settings.adoToken || process.env.AZURE_DEVOPS_EXT_PAT || '').trim();
const NOTIFY_RUNS = settings.notifyRuns !== false;
const NOTIFY_RUN_STARTS = settings.notifyRunStarts !== false;
const NOTIFY_PRS = settings.notifyPrs !== false;
const MAX_INFERRED = 3;

const cwdEntryCache = new Map(); // cwd -> entry | null
const inferred = []; // entries, most recently active first

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024, ...(opts || {}) }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        enoent: !!(err && err.code === 'ENOENT'),
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
      });
    });
  });
}

async function entryForCwd(cwd) {
  if (!cwd) return null;
  if (cwdEntryCache.has(cwd)) return cwdEntryCache.get(cwd);
  const r = await run('git', ['-C', cwd, 'remote', 'get-url', 'origin']);
  const entry = r.ok ? parseRemote(r.stdout) : null;
  cwdEntryCache.set(cwd, entry);
  return entry;
}

function touchInferred(entry) {
  const slug = entrySlug(entry);
  const i = inferred.findIndex((e) => entrySlug(e) === slug);
  if (i === 0) return;
  if (i > 0) inferred.splice(i, 1);
  inferred.unshift(entry);
  if (inferred.length > MAX_INFERRED) inferred.pop();
}

// Agent-scoped panes (opened beside an agent) pin their project's repo so it
// is polled even when it isn't in the explicit list or the inferred set.
const pinned = new Map(); // cwd -> entry

function watched() {
  const base = EXPLICIT.length ? EXPLICIT.slice() : inferred.slice();
  const seen = new Set(base.map(entrySlug));
  for (const entry of pinned.values()) {
    if (!seen.has(entrySlug(entry))) {
      seen.add(entrySlug(entry));
      base.push(entry);
    }
  }
  return base;
}

// Ad-hoc poll (inference found a repo, a pane pinned one, the UI asked): run
// now and re-arm the adaptive timer so a discovered active run tightens the
// cadence immediately.
function pollNow() {
  poll()
    .catch((e) => log('poll error: ' + e.message))
    .finally(() => { if (typeof schedulePoll === 'function') schedulePoll(); });
}

wks.on('agent.state_changed', (data) => {
  const cwd = data && data.cwd;
  if (!cwd || EXPLICIT.length) return;
  entryForCwd(cwd)
    .then((entry) => {
      if (!entry) return;
      const fresh = !inferred.some((e) => entrySlug(e) === entrySlug(entry));
      touchInferred(entry);
      if (fresh) {
        log('watching ' + entrySlug(entry) + ' (inferred from ' + cwd + ')');
        pollNow();
      }
    })
    .catch(() => {});
});
wks.onStatus((c) => { if (c) log('connected to hub bus'); });

// ── GitHub: PAT (REST + GraphQL) or gh CLI ───────────────────────────────────
let ghReady = null;
async function ensureGh() {
  if (ghReady !== null) return ghReady;
  const ver = await run('gh', ['--version']);
  if (ver.enoent || !ver.ok) { ghReady = false; return false; }
  const auth = await run('gh', ['auth', 'status']);
  ghReady = auth.ok;
  return ghReady;
}

async function ghApi(url, init) {
  const res = await fetch(url, {
    ...(init || {}),
    headers: {
      Authorization: 'Bearer ' + PAT,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'workspacer-shiplight',
      ...((init && init.headers) || {}),
    },
  });
  if (!res.ok) throw new Error('GitHub ' + res.status);
  return res.json();
}

function ghJson(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

async function fetchRunsGithub(e) {
  if (PAT) {
    const data = await ghApi('https://api.github.com/repos/' + e.slug + '/actions/runs?per_page=20');
    return (data.workflow_runs || []).map((r) => ({
      id: r.id, workflow: r.name || '', title: r.display_title || '',
      status: r.status, conclusion: r.conclusion,
      branch: r.head_branch || '', event: r.event || '', url: r.html_url || '',
      startedAt: r.run_started_at || r.created_at || '', updatedAt: r.updated_at || '',
    }));
  }
  const r = await run('gh', ['run', 'list', '--repo', e.slug, '--limit', '20', '--json',
    'databaseId,workflowName,displayTitle,status,conclusion,headBranch,event,url,startedAt,updatedAt']);
  if (!r.ok) throw new Error((r.stderr || 'gh run list failed').trim().split('\n')[0]);
  return (ghJson(r.stdout) || []).map((x) => ({
    id: x.databaseId, workflow: x.workflowName || '', title: x.displayTitle || '',
    status: x.status, conclusion: x.conclusion || null,
    branch: x.headBranch || '', event: x.event || '', url: x.url || '',
    startedAt: x.startedAt || '', updatedAt: x.updatedAt || '',
  }));
}

const PR_QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN, first:30, orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{ number title isDraft headRefName url updatedAt additions deletions
        author{login} reviewDecision
        commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } } } } } }`;

async function fetchPrsGithub(e) {
  if (PAT) {
    const [owner, name] = e.slug.split('/');
    const data = await ghApi('https://api.github.com/graphql', {
      method: 'POST',
      body: JSON.stringify({ query: PR_QUERY, variables: { owner, name } }),
    });
    if (data.errors && data.errors.length) throw new Error('GraphQL: ' + data.errors[0].message);
    const nodes = (((data.data || {}).repository || {}).pullRequests || {}).nodes || [];
    return nodes.map((p) => {
      const login = (p.author && p.author.login) || '';
      const roll = ((((p.commits || {}).nodes || [])[0] || {}).commit || {}).statusCheckRollup;
      return {
        number: p.number, title: p.title || '', author: login,
        avatar: login ? 'https://github.com/' + encodeURIComponent(login) + '.png?size=36' : '',
        draft: !!p.isDraft, branch: p.headRefName || '',
        review: p.reviewDecision || null, checks: rollupFromState(roll && roll.state),
        url: p.url || '', updatedAt: p.updatedAt || '',
        additions: p.additions || 0, deletions: p.deletions || 0,
      };
    });
  }
  const r = await run('gh', ['pr', 'list', '--repo', e.slug, '--limit', '30', '--json',
    'number,title,author,isDraft,headRefName,reviewDecision,statusCheckRollup,url,updatedAt,additions,deletions']);
  if (!r.ok) throw new Error((r.stderr || 'gh pr list failed').trim().split('\n')[0]);
  return (ghJson(r.stdout) || []).map((p) => {
    const login = (p.author && p.author.login) || '';
    return {
      number: p.number, title: p.title || '', author: login,
      avatar: login ? 'https://github.com/' + encodeURIComponent(login) + '.png?size=36' : '',
      draft: !!p.isDraft, branch: p.headRefName || '',
      review: p.reviewDecision || null, checks: rollupFromContexts(p.statusCheckRollup),
      url: p.url || '', updatedAt: p.updatedAt || '',
      additions: p.additions || 0, deletions: p.deletions || 0,
    };
  });
}

// ── Azure DevOps: PAT + REST 7.1 ─────────────────────────────────────────────
function adoBase(e) {
  return 'https://dev.azure.com/' + encodeURIComponent(e.org) + '/' + encodeURIComponent(e.project);
}

async function adoApi(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: 'Basic ' + Buffer.from(':' + ADO_PAT).toString('base64'),
      Accept: 'application/json',
      'User-Agent': 'workspacer-shiplight',
    },
  });
  if (res.status === 401 || res.status === 403) throw new Error('Azure DevOps auth failed (' + res.status + ') — check the ADO PAT');
  if (!res.ok) throw new Error('Azure DevOps ' + res.status);
  return res.json();
}

const adoRepoIds = new Map(); // slug -> repository id
async function adoRepoId(e) {
  const slug = entrySlug(e);
  if (adoRepoIds.has(slug)) return adoRepoIds.get(slug);
  const data = await adoApi(adoBase(e) + '/_apis/git/repositories/' + encodeURIComponent(e.repo) + '?api-version=7.1');
  if (!data.id) throw new Error('Azure DevOps repo not found: ' + slug);
  adoRepoIds.set(slug, data.id);
  return data.id;
}

async function fetchRunsAdo(e) {
  const id = await adoRepoId(e);
  // queueTimeDescending, NOT the API's default finishTimeDescending — that
  // default sorts by completion, so queued/in-progress builds (no finish
  // time) fall behind every finished build and never make the $top window:
  // the board showed history but "didn't react" to running pipelines.
  const data = await adoApi(adoBase(e) + '/_apis/build/builds?repositoryId=' + id
    + '&repositoryType=TfsGit&$top=20&queryOrder=queueTimeDescending&api-version=7.1');
  return (data.value || []).map((b) => ({
    id: b.id,
    workflow: (b.definition && b.definition.name) || 'Pipeline',
    title: (b.triggerInfo && b.triggerInfo['ci.message']) || b.buildNumber || '',
    status: b.status === 'completed' ? 'completed' : 'in_progress',
    conclusion: b.status === 'completed' ? adoBuildConclusion(b.result) : null,
    branch: stripRef(b.sourceBranch),
    event: b.reason || '',
    url: (b._links && b._links.web && b._links.web.href) || '',
    startedAt: b.startTime || b.queueTime || '',
    updatedAt: b.finishTime || b.startTime || b.queueTime || '',
  }));
}

async function fetchPrsAdo(e, runs) {
  const id = await adoRepoId(e);
  const data = await adoApi(adoBase(e) + '/_apis/git/repositories/' + id
    + '/pullrequests?searchCriteria.status=active&$top=30&api-version=7.1');
  return (data.value || []).map((p) => {
    const branch = stripRef(p.sourceRefName);
    return {
      number: p.pullRequestId,
      title: p.title || '',
      author: (p.createdBy && (p.createdBy.displayName || p.createdBy.uniqueName)) || '',
      avatar: '', // ADO avatar URLs need session auth; the pane renders initials
      draft: !!p.isDraft,
      branch,
      review: adoVotesToReview(p.reviewers),
      checks: adoChecksFromRuns(runs, branch),
      url: entryUrl(e) + '/pullrequest/' + p.pullRequestId,
      updatedAt: p.creationDate || '',
      additions: null, // not in the PR list call; the pane hides the diffstat
      deletions: null,
    };
  });
}

// ── Merged detection (for the 🎉 notification) ───────────────────────────────
async function prMerged(entry, number) {
  try {
    if (entry.kind === 'ado') {
      const id = await adoRepoId(entry);
      const p = await adoApi(adoBase(entry) + '/_apis/git/repositories/' + id
        + '/pullrequests/' + number + '?api-version=7.1');
      return p.status === 'completed';
    }
    if (PAT) {
      const p = await ghApi('https://api.github.com/repos/' + entry.slug + '/pulls/' + number);
      return !!p.merged;
    }
    const r = await run('gh', ['pr', 'view', String(number), '--repo', entry.slug, '--json', 'state']);
    const j = r.ok ? ghJson(r.stdout) : null;
    return !!j && j.state === 'MERGED';
  } catch { return false; }
}

// ── Poll + diff + notify ─────────────────────────────────────────────────────
const state = { repos: new Map() }; // slug -> { slug, kind, url, prs, runs, fetchedAt, error }
const runBaseline = new Map(); // `${slug}#${runId}` -> 'active' | 'done'
const prBaseline = new Map(); // `${slug}#${n}` -> { review }
const baselined = new Set();
const notified = new Set();

const NOTIFY_SOURCE = 'plugin:' + manifest.id;
const PANE_TYPE = (manifest.panes && manifest.panes[0] && manifest.panes[0].type) || manifest.id;

// Post into the in-app notification center (and, per user prefs, an OS toast).
// `key` makes a repeated condition REPLACE its previous entry — one slot per
// pipeline / per PR — instead of stacking. Click target: the run/PR `url` when
// there is one, else the Shiplight pane.
async function notify(payload) {
  const p = Object.assign({ level: 'info', source: NOTIFY_SOURCE }, payload);
  if (p.url) delete p.paneType;
  else { delete p.url; p.paneType = PANE_TYPE; }
  try { await wks.call('notifications.post', p); }
  catch (e) { log('notifications.post failed: ' + e.message); }
}

function prUrl(entry, number) {
  return entry.kind === 'ado'
    ? entryUrl(entry) + '/pullrequest/' + number
    : entryUrl(entry) + '/pull/' + number;
}

function once(key, fn) {
  if (notified.has(key)) return;
  notified.add(key);
  fn();
}

function diffRuns(slug, runs) {
  for (const r of runs) {
    const key = slug + '#' + r.id;
    const prev = runBaseline.get(key);
    const now = r.status === 'completed' ? 'done' : 'active';
    runBaseline.set(key, now);
    if (!baselined.has(slug)) continue;
    const t = runTransition(prev, now);
    // One slot per pipeline+branch: the verdict replaces the start entry, a
    // re-run replaces the previous run's entries.
    const slot = 'run:' + slug + ':' + (r.workflow || 'ci') + ':' + (r.branch || '');
    if (t === 'started' && NOTIFY_RUN_STARTS) {
      once('start:' + key, () =>
        notify({
          title: 'Pipeline started',
          body: (r.workflow || 'CI') + ' · ' + (r.branch || '?') + ' — ' + slug,
          level: 'info',
          url: r.url || undefined,
          key: slot,
        }));
    } else if (t === 'concluded' && NOTIFY_RUNS) {
      const ok = r.conclusion === 'success';
      once('run:' + key, () =>
        notify({
          title: ok ? 'Pipeline passed' : 'Pipeline ' + (r.conclusion || 'failed'),
          body: (r.workflow || 'CI') + ' · ' + (r.branch || '?') + ' — ' + slug,
          level: ok ? 'success' : 'error',
          url: r.url || undefined,
          key: slot,
        }));
    }
  }
}

function diffPrs(entry, prs) {
  const slug = entrySlug(entry);
  const seen = new Set();
  for (const p of prs) {
    const key = slug + '#' + p.number;
    seen.add(key);
    const prev = prBaseline.get(key);
    prBaseline.set(key, { review: p.review });
    if (!baselined.has(slug) || !NOTIFY_PRS) continue;
    // One notification slot per PR ('pr:<slug>#<n>'): opened → approved →
    // changes-requested → merged each replace the previous entry for that PR.
    const slot = 'pr:' + key;
    if (!prev) {
      once('open:' + key, () =>
        notify({
          title: 'PR #' + p.number + ' opened',
          body: p.title + ' — ' + (p.author ? p.author + ' · ' : '') + slug,
          level: 'info', url: p.url || undefined, key: slot,
        }));
      continue;
    }
    if (p.review !== prev.review) {
      if (p.review === 'APPROVED') {
        once('appr:' + key + ':' + p.updatedAt, () =>
          notify({
            title: 'PR #' + p.number + ' approved',
            body: p.title + ' — ' + slug,
            level: 'success', url: p.url || undefined, key: slot,
          }));
      } else if (p.review === 'CHANGES_REQUESTED') {
        once('chreq:' + key + ':' + p.updatedAt, () =>
          notify({
            title: 'Changes requested on #' + p.number,
            body: p.title + ' — ' + slug,
            level: 'warn', url: p.url || undefined, key: slot,
          }));
      }
    }
  }
  for (const key of Array.from(prBaseline.keys())) {
    if (!key.startsWith(slug + '#') || seen.has(key)) continue;
    prBaseline.delete(key);
    if (!baselined.has(slug) || !NOTIFY_PRS) continue;
    const number = Number(key.slice(slug.length + 1));
    prMerged(entry, number).then((merged) => {
      if (merged) once('merge:' + key, () =>
        notify({
          title: 'PR #' + number + ' merged',
          body: slug,
          level: 'success', url: prUrl(entry, number), key: 'pr:' + key,
        }));
    }).catch(() => {});
  }
}

async function fetchEntry(entry) {
  if (entry.kind === 'ado') {
    if (!ADO_PAT) throw new Error('No Azure DevOps access: set the ADO PAT in settings.');
    const runs = await fetchRunsAdo(entry);
    const prs = await fetchPrsAdo(entry, runs);
    return { runs, prs };
  }
  if (!PAT && !(await ensureGh())) {
    throw new Error('No GitHub access: set a PAT in settings or authenticate the gh CLI.');
  }
  const [runs, prs] = await Promise.all([fetchRunsGithub(entry), fetchPrsGithub(entry)]);
  return { runs, prs };
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const entries = watched();
    const slugs = entries.map(entrySlug);
    for (const slug of Array.from(state.repos.keys())) {
      if (!slugs.includes(slug)) state.repos.delete(slug);
    }
    await Promise.all(entries.map(async (entry) => {
      const slug = entrySlug(entry);
      const cur = state.repos.get(slug)
        || { slug, kind: entry.kind, url: entryUrl(entry), prs: [], runs: [], fetchedAt: 0, error: null };
      state.repos.set(slug, cur);
      try {
        const { runs, prs } = await fetchEntry(entry);
        diffRuns(slug, runs);
        diffPrs(entry, prs);
        baselined.add(slug);
        cur.runs = runs;
        cur.prs = prs;
        cur.fetchedAt = Date.now();
        cur.error = null;
      } catch (e) {
        cur.error = e.message;
        log(slug + ': ' + e.message);
      }
    }));
  } finally {
    polling = false;
  }
}

// Adaptive cadence: while any watched repo has a queued/running pipeline,
// poll every 10s (capped by the configured interval) so the board tracks live
// runs; otherwise the configured pollSeconds applies. The pane refetches
// /state every 5s regardless, so a faster poll is immediately visible.
function hasActiveRuns() {
  for (const r of state.repos.values()) {
    if ((r.runs || []).some((x) => x.status !== 'completed')) return true;
  }
  return false;
}

let pollTimer = null;
function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  const secs = hasActiveRuns() ? Math.min(10, POLL_SECONDS) : POLL_SECONDS;
  pollTimer = setTimeout(() => {
    poll()
      .catch((e) => log('poll error: ' + e.message))
      .finally(schedulePoll);
  }, secs * 1000);
}
poll()
  .catch((e) => log('poll error: ' + e.message))
  .finally(schedulePoll);
// Probe gh once at boot even before any repo is watched, so the pane's
// first-run card can say up front whether GitHub access exists.
if (!PAT) ensureGh().catch(() => {});

// ── HTTP: pane UI + state ────────────────────────────────────────────────────
// A pane opened beside an agent passes its project cwd; resolve it to a repo
// (git remote, cached), pin it into the watch set, and tell the pane which
// slug to focus on. focus stays null while resolving or when the cwd has no
// recognizable remote — the pane says so instead of showing the fleet view.
async function focusSlugFor(cwd) {
  if (!cwd) return null;
  const entry = await entryForCwd(cwd);
  if (!entry) return null;
  if (!pinned.has(cwd)) {
    pinned.set(cwd, entry);
    pollNow();
  }
  return entrySlug(entry);
}

function stateJson(focus) {
  return JSON.stringify({
    focus: focus ?? null,
    pollSeconds: POLL_SECONDS,
    explicit: EXPLICIT.length > 0,
    // Auth summary for the pane's first-run guidance:
    //   github: 'pat' | 'gh' | 'none' (null = gh probe still running)
    //   ado:    'pat' | 'none'
    auth: {
      github: PAT ? 'pat' : ghReady === null ? null : ghReady ? 'gh' : 'none',
      ado: ADO_PAT ? 'pat' : 'none',
    },
    // Degraded-mode signal for the pane's warning strip (old Node → no bus →
    // no notifications / repo inference).
    runtime: { node: process.versions.node, busAvailable: BUS_OK },
    repos: Array.from(state.repos.values()),
  });
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url || '/', 'http://x');
  const url = parsed.pathname;
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url === '/state') {
    const cwd = parsed.searchParams.get('cwd') || '';
    focusSlugFor(cwd)
      .catch(() => null)
      .then((focus) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(stateJson(focus));
      });
    return;
  }
  if (url === '/refresh' && req.method === 'POST') {
    pollNow();
    res.writeHead(202);
    return res.end('ok');
  }
  fs.readFile(path.join(DIR, 'ui', 'index.html'), (err, buf) => {
    if (err) { res.writeHead(500); return res.end('ui missing'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
});
server.on('error', (e) => {
  log(
    'http server error: ' + e.message +
    (e && e.code === 'EADDRINUSE'
      ? ' — port ' + PORT + ' is already in use (a previous Shiplight instance still running?)'
      : ''),
  );
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => log('pane on http://127.0.0.1:' + PORT));
