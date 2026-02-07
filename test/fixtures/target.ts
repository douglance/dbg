// Test fixture: a simple program that exercises various debugger features

interface Config {
	port: number;
	debug: boolean;
	nested: { deep: string };
}

const config: Config = {
	port: 3000,
	debug: true,
	nested: { deep: "value" },
};

function add(a: number, b: number): number {
	const result = a + b;
	return result;
}

async function fetchData(url: string): Promise<string> {
	return `data from ${url}`;
}

function throwError(): never {
	throw new Error("test error");
}

class Cart {
	items: Array<{ id: string; qty: number }> = [];

	addItem(id: string, qty: number): void {
		if (qty <= 0) return;
		this.items.push({ id, qty });
	}

	total(): number {
		return this.items.reduce((sum, item) => sum + item.qty, 0);
	}
}

// Main execution
const cart = new Cart();
cart.addItem("abc-123", 2);
cart.addItem("def-456", 0); // intentional: qty=0, won't add
cart.addItem("ghi-789", 3);

const sum = add(10, 20);
console.log("sum:", sum);
console.log("cart total:", cart.total());
console.log("config:", config);

async function main() {
	const data = await fetchData("http://example.com");
	console.log("fetched:", data);

	try {
		throwError();
	} catch (e) {
		console.error("caught:", (e as Error).message);
	}
}

main().then(() => {
	console.log("done");
});
