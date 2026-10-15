#!/usr/bin/env node
// Point brain at this repo's memory and put the job files in front on session start.
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "start";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mem = join(repo, "brain");
process.env.BRAIN_MEMORY_DIR = mem;

let stdin = "";
try {
  stdin = readFileSync(0, "utf8");
} catch {}

function dump(rel) {
  try {
    process.stdout.write(`\n\n----- ${rel} -----\n`);
    process.stdout.write(readFileSync(join(repo, rel), "utf8"));
  } catch {}
}

if (mode === "start") {
  dump("RULES.md");
  dump("SELLING.md");
  dump("FACTS.md");
  dump("LEARNED.md");
  dump("scratch/README.md");
  process.stdout.write("\n");
}

const candidates = [
  process.env.CLAUDE_PLUGIN_ROOT && join(process.env.CLAUDE_PLUGIN_ROOT, "hooks/cue.mjs"),
  join(homedir(), ".claude/skills/brain/hooks/cue.mjs"),
].filter(Boolean);
const cue = candidates.find((p) => existsSync(p));
if (cue) {
  const r = spawnSync(process.execPath, [cue, mode], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, BRAIN_MEMORY_DIR: mem },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (r.stdout) process.stdout.write(r.stdout);
}
process.exit(0);
