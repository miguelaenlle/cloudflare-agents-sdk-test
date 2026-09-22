import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

const output = mkdtempSync(join(tmpdir(), "codex-protocol-"));
const binary = process.env.CODEX_BINARY || process.execPath;
const prefix = process.env.CODEX_BINARY
  ? []
  : [
      new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url)
        .pathname,
    ];
try {
  const version = execFileSync(binary, [...prefix, "--version"], {
    encoding: "utf8",
  }).trim();
  if (version !== "codex-cli 0.155.0")
    throw new Error(`Expected Codex 0.155.0, got ${version}`);
  execFileSync(binary, [
    ...prefix,
    "app-server",
    "generate-ts",
    "--out",
    output,
  ]);
  const files = new Set();
  const definitions = [];
  function visit(file) {
    if (files.has(file)) return;
    files.add(file);
    let source = readFileSync(file, "utf8");
    source = source.replace(/^import type .*? from "(.+?)";\n/gm, (_, path) => {
      visit(resolve(dirname(file), path + ".ts"));
      return "";
    });
    definitions.push(source.replace(/^\/\/.*\n/gm, "").trim());
  }
  for (const name of [
    "InitializeParams",
    "v2/ThreadStartParams",
    "v2/ThreadResumeParams",
    "v2/ThreadReadParams",
    "v2/TurnStartParams",
    "v2/TurnSteerParams",
    "v2/TurnInterruptParams",
    "v2/Thread",
    "v2/Turn",
    "v2/ItemStartedNotification",
    "v2/ItemCompletedNotification",
    "v2/AgentMessageDeltaNotification",
    "v2/TurnStartedNotification",
    "v2/TurnCompletedNotification",
  ]) {
    visit(join(output, name + ".ts"));
  }
  const target = new URL("../protocol.ts", import.meta.url);
  writeFileSync(
    target,
    "// Generated from Codex 0.155.0 (Apache-2.0). Do not edit.\n// Regenerate with pnpm --filter @playground/agent generate:protocol.\n\n" +
      definitions.join("\n\n") +
      "\n",
  );
  execFileSync(process.execPath, [
    new URL("../../../node_modules/prettier/bin/prettier.cjs", import.meta.url)
      .pathname,
    "--write",
    target.pathname,
  ]);
} finally {
  rmSync(output, { recursive: true, force: true });
}
