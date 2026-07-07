// Fixture HTTP server for recorder integration tests.
// Runs as a separate process (the test blocks its own event loop with
// execFileSync, so an in-process server would deadlock Chrome's page load).
// Listens on an ephemeral port and prints it on stdout.

import * as http from "node:http";

const server = http.createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/html" });
	res.end(
		'<!doctype html><html><head><title>dbg recorder fixture</title></head><body style="background:#0a5"><h1>dbg recorder fixture</h1></body></html>',
	);
});

server.listen(0, "127.0.0.1", () => {
	process.stdout.write(`${server.address().port}\n`);
});
