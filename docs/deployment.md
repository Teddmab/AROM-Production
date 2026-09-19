# Deployment

## Production Worker (`arom-production`)

Production is deployed **only** by
[`.github/workflows/deploy-production-worker.yml`](../.github/workflows/deploy-production-worker.yml).
Pushing to `main` never deploys; `ci.yml` is validation only (install, lint,
typecheck, tests, build) and holds no credentials.

The deploy workflow:

- is `workflow_dispatch` only, and must be dispatched from `main`;
- requires the phrase `deploy-arom-production` typed into **both** `target`
  and `confirm_target`;
- has the Worker (`arom-production`) and Firebase project
  (`arom-production-657f2`) hardcoded — neither is an input;
- runs in the `production-worker` GitHub Environment;
- checks out `main` and refuses to run unless that commit is the current tip
  of `origin/main`;
- deploys with the repository's pinned local Wrangler
  (`node_modules/.bin/wrangler`, exact version in `package.json`), never a
  floating `npx wrangler`, with `--config wrangler.json --name arom-production`;
- inspects the generated config and built artifact first
  (`scripts/ci/check-production-worker-artifact.mjs`) and fails on a different
  Worker name, missing `ASSETS`/`nodejs_compat`, build-time Firebase overrides,
  a missing production Firebase project, or any QA identifier.

`scripts/ci/workflowSafety.test.ts` (part of `bun run test`) fails if any of
these guarantees is weakened, or if any other workflow gains a deploy command.

### Owner configuration (GitHub settings — not managed by this repo)

Create the Environment `production-worker` (Settings → Environments) and set:

- **Deployment branches**: selected branches → `main` only.
- **Required reviewers** (and "prevent self-review") where the plan supports
  it. Environment reviewers are available on public repositories, and on
  private repositories only on paid plans; without them the manual trigger,
  the `main`-only rule and the double confirmation still apply.
- **Environment secrets** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
  (token scoped to editing Workers only). Do not keep them as repository-level
  secrets. Without them the deploy job fails closed.

Also recommended: protect `main` with required pull-request review and the
`verify` check.

## QA (`arom-production-qa` / `arom-qa`)

QA is a **separate, explicit process** and is not part of any workflow here.
It targets Worker `arom-production-qa` and Firebase project `arom-qa`:

1. Build with the QA Firebase web config supplied through `VITE_FIREBASE_*`
   (the source defaults are the *production* project — an unset override
   builds a production-pointing artifact).
2. Rename the generated `.output/server/wrangler.json` to the QA Worker name in
   a copy, and deploy that copy with the pinned local Wrangler and
   `--name arom-production-qa`.
3. Verify the built artifact contains no production project identifiers.

Never reuse the production workflow for QA: it refuses QA artifacts by design.
