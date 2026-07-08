// Fixture server for the Plan W page-tap e2e: serves a page that loads
// /app.js, which defines window.compute(n) → n*2. A tap on app.js line 3
// (`return doubled`) with expr `doubled` fires when compute(21) is called.

import * as http from "node:http";

// Keep these line numbers stable — the e2e taps app.js:3.
const APP = `window.compute = function (n) {
  var doubled = n * 2;
  return doubled;
};
`;

const PAGE = `<!doctype html><html><head><title>tap fixture</title></head>
<body style="background:#0a5"><h1>tap</h1><script src="/app.js"></script></body></html>`;

const server = http.createServer((req, res) => {
	if ((req.url || "/").startsWith("/app.js")) {
		res.writeHead(200, { "content-type": "application/javascript" });
		res.end(APP);
		return;
	}
	res.writeHead(200, { "content-type": "text/html" });
	res.end(PAGE);
});

server.listen(0, "127.0.0.1", () => {
	process.stdout.write(`${server.address().port}\n`);
});
