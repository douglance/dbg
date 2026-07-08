// Fixture server for the Plan V e2e (dbg why / networkDiff / stateChanges /
// a11y). Serves a page with a labeled button and a baseline fetch to /api/ok
// (200); /api/error returns 500. The test drives the changes live via `dbg e`
// (strip the button label, set localStorage, fetch /api/error) so `dbg after`'s
// live re-capture reflects them.

import * as http from "node:http";

const PAGE = `<!doctype html><html><head><title>planv fixture</title></head>
<body style="background:#0a5">
<h1>planv</h1>
<button id="btn">Submit</button>
<script>fetch("/api/ok").catch(function () {});</script>
</body></html>`;

const server = http.createServer((req, res) => {
	const url = req.url || "/";
	if (url.startsWith("/api/error")) {
		res.writeHead(500, { "content-type": "application/json" });
		res.end('{"error":"boom"}');
		return;
	}
	if (url.startsWith("/api/")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end('{"ok":true}');
		return;
	}
	res.writeHead(200, { "content-type": "text/html" });
	res.end(PAGE);
});

server.listen(0, "127.0.0.1", () => {
	process.stdout.write(`${server.address().port}\n`);
});
