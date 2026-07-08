import http from "node:http";

let broken = false;

const server = http.createServer((req, res) => {
	if (req.url === "/break") {
		broken = true;
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("ok");
		return;
	}
	res.writeHead(200, { "content-type": "text/html" });
	res.end(`<!doctype html>
<html>
	<body>
		<div style="height: 900px">top spacer</div>
		<form>
			<input id="name" name="name" />
			${broken ? "" : '<button id="submit" type="button">Go</button>'}
		</form>
		<div style="height: 900px">bottom spacer</div>
	</body>
</html>`);
});

server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	if (address && typeof address === "object") {
		console.log(address.port);
	}
});
