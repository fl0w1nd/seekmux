// Says why a connection to the gateway could not be opened. The WebSocket
// API reports a failed handshake only as code 1006, so the handshake is
// tried again over plain HTTP to see what answered it.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";

/** Returns why the handshake fails, or undefined when it succeeds now. */
export function diagnose(wsURL: string, timeoutMs = 10_000): Promise<string | undefined> {
  const url = new URL(wsURL);
  url.protocol = url.protocol === "ws:" ? "http:" : "https:";
  const request = url.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise((resolve) => {
    const req = request(url, {
      timeout: timeoutMs,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      },
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(undefined);
    });
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (body.length < 2048) body += chunk;
      });
      res.on("end", () => resolve(explain(url, res.statusCode ?? 0, String(res.headers["content-type"] ?? ""), body)));
      res.on("error", () => resolve(`the gateway answered HTTP ${res.statusCode}`));
    });
    req.on("timeout", () => req.destroy(new Error(`no answer within ${timeoutMs / 1000}s`)));
    req.on("error", (err) => resolve(`could not reach ${url.host}: ${err.message}`));
    req.end();
  });
}

function explain(url: URL, status: number, type: string, body: string): string {
  if (status === 426 && /upgrade/i.test(body)) {
    return `the request reached the gateway without its WebSocket upgrade: the reverse proxy in front of it must pass the Upgrade and Connection headers on ${url.pathname}`;
  }
  if (status === 200 && type.includes("text/html")) {
    return `${url.host} answered ${url.pathname} with a web page: the gateway is older than 0.7.0, or the address is not the gateway's`;
  }
  if (status === 404) return `${url.host} has no ${url.pathname}: the gateway is older than 0.7.0, or the address is not the gateway's`;
  if (status === 502 || status === 503 || status === 504) return `the reverse proxy answered HTTP ${status}: the gateway behind it is not reachable`;
  const said = body.trim().split("\n")[0]?.slice(0, 200);
  return `the gateway answered HTTP ${status}${said ? `: ${said}` : ""}`;
}
