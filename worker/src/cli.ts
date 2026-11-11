#!/usr/bin/env node
// npx seekmux --server https://seekmux.example.com --token <worker token>
// npx seekmux          (again later: the server and token are remembered)

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { forget, loadSaved, save, savedPath } from "./saved.ts";
import { endpoint, run } from "./worker.ts";

const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const usage = `seekmux ${version} — read pages and search X for a SeekMux gateway in your logged-in Chrome

Usage:
  npx seekmux --server <url> --token <token> [--slots 1]
  npx seekmux                  with the server and token saved before

Options:
  --server   The gateway's address, e.g. https://seekmux.example.com
             (env SEEKMUX_SERVER)
  --token    This worker's token, from its fetcher on the gateway's
             Providers page (env SEEKMUX_WORKER_TOKEN)
  --slots    Pages read at once, 1 or 2 (default 1)
  --forget   Delete the saved server and token, then exit
  --help     Show this help
  --version  Show the version

Once the gateway accepts them, the server and token are saved to
${savedPath()}
(readable by you alone) and used when they are not given.

Chrome needs the OpenCLI extension (Browser Bridge) installed and enabled:
https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk
(without the Chrome Web Store: https://github.com/jackwener/opencli/releases)
`;

/** Whether two addresses as typed reach the same gateway endpoint. */
function sameGateway(a: string, b: string): boolean {
  try {
    return endpoint(a) === endpoint(b);
  } catch {
    return false;
  }
}

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
      forget: { type: "boolean" },
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
  if (values.forget) {
    console.log(forget() ? `deleted ${savedPath()}` : `nothing saved at ${savedPath()}`);
    return;
  }
  const saved = loadSaved();
  const server = values.server ?? process.env.SEEKMUX_SERVER ?? saved?.server;
  // The saved token belongs to the saved gateway: it is never sent to another one.
  const savedToken = saved && server && sameGateway(server, saved.server) ? saved.token : undefined;
  const token = values.token ?? process.env.SEEKMUX_WORKER_TOKEN ?? savedToken;
  if (server && !token && saved) {
    console.error(`the saved token is for ${saved.server}, not ${server}: give this gateway's token with --token`);
    process.exitCode = 2;
    return;
  }
  if (!server || !token) {
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }
  const fromSaved = savedToken !== undefined && token === savedToken;
  const slots = Number(values.slots ?? 1);
  if (!Number.isInteger(slots) || slots < 1 || slots > 2) {
    console.error("--slots must be 1 or 2: the worker drives a single browser");
    process.exitCode = 2;
    return;
  }

  log(`seekmux worker ${version}`);
  if (fromSaved) log(`using the server and token saved in ${savedPath()}`);
  let remembered = fromSaved;
  const onWelcome = () => {
    if (remembered) return;
    remembered = true;
    try {
      save({ server, token });
      log(`saved the server and token to ${savedPath()}; next time run npx seekmux alone`);
    } catch (err) {
      log(`could not save the server and token: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  try {
    await run({ url: endpoint(server), token, slots, version, log, onWelcome });
  } catch (err) {
    if (fromSaved && err instanceof Error && err.message.startsWith("the gateway refused") && err.message.includes("token")) {
      throw new Error(`${err.message}. The saved token is no longer valid: run npx seekmux --token <new token> to replace it`);
    }
    throw err;
  }
}

main().catch((err) => {
  log(`stopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
