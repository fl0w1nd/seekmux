# seekmux

The worker of a [SeekMux](https://github.com/fl0w1nd/seekmux) self-hosted
fetcher. It reads pages for the gateway in a Chrome where you are signed in,
through [OpenCLI](https://github.com/jackwener/opencli): X and Reddit posts
through OpenCLI's site adapters, other pages as they render.

## Use

1. On the gateway's console, open **自托管抓取器** (Self-hosted fetchers),
   create a fetcher or add a worker to one, and copy the worker's token.
2. Install the OpenCLI
   [Browser Bridge extension](https://github.com/jackwener/opencli#2-install-the-browser-bridge-extension)
   in the Chrome profile to read with, and keep that Chrome open.
3. Run the worker (Node.js 22.4 or later):

   ```bash
   npx seekmux --server https://your-gateway --token <worker token>
   ```

The worker connects to the gateway's `/worker` endpoint over a WebSocket and
reconnects when the connection drops, so the machine needs no open port. It
stops when the gateway refuses its token (the token was changed or the worker
removed), or when another worker connects with the same token.

| Option | Environment | |
| --- | --- | --- |
| `--server` | `SEEKMUX_SERVER` | The gateway's address |
| `--token` | `SEEKMUX_WORKER_TOKEN` | The worker's token |
| `--slots` | | Pages read at once, 1 or 2 (default 1) |

OpenCLI is a dependency of this package, so nothing else needs installing.

## License

MIT
