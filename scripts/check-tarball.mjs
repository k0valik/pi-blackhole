#!/usr/bin/env node
// Read the JSON report from `npm pack --dry-run --json` on the CI runner.
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(0, "utf8"));
const tarball = Array.isArray(report) ? report[0] : report;
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const paths = tarball.files.map((file) => file.path);
const problems = [];

console.log(`${tarball.files.length} files in publish tarball:`);
for (const file of tarball.files) console.log(`  ${file.path}`);

for (const path of paths) {
  if (
    /(^|\/)(node_modules|\.git|__pycache__|\.venv)(\/|$)/.test(path) ||
    /(^|\/)\.env(?:\.|$)/.test(path)
  ) {
    problems.push(`unexpected file: ${path}`);
  }
}

for (const entry of manifest.pi?.extensions ?? []) {
  const path = entry.replace(/^\.\//, "").replace(/\/$/, "");
  if (!paths.some((file) => file === path || file.startsWith(`${path}/`))) {
    problems.push(`missing pi extension: ${entry}`);
  }
}

for (const name of ["preinstall", "install", "postinstall"]) {
  const script = manifest.scripts?.[name];
  const match = script?.match(/^node\s+((?:\.\/)?scripts\/[^\s]+)\s*$/);
  if (match && !paths.includes(match[1].replace(/^\.\//, ""))) {
    problems.push(`missing ${name} script: ${match[1]}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
} else {
  console.log("Tarball contents OK");
}
