#!/usr/bin/env node
// npx seekmux --server https://seekmux.example.com --token <worker token>

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { endpoint, run } from "./worker.ts";

const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const usage = `seekmux ${version} — read pages and search X for a SeekMux gateway in your logged-in Chrome

Usage:
  npx seekmux --server <url> --token <token> [--slots 1]

Options:
  --server   The gateway's address, e.g. https://seekmux.example.com
             (env SEEKMUX_SERVER)
  --token    This worker's token, from its fetcher on the gateway's
             Providers page (env SEEKMUX_WORKER_TOKEN)
  --slots    Pages read at once, 1 or 2 (default 1)
  --help     Show this help
  --version  Show the version

Chrome needs the OpenCLI extension (Browser Bridge) installed and enabled:
https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk
(without the Chrome Web Store: https://github.com/jackwener/opencli/releases)
`;

function log(line: string) {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  console.log(`${time}  ${line}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      server: { type: "string" },
      token: { type: "string" },
      slots: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) {
    process.stdout.write(usage);
    return;
  }
  if (values.version) {
    console.log(version);
    return;
  }
  const server = values.server ?? process.env.SEEKMUX_SERVER;
  const token = values.token ?? process.env.SEEKMUX_WORKER_TOKEN;
  if (!server || !token) {
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }
  const slots = Number(values.slots ?? 1);
  if (!Number.isInteger(slots) || slots < 1 || slots > 2) {
    console.error("--slots must be 1 or 2: the worker drives a single browser");
    process.exitCode = 2;
    return;
  }

  log(`seekmux worker ${version}`);
  await run({ url: endpoint(server), token, slots, version, log });
}

main().catch((err) => {
  log(`stopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
