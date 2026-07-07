// Static fixture server: serves index.html + files from the directory given
// as argv[2]. Runs as a separate process (recorder tests block their own
// event loop with execFileSync). Prints the ephemeral port on stdout.

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

const root = process.argv[2];
const TYPES = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
};

const server = http.createServer((req, res) => {
	const name = req.url === "/" ? "/index.html" : (req.url ?? "/index.html");
	const filePath = path.join(root, name.split("?")[0]);
	try {
		const body = fs.readFileSync(filePath);
		res.writeHead(200, {
			"content-type": TYPES[path.extname(filePath)] ?? "application/octet-stream",
		});
		res.end(body);
	} catch {
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("not found");
	}
});

server.listen(0, "127.0.0.1", () => {
	process.stdout.write(`${server.address().port}\n`);
});
