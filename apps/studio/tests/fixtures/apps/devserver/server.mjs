// A dev server like any other: it picks a free port and says where it listens.
import http from 'node:http';

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Harbor Dashboard</title></head>
<body style="font:16px system-ui;padding:32px"><h1>Harbor Dashboard</h1><button data-testid="refresh">Refresh</button></body></html>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' });
  res.end(page);
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  setTimeout(() => console.log(`\n  Harbor dev server ready\n\n  ➜  Local:   http://localhost:${port}/\n`), 300);
});
