// Fixture server for the Plan X perf flight-recorder e2e. Serves:
//   /        a small page with visible content (so a prepended block shifts it)
//   /big.js  a ~3MB application/javascript payload (bundle-bytes signal)
// Listens on an ephemeral port and prints it on stdout.

import * as http from "node:http";

const PAGE = `<!doctype html><html><head><title>perf fixture</title></head>
<body style="background:#0a5;margin:0">
<div id="content"><h1>perf fixture</h1><p>baseline content that will be shifted</p></div>
</body></html>`;

// ~3MB comment string + a tiny assignment, so encodedDataLength is large.
const BIG_JS = `/*${"x".repeat(3_000_000)}*/\nwindow.__big=1;\n`;

const server = http.createServer((req, res) => {
	if ((req.url || "/").startsWith("/big.js")) {
		res.writeHead(200, { "content-type": "application/javascript" });
		res.end(BIG_JS);
		return;
	}
	res.writeHead(200, { "content-type": "text/html" });
	res.end(PAGE);
});

server.listen(0, "127.0.0.1", () => {
	process.stdout.write(`${server.address().port}\n`);
});
