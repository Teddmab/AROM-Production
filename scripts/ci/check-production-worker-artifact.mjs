// Pre-deploy guard for the PRODUCTION Worker build (.output). Run by
// .github/workflows/deploy-production-worker.yml after `bun run build` and
// before any deploy command. Fails closed: any doubt exits non-zero.
//
// Prints target names and counts only — never file contents, never secrets.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCTION_WORKER_NAME = "arom-production";
export const PRODUCTION_FIREBASE_PROJECT = "arom-production-657f2";

// Identifiers that must never appear in a production artifact. The QA
// Worker/project names, plus the QA Firebase project number.
export const FORBIDDEN_IDENTIFIERS = ["arom-production-qa", "arom-qa", "79545505743"];

const MAX_SCANNED_FILE_BYTES = 20 * 1024 * 1024;

/** Pure check — returns a list of failure messages (empty = safe to deploy). */
export function checkProductionArtifact({ config, files, env = {} }) {
  const failures = [];

  if (!config || typeof config !== "object")
    return ["generated wrangler config is missing or unreadable"];

  if (config.name !== PRODUCTION_WORKER_NAME) {
    failures.push(`generated Worker name is not "${PRODUCTION_WORKER_NAME}"`);
  }
  if (typeof config.main !== "string" || config.main.length === 0) {
    failures.push("generated config has no `main` entrypoint");
  }
  if (
    !config.assets ||
    config.assets.binding !== "ASSETS" ||
    typeof config.assets.directory !== "string"
  ) {
    failures.push(
      "expected production binding ASSETS (static assets) is absent from the generated config",
    );
  }
  if (
    !Array.isArray(config.compatibility_flags) ||
    !config.compatibility_flags.includes("nodejs_compat")
  ) {
    failures.push(
      "expected compatibility flag nodejs_compat is absent (server secrets are read through process.env)",
    );
  }
  if (config.routes || config.route) {
    failures.push(
      "generated config declares routes — production routing must not be changed by CI",
    );
  }

  // A build-time override could silently repoint the Worker's Firebase
  // project; production must build from the source defaults only.
  const overrides = Object.keys(env).filter(
    (k) => k.startsWith("VITE_FIREBASE_") || k === "VITE_USE_FIREBASE_EMULATOR",
  );
  if (overrides.length > 0)
    failures.push(`build-time Firebase overrides are set: ${overrides.join(", ")}`);

  let productionProjectHits = 0;
  const forbiddenHits = new Map();
  for (const text of files) {
    productionProjectHits += text.split(PRODUCTION_FIREBASE_PROJECT).length - 1;
    for (const id of FORBIDDEN_IDENTIFIERS) {
      const n = text.split(id).length - 1;
      if (n > 0) forbiddenHits.set(id, (forbiddenHits.get(id) ?? 0) + n);
    }
  }
  if (productionProjectHits === 0) {
    failures.push(
      `built artifact does not reference the production Firebase project "${PRODUCTION_FIREBASE_PROJECT}"`,
    );
  }
  for (const [id, n] of forbiddenHits)
    failures.push(`QA identifier "${id}" appears ${n} time(s) in the built artifact`);

  return failures;
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else if (entry.isFile() && statSync(p).size <= MAX_SCANNED_FILE_BYTES) out.push(p);
  }
  return out;
}

function main() {
  const outputDir = process.argv[2] ?? ".output";
  const configPath = join(outputDir, "server", "wrangler.json");
  if (!existsSync(configPath)) {
    console.error(`FAIL: ${configPath} not found — build first.`);
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const files = listFiles(outputDir).map((p) => readFileSync(p, "utf8"));
  const failures = checkProductionArtifact({ config, files, env: process.env });

  console.log(`Worker name in generated config : ${config.name}`);
  console.log(`Expected production Worker      : ${PRODUCTION_WORKER_NAME}`);
  console.log(`Expected production Firebase    : ${PRODUCTION_FIREBASE_PROJECT}`);
  console.log(`Files scanned                   : ${files.length}`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL: ${f}`);
    process.exit(1);
  }
  console.log("Production artifact checks passed.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
