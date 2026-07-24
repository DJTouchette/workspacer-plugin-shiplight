# 🚢 Shiplight

Running pipelines and open PRs for your project, at a glance — with notifications when something needs you.

A [workspacer](https://github.com/DJTouchette/workspacer) plugin. One glanceable lamp — green when everything is clear, amber and breathing while pipelines run, red when something needs eyes — over a designed board of your pipeline runs and open pull requests. Speaks **GitHub** (Actions + PRs) and **Azure DevOps** (Pipelines + PRs).

## What it does

- **The lamp.** A single status light summarizing every watched repo: *All clear* / *N pipelines running* / *Something is red*. Readable from across the room.
- **Pipelines.** Everything currently running (live spinner + elapsed time), plus the standing verdict of the latest completed run per workflow.
- **Pull requests.** Author, review state (approved / changes requested / review required), checks rollup, branch, ±diffstat, freshness — drafts dimmed.
- **Notifications** on *transitions only* (never on state that was already true when it started watching):
  - a pipeline is triggered → info notification with workflow + branch
  - a pipeline concludes → success/error notification with workflow + branch
    (a run that starts *and* finishes between polls still gets its verdict)
  - a PR is opened (info), approved (success), gets changes requested (warn), or is merged (success)

  Notifications land in workspacer's in-app notification center (bell + toast) and, per your
  notification preferences, as a clickable OS notification. Clicking opens the run/PR in your
  browser (or the Shiplight pane when no link applies). Each pipeline+branch and each PR gets
  **one notification slot**: a pipeline's verdict replaces its "started" entry, a re-run or a
  PR's next state *replaces* the previous entry instead of stacking.

## Setup

Install from workspacer: **command palette → "Install Plugin…" → `DJTouchette/workspacer-plugin-shiplight`**, then open the **Shiplight** pane.

Auth:

- **GitHub — gh CLI** (default): if [`gh`](https://cli.github.com/) is on your PATH and authenticated (`gh auth login`), nothing to configure.
- **GitHub — PAT**: set *GitHub token* in the plugin's settings (a fine-grained PAT with read access to the repos).
- **Azure DevOps — PAT**: set *Azure DevOps token* (scopes: Code read + Build read). Required for ADO repos — there is no CLI fallback.

Both token settings are declared `"secret": true` (v1.1.1): workspacer renders them as masked write-only inputs (set/replace/clear — never displayed), redacts them from every settings read, broadcast, and webview injection, and stores them in the plugin's local `.settings.json` (0600). The plaintext reaches only this sidecar via its `WKS_SETTINGS` env. For GitHub, prefer the gh CLI if you'd rather not persist a token at all.

Repos, either of:

- **Explicit**: set *Repos* comma-separated — `owner/name` for GitHub, `org/project/repo` for Azure DevOps.
- **Inferred** (default): Shiplight watches the projects your agents actually touch — it resolves each active agent cwd's `origin` remote (github.com, dev.azure.com, and legacy visualstudio.com forms all recognized) and follows the 3 most recent. Assign a project to a directory by just having its remote point there.

Settings also cover the poll interval and independent toggles for pipeline start / pipeline verdict / PR notifications.

## How it works

A zero-dependency sidecar (Node ≥ 22 built-ins only) polls every `pollSeconds` — GitHub via `gh run list` + `gh pr list` (or REST + GraphQL with a PAT), Azure DevOps via REST 7.1 (`build/builds` + `git/pullrequests`, reviewer votes mapped to review states, the branch's latest build standing in for a PR checks rollup) — normalizes every source into one shape, diffs against the previous poll to fire `notifications.post` on transitions (level-tagged, keyed per pipeline/PR so repeats replace, linking to the run/PR), and serves the pane UI from its own port. The pane just polls the sidecar's `/state`; it never talks to GitHub or ADO itself. Run `node test.js` for the pure-helper tests (remote parsing, vote mapping, rollups).

Bus surface (see `plugin.json`): consumes `agent.state_changed` (only to learn project cwds for repo inference), calls `notifications.post`. Nothing else.

## License

MIT
