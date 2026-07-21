#!/usr/bin/env node
// Shiplight — running pipelines + open PRs for your project, at a glance.
//
// Sidecar: polls GitHub for the watched repos (explicit setting, or inferred
// from the projects your agents touch), serves the pane UI from ./ui, and
// posts OS notifications on state *transitions* (a pipeline concluding, a PR
// getting approved / changes-requested / opened / merged) — never on states
// that were already true when it started watching.
//
// Data source: a PAT (settings.token → REST + GraphQL) or the gh CLI's own
// auth. Zero dependencies — Node >= 22 built-ins only.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { connect } = require('./wks.js');

const DIR = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
const PORT = Number(process.env.PORT || (manifest.server && manifest.server.port) || 9211);

const wks = connect({ source: manifest.id });

// Settings: WKS_SETTINGS (defaults merged by the hub) over the raw overlay
// file the SDK reads; every read below still applies a code default.
let envSettings = {};
try { envSettings = JSON.parse(process.env.WKS_SETTINGS || '{}'); } catch {}
const settings = Object.assign({}, wks.settings, envSettings);

const POLL_SECONDS = Math.max(10, Number(settings.pollSeconds) || 30);
const EXPLICIT_REPOS = String(settings.repo || '')
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter((s) => /^[^/]+\/[^/]+$/.test(s));
const PAT = String(settings.token || '').trim();
const NOTIFY_RUNS = settings.notifyRuns !== false;
const NOTIFY_PRS = settings.notifyPrs !== false;
const MAX_INFERRED = 3;

function log(msg) {
  console.log('[' + manifest.id + '] ' + msg);
}

// ── Repo inference (no explicit setting) ─────────────────────────────────────
// agent.state_changed carries the agent's cwd; its git remote names the repo.
const cwdSlugCache = new Map(); // cwd -> slug | '' (negative-cached)
const inferred = []; // slugs, most recently active first

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

function parseRepoSlug(url) {
  if (!url) return '';
  const s = url.trim().replace(/\.git$/i, '');
  const m = s.match(/[:/]([^/:]+)\/([^/]+)$/);
  return m ? m[1] + '/' + m[2] : '';
}

async function slugForCwd(cwd) {
  if (!cwd) return '';
  if (cwdSlugCache.has(cwd)) return cwdSlugCache.get(cwd);
  const r = await run('git', ['-C', cwd, 'remote', 'get-url', 'origin']);
  const slug = r.ok ? parseRepoSlug(r.stdout) : '';
  cwdSlugCache.set(cwd, slug);
  return slug;
}

function touchInferred(slug) {
  if (!slug) return;
  const i = inferred.indexOf(slug);
  if (i === 0) return;
  if (i > 0) inferred.splice(i, 1);
  inferred.unshift(slug);
  if (inferred.length > MAX_INFERRED) inferred.pop();
}

function watchedRepos() {
  return EXPLICIT_REPOS.length ? EXPLICIT_REPOS : inferred.slice();
}

wks.on('agent.state_changed', (data) => {
  const cwd = data && data.cwd;
  if (!cwd || EXPLICIT_REPOS.length) return;
  slugForCwd(cwd)
    .then((slug) => {
      if (!slug) return;
      const fresh = !inferred.includes(slug);
      touchInferred(slug);
      if (fresh) {
        log('watching ' + slug + ' (inferred from ' + cwd + ')');
        poll().catch((e) => log('poll error: ' + e.message));
      }
    })
    .catch(() => {});
});
wks.onStatus((c) => { if (c) log('connected to hub bus'); });

// ── GitHub access: PAT (REST + GraphQL) or gh CLI ────────────────────────────
let ghReady = null;
async function ensureGh() {
  if (ghReady !== null) return ghReady;
  const ver = await run('gh', ['--version']);
  if (ver.enoent || !ver.ok) {
    log('gh CLI not found — set a PAT in settings or install https://cli.github.com/');
    ghReady = false;
    return false;
  }
  const auth = await run('gh', ['auth', 'status']);
  if (!auth.ok) {
    log('gh is not authenticated (run: gh auth login) — or set a PAT in settings');
    ghReady = false;
    return false;
  }
  ghReady = true;
  return true;
}

async function apiFetch(url, init) {
  const res = await fetch(url, {
    ...(init || {}),
    headers: {
      Authorization: 'Bearer ' + PAT,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'workspacer-shiplight',
      ...((init && init.headers) || {}),
    },
  });
  if (!res.ok) throw new Error('GitHub ' + res.status + ' for ' + url.replace(/^https:\/\/api\.github\.com/, ''));
  return res.json();
}

// Normalized shapes the UI renders:
//   run: { id, workflow, title, status, conclusion, branch, event, url, startedAt, updatedAt }
//   pr:  { number, title, author, draft, branch, review, checks, url, updatedAt, additions, deletions }
// review ∈ APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
// checks ∈ passing | failing | pending | null

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

async function fetchRunsPat(slug) {
  const data = await apiFetch('https://api.github.com/repos/' + slug + '/actions/runs?per_page=20');
  return (data.workflow_runs || []).map((r) => ({
    id: r.id,
    workflow: r.name || '',
    title: r.display_title || '',
    status: r.status,
    conclusion: r.conclusion,
    branch: r.head_branch || '',
    event: r.event || '',
    url: r.html_url || '',
    startedAt: r.run_started_at || r.created_at || '',
    updatedAt: r.updated_at || '',
  }));
}

const PR_QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN, first:30, orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{ number title isDraft headRefName url updatedAt additions deletions
        author{login} reviewDecision
        commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } } } } } }`;

async function fetchPrsPat(slug) {
  const [owner, name] = slug.split('/');
  const data = await apiFetch('https://api.github.com/graphql', {
    method: 'POST',
    body: JSON.stringify({ query: PR_QUERY, variables: { owner, name } }),
  });
  if (data.errors && data.errors.length) throw new Error('GraphQL: ' + data.errors[0].message);
  const nodes = (((data.data || {}).repository || {}).pullRequests || {}).nodes || [];
  return nodes.map((p) => ({
    number: p.number,
    title: p.title || '',
    author: (p.author && p.author.login) || '',
    draft: !!p.isDraft,
    branch: p.headRefName || '',
    review: p.reviewDecision || null,
    checks: rollupFromState((((p.commits || {}).nodes || [])[0] || { commit: {} }).commit.statusCheckRollup
      && p.commits.nodes[0].commit.statusCheckRollup.state),
    url: p.url || '',
    updatedAt: p.updatedAt || '',
    additions: p.additions || 0,
    deletions: p.deletions || 0,
  }));
}

function ghJson(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

async function fetchRunsGh(slug) {
  const r = await run('gh', ['run', 'list', '--repo', slug, '--limit', '20', '--json',
    'databaseId,workflowName,displayTitle,status,conclusion,headBranch,event,url,startedAt,updatedAt']);
  if (!r.ok) throw new Error((r.stderr || 'gh run list failed').trim().split('\n')[0]);
  return (ghJson(r.stdout) || []).map((x) => ({
    id: x.databaseId,
    workflow: x.workflowName || '',
    title: x.displayTitle || '',
    status: x.status,
    conclusion: x.conclusion || null,
    branch: x.headBranch || '',
    event: x.event || '',
    url: x.url || '',
    startedAt: x.startedAt || '',
    updatedAt: x.updatedAt || '',
  }));
}

async function fetchPrsGh(slug) {
  const r = await run('gh', ['pr', 'list', '--repo', slug, '--limit', '30', '--json',
    'number,title,author,isDraft,headRefName,reviewDecision,statusCheckRollup,url,updatedAt,additions,deletions']);
  if (!r.ok) throw new Error((r.stderr || 'gh pr list failed').trim().split('\n')[0]);
  return (ghJson(r.stdout) || []).map((p) => ({
    number: p.number,
    title: p.title || '',
    author: (p.author && p.author.login) || '',
    draft: !!p.isDraft,
    branch: p.headRefName || '',
    review: p.reviewDecision || null,
    checks: rollupFromContexts(p.statusCheckRollup),
    url: p.url || '',
    updatedAt: p.updatedAt || '',
    additions: p.additions || 0,
    deletions: p.deletions || 0,
  }));
}

async function prMerged(slug, number) {
  try {
    if (PAT) {
      const p = await apiFetch('https://api.github.com/repos/' + slug + '/pulls/' + number);
      return !!p.merged;
    }
    const r = await run('gh', ['pr', 'view', String(number), '--repo', slug, '--json', 'state']);
    const j = r.ok ? ghJson(r.stdout) : null;
    return !!j && j.state === 'MERGED';
  } catch { return false; }
}

// ── Poll + diff + notify ─────────────────────────────────────────────────────
// state.repos: slug -> { slug, prs, runs, fetchedAt, error }
const state = { repos: new Map(), mode: PAT ? 'pat' : 'gh' };
const runBaseline = new Map(); // `${slug}#${runId}` -> last status ('active'|'done')
const prBaseline = new Map(); // `${slug}#${n}` -> { review }
const baselined = new Set(); // slugs that completed a first successful poll
const notified = new Set(); // one-shot notification keys

async function notify(title, body) {
  try { await wks.call('notifications.post', { title, body }); }
  catch (e) { log('notifications.post failed: ' + e.message); }
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
    if (!baselined.has(slug)) continue; // first poll: seed silently
    if (now === 'done' && prev === 'active' && NOTIFY_RUNS) {
      const ok = r.conclusion === 'success';
      once('run:' + key, () =>
        notify(
          ok ? '✅ Pipeline passed' : '❌ Pipeline ' + (r.conclusion || 'failed'),
          (r.workflow || 'CI') + ' · ' + (r.branch || '?') + ' — ' + slug,
        ));
    }
  }
}

function diffPrs(slug, prs) {
  const seen = new Set();
  for (const p of prs) {
    const key = slug + '#' + p.number;
    seen.add(key);
    const prev = prBaseline.get(key);
    prBaseline.set(key, { review: p.review });
    if (!baselined.has(slug)) continue;
    if (!NOTIFY_PRS) continue;
    if (!prev) {
      once('open:' + key, () =>
        notify('PR #' + p.number + ' opened', p.title + ' — ' + (p.author ? '@' + p.author + ' · ' : '') + slug));
      continue;
    }
    if (p.review !== prev.review) {
      if (p.review === 'APPROVED') {
        once('appr:' + key + ':' + p.updatedAt, () =>
          notify('✅ PR #' + p.number + ' approved', p.title + ' — ' + slug));
      } else if (p.review === 'CHANGES_REQUESTED') {
        once('chreq:' + key + ':' + p.updatedAt, () =>
          notify('✳️ Changes requested on #' + p.number, p.title + ' — ' + slug));
      }
    }
  }
  // A previously-open PR that vanished: merged (celebrate) or closed (silent).
  for (const key of Array.from(prBaseline.keys())) {
    if (!key.startsWith(slug + '#') || seen.has(key)) continue;
    prBaseline.delete(key);
    if (!baselined.has(slug) || !NOTIFY_PRS) continue;
    const number = Number(key.slice(slug.length + 1));
    prMerged(slug, number).then((merged) => {
      if (merged) once('merge:' + key, () => notify('🎉 PR #' + number + ' merged', slug));
    }).catch(() => {});
  }
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const slugs = watchedRepos();
    for (const slug of Array.from(state.repos.keys())) {
      if (!slugs.includes(slug)) state.repos.delete(slug);
    }
    if (!slugs.length) return;
    if (!PAT && !(await ensureGh())) {
      for (const slug of slugs) {
        state.repos.set(slug, {
          slug, prs: [], runs: [], fetchedAt: 0,
          error: 'No GitHub access: set a PAT in settings or authenticate the gh CLI.',
        });
      }
      return;
    }
    await Promise.all(slugs.map(async (slug) => {
      const entry = state.repos.get(slug) || { slug, prs: [], runs: [], fetchedAt: 0, error: null };
      state.repos.set(slug, entry);
      try {
        const [runs, prs] = await Promise.all([
          PAT ? fetchRunsPat(slug) : fetchRunsGh(slug),
          PAT ? fetchPrsPat(slug) : fetchPrsGh(slug),
        ]);
        diffRuns(slug, runs);
        diffPrs(slug, prs);
        baselined.add(slug);
        entry.runs = runs;
        entry.prs = prs;
        entry.fetchedAt = Date.now();
        entry.error = null;
      } catch (e) {
        entry.error = e.message;
        log(slug + ': ' + e.message);
      }
    }));
  } finally {
    polling = false;
  }
}

setInterval(() => { poll().catch((e) => log('poll error: ' + e.message)); }, POLL_SECONDS * 1000);
poll().catch((e) => log('poll error: ' + e.message));

// ── HTTP: pane UI + state ────────────────────────────────────────────────────
function stateJson() {
  return JSON.stringify({
    mode: state.mode,
    pollSeconds: POLL_SECONDS,
    explicit: EXPLICIT_REPOS.length > 0,
    repos: Array.from(state.repos.values()),
  });
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(stateJson());
  }
  if (url === '/refresh' && req.method === 'POST') {
    poll().catch(() => {});
    res.writeHead(202);
    return res.end('ok');
  }
  fs.readFile(path.join(DIR, 'ui', 'index.html'), (err, buf) => {
    if (err) { res.writeHead(500); return res.end('ui missing'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
});
server.listen(PORT, '127.0.0.1', () => log('pane on http://127.0.0.1:' + PORT));
