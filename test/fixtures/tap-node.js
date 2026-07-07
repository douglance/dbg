// Plan W node-tap fixture: compute(n)=n*2 on the global; stays alive. Tap line 4.
globalThis.compute = function (n) {
	const doubled = n * 2;
	return doubled;
};
setInterval(() => {}, 3600000);
