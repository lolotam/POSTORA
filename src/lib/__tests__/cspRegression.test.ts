import fs from "node:fs";
import { expect, it } from "vitest";

it("allows Supabase Realtime, blob workers, and youtube-nocookie frame-src without broad CSP wildcards", () => {
  const nginxConfig = fs.readFileSync("nginx.conf", "utf8");
  const headersConfig = fs.readFileSync("public/_headers", "utf8");

  const nginxCspMatch = nginxConfig.match(
    /^\s*add_header Content-Security-Policy "([^"]+)" always;\s*$/m,
  );
  const headersCspMatch = headersConfig.match(
    /^\s*Content-Security-Policy:\s*(.+?)\s*$/m,
  );

  if (!nginxCspMatch) {
    throw new Error("Content-Security-Policy directive not found in nginx.conf");
  }
  if (!headersCspMatch) {
    throw new Error("Content-Security-Policy header not found in public/_headers");
  }

  const nginxCsp = nginxCspMatch[1];
  const headersCsp = headersCspMatch[1];

  expect(nginxCsp).toBe(headersCsp);

  for (const [source, csp] of [
    ["nginx.conf", nginxCsp],
    ["public/_headers", headersCsp],
  ] as const) {
    const connectSrc = csp.match(/connect-src [^;]+;/)?.[0];
    if (!connectSrc?.includes("wss://api.postora.cloud")) {
      throw new Error(
        `Supabase Realtime WebSocket host missing from connect-src in ${source}: ${JSON.stringify(connectSrc)}`,
      );
    }

    if (!csp.includes("worker-src 'self' blob:;")) {
      throw new Error(
        `Required worker-src segment missing from CSP in ${source}: ${JSON.stringify(csp)}`,
      );
    }

    const frameSrc = csp.match(/frame-src [^;]+;/)?.[0];
    if (frameSrc !== "frame-src 'self' https://www.youtube-nocookie.com;") {
      throw new Error(
        `Expected frame-src 'self' https://www.youtube-nocookie.com; in ${source}, got: ${JSON.stringify(frameSrc)}`,
      );
    }

    const broadWildcard = csp.match(/(?:wss|https):\/\/\*/)?.[0];
    if (broadWildcard) {
      throw new Error(
        `Broad wildcard forbidden in CSP (${source}): ${JSON.stringify(broadWildcard)}`,
      );
    }
  }
});
