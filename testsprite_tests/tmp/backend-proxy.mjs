import http from 'node:http';
import https from 'node:https';

const targetOrigin = 'https://api.postora.cloud';
const port = Number.parseInt(process.env.PORT || '55421', 10);

const server = http.createServer((clientReq, clientRes) => {
  const targetUrl = new URL(clientReq.url || '/', targetOrigin);
  const headers = { ...clientReq.headers, host: targetUrl.host };

  const proxyReq = https.request(
    targetUrl,
    { method: clientReq.method, headers },
    (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(clientRes);
    },
  );

  proxyReq.on('error', (error) => {
    clientRes.writeHead(502, { 'content-type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'proxy_error', message: error.message }));
  });

  clientReq.pipe(proxyReq);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Proxy listening on http://localhost:${port} -> ${targetOrigin}`);
});
