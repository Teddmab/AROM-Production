import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPROVED_DEPLOY_WORKFLOWS,
  DEPLOY_WORKFLOW,
  auditDeployWorkflow,
  auditNonDeployWorkflow,
  auditValidationWorkflow,
  hasDeployCommand,
} from "./workflowAudit";
// @ts-expect-error — plain ESM script shared with the workflow; no type declarations.
import { checkProductionArtifact } from "./check-production-worker-artifact.mjs";

const WORKFLOWS_DIR = join(__dirname, "..", "..", ".github", "workflows");
const read = (name: string) => readFileSync(join(WORKFLOWS_DIR, name), "utf8");
const deploy = read(DEPLOY_WORKFLOW);
const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));

describe("production deploy workflow (real file)", () => {
  it("passes every safety rule", () => {
    expect(auditDeployWorkflow(deploy)).toEqual([]);
  });
});

describe("no other workflow can deploy", () => {
  it("only approved workflows contain a deploy command, use production credentials, or use an environment", () => {
    for (const file of workflowFiles.filter((f) => !APPROVED_DEPLOY_WORKFLOWS.includes(f))) {
      expect(auditNonDeployWorkflow(file, read(file))).toEqual([]);
    }
  });

  it("the ordinary validation workflow is push/PR only, read-only, and has no deploy capability", () => {
    expect(auditValidationWorkflow(read("ci.yml"))).toEqual([]);
    expect(hasDeployCommand(read("ci.yml"))).toBe(false);
  });

  it("is enforced by the rule itself: an unapproved workflow gaining a deploy command is reported", () => {
    const bad = `${read("ci.yml")}\n      - run: ./node_modules/.bin/wrangler deploy --name arom-production\n`;
    expect(auditNonDeployWorkflow("ci.yml", bad).join("\n")).toMatch(/deploy command/);
    for (const cmd of [
      "npx wrangler deploy",
      "bunx wrangler@4 deploy",
      "firebase deploy --only firestore:rules",
      "nitro deploy --prebuilt",
    ]) {
      expect(hasDeployCommand(cmd)).toBe(true);
    }
    expect(hasDeployCommand("wrangler deploy")).toBe(true);
    expect(hasDeployCommand("bun run build")).toBe(false);
  });
});

describe("the audit fails on each unsafe mutation of the deploy workflow", () => {
  const mutate = (from: string | RegExp, to: string) => {
    const out = deploy.replace(from, to);
    expect(out).not.toBe(deploy); // the mutation actually applied
    return auditDeployWorkflow(out).join("\n");
  };

  it("push trigger added", () => {
    expect(
      mutate(
        "on:\n  workflow_dispatch:",
        "on:\n  push:\n    branches: [main]\n  workflow_dispatch:",
      ),
    ).toMatch(/triggers must be exactly|forbidden trigger: push/);
  });
  it("pull_request trigger added", () => {
    expect(
      mutate("on:\n  workflow_dispatch:", "on:\n  pull_request:\n  workflow_dispatch:"),
    ).toMatch(/forbidden trigger: pull_request/);
  });
  it("schedule / workflow_run added", () => {
    expect(
      mutate(
        "on:\n  workflow_dispatch:",
        "on:\n  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:",
      ),
    ).toMatch(/forbidden trigger: schedule/);
    expect(
      mutate(
        "on:\n  workflow_dispatch:",
        "on:\n  workflow_run:\n    workflows: [CI]\n  workflow_dispatch:",
      ),
    ).toMatch(/forbidden trigger: workflow_run/);
  });
  it("Worker name becomes an input", () => {
    expect(
      mutate(
        "      confirm_target:",
        "      worker:\n        description: w\n        type: string\n      confirm_target:",
      ),
    ).toMatch(/inputs must be exactly/);
    expect(mutate("--name arom-production", "--name ${{ inputs.worker }}")).toMatch(
      /unapproved input: worker/,
    );
  });
  it("production Worker name is no longer fixed", () => {
    expect(
      mutate(
        "PRODUCTION_WORKER_NAME: arom-production",
        "PRODUCTION_WORKER_NAME: ${{ inputs.target }}",
      ),
    ).toMatch(/PRODUCTION_WORKER_NAME/);
    expect(
      mutate("--config wrangler.json --name arom-production", "--config wrangler.json"),
    ).toMatch(/deploy command must be/);
  });
  it("Firebase production project is no longer fixed", () => {
    expect(
      mutate(
        "PRODUCTION_FIREBASE_PROJECT: arom-production-657f2",
        "PRODUCTION_FIREBASE_PROJECT: something-else",
      ),
    ).toMatch(/PRODUCTION_FIREBASE_PROJECT/);
  });
  it("production-worker environment removed or renamed", () => {
    expect(mutate("environment: production-worker", "")).toMatch(/environment production-worker/);
    expect(mutate("environment: production-worker", "environment: staging")).toMatch(
      /environment production-worker/,
    );
  });
  it("double confirmation removed", () => {
    expect(mutate(/ \|\| \[ "\$INPUT_CONFIRM" != "\$REQUIRED_PHRASE" \]/, "")).toMatch(
      /INPUT_CONFIRM/,
    );
    expect(
      mutate(
        "      confirm_target:\n        description: 'Type \"deploy-arom-production\" again to confirm'\n        required: true\n        type: string\n",
        "",
      ),
    ).toMatch(/inputs must be exactly/);
  });
  it("main-only guard removed", () => {
    expect(mutate(/if \[ "\$GIT_REF" != "refs\/heads\/main" \]; then/, "if false; then")).toMatch(
      /GIT_REF must be checked/,
    );
    expect(mutate("ref: refs/heads/main", "ref: ${{ github.ref }}")).toMatch(
      /checkout ref must be refs\/heads\/main/,
    );
    expect(mutate("git ls-remote origin refs/heads/main", "git rev-parse HEAD")).toMatch(
      /git ls-remote/,
    );
  });
  it("floating npx wrangler / wrangler-action appears", () => {
    expect(mutate("../../node_modules/.bin/wrangler deploy", "npx wrangler deploy")).toMatch(
      /floating wrangler|deploy command must be/,
    );
    expect(
      mutate(
        "- uses: oven-sh/setup-bun@v2",
        "- uses: cloudflare/wrangler-action@v3\n      - uses: oven-sh/setup-bun@v2",
      ),
    ).toMatch(/wrangler-action/);
  });
  it("missing-binary guard removed", () => {
    expect(mutate("[ -x node_modules/.bin/wrangler ]", "true")).toMatch(/local wrangler binary/);
  });
  it("QA identifiers appear", () => {
    for (const id of ["arom-production-qa", "arom-qa", "79545505743"]) {
      expect(
        mutate(
          "PRODUCTION_WORKER_NAME: arom-production\n",
          `PRODUCTION_WORKER_NAME: arom-production\n  EXTRA: ${id}\n`,
        ),
      ).toMatch(/QA identifier/);
    }
  });
  it("an unapproved secret or secret access in preflight appears", () => {
    expect(
      mutate(
        "INPUT_TARGET: ${{ inputs.target }}",
        "INPUT_TARGET: ${{ inputs.target }}\n          X: ${{ secrets.FIREBASE_TOKEN }}",
      ),
    ).toMatch(/unapproved secret/);
  });
  it("permissions widened", () => {
    expect(mutate("permissions:\n  contents: read", "permissions:\n  contents: write")).toMatch(
      /permissions must be contents: read/,
    );
  });
});

describe("pinned Wrangler", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
  };
  it("is an exact devDependency version, not a range", () => {
    expect(pkg.devDependencies.wrangler).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("production artifact guard", () => {
  const goodConfig = {
    name: "arom-production",
    main: "index.mjs",
    assets: { binding: "ASSETS", directory: "../public" },
    compatibility_flags: ["nodejs_compat"],
  };
  const goodFiles = ['const p="arom-production-657f2";'];
  const run = (
    over: Partial<{ config: unknown; files: string[]; env: Record<string, string> }> = {},
  ) =>
    checkProductionArtifact({ config: goodConfig, files: goodFiles, env: {}, ...over }) as string[];

  it("accepts the production build shape", () => {
    expect(run()).toEqual([]);
  });
  it("rejects a different Worker name (including the QA Worker)", () => {
    expect(run({ config: { ...goodConfig, name: "arom-production-qa" } }).join()).toMatch(
      /Worker name/,
    );
  });
  it("rejects a missing ASSETS binding, nodejs_compat, or added routes", () => {
    expect(run({ config: { ...goodConfig, assets: undefined } }).join()).toMatch(/ASSETS/);
    expect(run({ config: { ...goodConfig, compatibility_flags: [] } }).join()).toMatch(
      /nodejs_compat/,
    );
    expect(run({ config: { ...goodConfig, routes: ["x"] } }).join()).toMatch(/routes/);
  });
  it("rejects an artifact that lacks the production Firebase project or embeds QA identifiers", () => {
    expect(run({ files: ["nothing"] }).join()).toMatch(/production Firebase project/);
    for (const id of ["arom-qa", "arom-production-qa", "79545505743"]) {
      expect(run({ files: [...goodFiles, `x ${id} y`] }).join()).toMatch(/QA identifier/);
    }
  });
  it("rejects build-time Firebase overrides", () => {
    expect(run({ env: { VITE_FIREBASE_PROJECT_ID: "x" } }).join()).toMatch(/overrides/);
    expect(run({ env: { VITE_USE_FIREBASE_EMULATOR: "true" } }).join()).toMatch(/overrides/);
  });
  it("fails closed on a missing config", () => {
    expect(run({ config: null }).length).toBeGreaterThan(0);
  });
});
