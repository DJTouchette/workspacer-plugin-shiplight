# 🚢 Shiplight

**Running pipelines and open PRs for your project, at a glance — with notifications when something needs you.**

A [workspacer](https://github.com/DJTouchette/workspacer) plugin. One glanceable lamp — green when everything is clear, amber and breathing while pipelines run, red when something needs eyes — over a designed board of your GitHub Actions runs and open pull requests.

## What it does

- **The lamp.** A single status light summarizing every watched repo: *All clear* / *N pipelines running* / *Something is red*. Readable from across the room.
- **Pipelines.** Everything currently running (live spinner + elapsed time), plus the standing verdict of the latest completed run per workflow.
- **Pull requests.** Author, review state (approved / changes requested / review required), checks rollup, branch, ±diffstat, freshness — drafts dimmed.
- **Notifications** on *transitions only* (never on state that was already true when it started watching):
  - a pipeline concludes → ✅ / ❌ with workflow + branch
  - a PR is opened, approved, gets changes requested, or is merged 🎉

## Setup

Install from workspacer: **command palette → "Install Plugin…" → `DJTouchette/workspacer-plugin-shiplight`**, then open the **Shiplight** pane.

Auth, either of:

- **gh CLI** (default): if [`gh`](https://cli.github.com/) is on your PATH and authenticated (`gh auth login`), nothing to configure.
- **PAT**: set *GitHub token* in the plugin's settings (a fine-grained PAT with read access to the repos). The token is stored in the plugin's local `.settings.json` — prefer the gh CLI if you'd rather not persist a token.

Repos, either of:

- **Explicit**: set *Repos* to `owner/name` (comma-separated for several).
- **Inferred** (default): Shiplight watches the projects your agents actually touch — it resolves each active agent cwd's `origin` remote and follows the 3 most recent.

Settings also cover the poll interval and independent toggles for pipeline / PR notifications.

## How it works

A zero-dependency sidecar (Node ≥ 22 built-ins only) polls GitHub every `pollSeconds` — `gh run list` + `gh pr list`, or REST + GraphQL when a PAT is set — normalizes both sources into one shape, diffs against the previous poll to fire `notifications.post` on transitions, and serves the pane UI from its own port. The pane just polls the sidecar's `/state`; it never talks to GitHub itself.

Bus surface (see `plugin.json`): consumes `agent.state_changed` (only to learn project cwds for repo inference), calls `notifications.post`. Nothing else.

## License

MIT
