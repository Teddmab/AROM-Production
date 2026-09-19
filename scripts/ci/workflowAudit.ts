import { parse } from "yaml";

/**
 * Static audit of GitHub Actions workflows: what may deploy the production
 * Worker, and how. Pure functions over workflow text so the safety rules can
 * be tested — including against deliberately broken variants — without
 * running any workflow. See workflowSafety.test.ts.
 */

export const DEPLOY_WORKFLOW = "deploy-production-worker.yml";
export const APPROVED_DEPLOY_WORKFLOWS = [DEPLOY_WORKFLOW];

// Anything that can publish a Worker or Firebase config.
const DEPLOY_COMMAND =
  /wrangler(?:@[\w.-]+)?\s+(?:deploy|publish|versions\s+deploy|rollback)|nitro\s+deploy|firebase(?:-tools)?\s+deploy|cloudflare\/wrangler-action|wrangler-action/i;
const FLOATING_WRANGLER =
  /\b(?:npx|bunx|pnpx|pnpm dlx|yarn dlx)\s+(?:--\S+\s+)*wrangler|wrangler@(?:latest|next|beta)|npm\s+(?:i|install)\s+(?:-g\s+)?wrangler/i;
const QA_IDENTIFIERS = ["arom-production-qa", "arom-qa", "79545505743"];
const ALLOWED_INPUTS = ["target", "confirm_target"];
const ALLOWED_SECRETS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];

type Workflow = {
  on?: Record<string, unknown> | string | string[];
  env?: Record<string, string>;
  jobs?: Record<string, { environment?: unknown; steps?: { run?: string; uses?: string }[] }>;
  permissions?: Record<string, string> | string;
};

function triggers(w: Workflow): string[] {
  const on = w.on;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on;
  return on ? Object.keys(on) : [];
}

function stripComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

/** True when the workflow text contains a command that could deploy something. */
export function hasDeployCommand(text: string): boolean {
  return DEPLOY_COMMAND.test(stripComments(text));
}

/** Rules for every workflow EXCEPT the approved production deploy workflow. */
export function auditNonDeployWorkflow(name: string, rawText: string): string[] {
  const text = stripComments(rawText);
  const violations: string[] = [];
  if (!APPROVED_DEPLOY_WORKFLOWS.includes(name) && hasDeployCommand(text)) {
    violations.push(`${name}: contains a deploy command but is not an approved deploy workflow`);
  }
  const w = parse(text) as Workflow;
  if (/secrets\.(CLOUDFLARE|FIREBASE|GOOGLE)/i.test(text)) {
    violations.push(`${name}: references production credentials`);
  }
  if (Object.values(w.jobs ?? {}).some((j) => j.environment)) {
    violations.push(`${name}: uses a GitHub Environment (only the deploy workflow may)`);
  }
  return violations;
}

/** Rules for the production deploy workflow. */
export function auditDeployWorkflow(rawText: string): string[] {
  const v: string[] = [];
  // Comments may legitimately name forbidden things ("never npx wrangler");
  // only executable YAML is audited.
  const text = stripComments(rawText);
  const w = parse(text) as Workflow;

  const t = triggers(w);
  if (t.length !== 1 || t[0] !== "workflow_dispatch")
    v.push(`triggers must be exactly [workflow_dispatch], got [${t.join(", ")}]`);
  for (const forbidden of [
    "push",
    "pull_request",
    "pull_request_target",
    "schedule",
    "workflow_run",
    "release",
    "repository_dispatch",
    "workflow_call",
  ]) {
    if (t.includes(forbidden)) v.push(`forbidden trigger: ${forbidden}`);
  }

  const inputs = Object.keys(
    ((w.on as Record<string, { inputs?: object }>)?.workflow_dispatch?.inputs as object) ?? {},
  );
  if (JSON.stringify([...inputs].sort()) !== JSON.stringify([...ALLOWED_INPUTS].sort())) {
    v.push(`inputs must be exactly [${ALLOWED_INPUTS.join(", ")}], got [${inputs.join(", ")}]`);
  }
  const referenced = [...text.matchAll(/inputs\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  for (const r of referenced)
    if (!ALLOWED_INPUTS.includes(r)) v.push(`references unapproved input: ${r}`);

  const env = w.env ?? {};
  if (env.PRODUCTION_WORKER_NAME !== "arom-production")
    v.push("PRODUCTION_WORKER_NAME must be the literal arom-production");
  if (env.PRODUCTION_FIREBASE_PROJECT !== "arom-production-657f2")
    v.push("PRODUCTION_FIREBASE_PROJECT must be the literal arom-production-657f2");
  if (env.REQUIRED_PHRASE !== "deploy-arom-production")
    v.push("REQUIRED_PHRASE must be the literal deploy-arom-production");
  for (const key of ["PRODUCTION_WORKER_NAME", "PRODUCTION_FIREBASE_PROJECT"]) {
    if (/\$\{\{/.test(String(env[key] ?? ""))) v.push(`${key} must not be an expression`);
  }

  const jobs = w.jobs ?? {};
  const deployJob = jobs.deploy;
  if (!deployJob) v.push("missing deploy job");
  if (deployJob?.environment !== "production-worker")
    v.push("deploy job must use environment production-worker");
  for (const [jobName, job] of Object.entries(jobs)) {
    if (jobName !== "deploy" && job.environment)
      v.push(`only the deploy job may use an environment (${jobName})`);
  }

  // Double confirmation + main-only guards must be present and compare both inputs.
  for (const needle of [
    "refs/heads/main",
    "inputs.target",
    "inputs.confirm_target",
    "$REQUIRED_PHRASE",
    "git ls-remote origin refs/heads/main",
  ]) {
    if (!text.includes(needle)) v.push(`guard missing: ${needle}`);
  }
  for (const variable of ["GIT_REF", "INPUT_TARGET", "INPUT_CONFIRM"]) {
    const checks = text.split(`"$${variable}"`).length - 1;
    if (checks < 2) v.push(`${variable} must be checked in both the preflight and the deploy job`);
  }
  const checkoutRefs = [...text.matchAll(/ref:\s*(\S+)/g)].map((m) => m[1]);
  if (checkoutRefs.length === 0 || checkoutRefs.some((r) => r !== "refs/heads/main"))
    v.push("checkout ref must be refs/heads/main");

  if (FLOATING_WRANGLER.test(text))
    v.push("floating wrangler invocation (npx/bunx/@latest) is forbidden");
  if (/wrangler-action/.test(text))
    v.push("cloudflare/wrangler-action is forbidden (installs an unpinned Wrangler)");
  if (
    !text.includes(
      "node_modules/.bin/wrangler deploy --config wrangler.json --name arom-production",
    )
  ) {
    v.push(
      "deploy command must be the pinned local binary with --config wrangler.json --name arom-production",
    );
  }
  const deployLines = text.split("\n").filter((l) => /wrangler\s+deploy/.test(l));
  if (deployLines.length !== 1)
    v.push(`exactly one wrangler deploy command expected, found ${deployLines.length}`);
  if (!text.includes("node_modules/.bin/wrangler ]"))
    v.push("must fail when the local wrangler binary is missing");

  for (const id of QA_IDENTIFIERS) if (text.includes(id)) v.push(`QA identifier present: ${id}`);

  const secrets = [...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  for (const s of secrets)
    if (!ALLOWED_SECRETS.includes(s)) v.push(`unapproved secret referenced: ${s}`);
  const preflightText = JSON.stringify(jobs.preflight ?? {});
  if (/secrets\./.test(preflightText)) v.push("preflight job must not have access to secrets");

  if (typeof w.permissions === "string" || w.permissions?.contents !== "read")
    v.push("permissions must be contents: read");

  return v;
}

/** Rules for the validation-only CI workflow. */
export function auditValidationWorkflow(rawText: string): string[] {
  const text = stripComments(rawText);
  const v = auditNonDeployWorkflow("ci.yml", text);
  const w = parse(text) as Workflow;
  for (const t of triggers(w))
    if (!["push", "pull_request"].includes(t))
      v.push(`unexpected trigger in validation workflow: ${t}`);
  if (typeof w.permissions === "string" || w.permissions?.contents !== "read")
    v.push("validation workflow permissions must be contents: read");
  if (/workflow_dispatch/.test(text)) v.push("validation workflow must not be dispatchable");
  return v;
}
