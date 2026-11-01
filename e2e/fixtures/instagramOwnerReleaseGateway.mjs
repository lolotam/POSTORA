// Bridge loopback-published ports into an internal Docker network. Destinations are fixed.
import { createServer, request } from "node:http";

if (process.env.OWNER_RELEASE_GATEWAY !== "1") throw new Error("Run only in the disposable owner-release gateway container");
for (const [port, hostname, destinationPort] of [
  [9999, "postora-owner-release-auth", 9999],
  [3000, "postora-owner-release-rest", 3000],
]) {
  createServer((incoming, outgoing) => {
    if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//")) {
      outgoing.writeHead(400).end();
      return;
    }
    const forwarded = request({ hostname, port: destinationPort, path: incoming.url, method: incoming.method, headers: incoming.headers }, (response) => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    forwarded.setTimeout(20_000, () => forwarded.destroy(new Error("Fixture gateway timeout")));
    forwarded.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(forwarded);
  }).listen(port, "0.0.0.0");
}
