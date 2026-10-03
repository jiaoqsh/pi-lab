// A dependency-free MCP server over stdio (newline-delimited JSON-RPC 2.0) simulating a shop backend.
// list_orders returns 3000 orders: far too much for a model's context, cheap to filter in a codemode script.
// Ground truth: 600 refunded orders totaling $152,100; C16 and C36 tie for the largest refunded total ($19,575).
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

interface JsonRpcRequest {
	id?: number | string;
	method: string;
	params?: { name?: string; arguments?: { id?: string }; protocolVersion?: string };
}

const LOG = process.env.SHOP_MCP_LOG;
const log = (line: string) => {
	if (LOG) appendFileSync(LOG, `${line}\n`);
};

const customers = Array.from({ length: 40 }, (_, i) => ({ id: `C${i}`, name: `Customer ${i}`, tier: i % 3 ? "basic" : "gold" }));
const statuses = ["paid", "paid", "paid", "shipped", "refunded"];
const orders = Array.from({ length: 3000 }, (_, i) => ({
	id: `O${i}`,
	customerId: `C${(i * 7) % 40}`,
	status: statuses[(i * 13) % 5],
	amount: ((i * 37) % 500) + 5,
}));

const tools = [
	{
		name: "list_orders",
		description: "List all orders of the shop with id, customerId, status (paid|shipped|refunded), and amount in USD.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "get_customer",
		description: "Look up one customer by id.",
		inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
	},
];

function call(name: string | undefined, args: { id?: string } | undefined) {
	if (name === "list_orders") {
		return { content: [{ type: "text", text: JSON.stringify({ orders }) }], structuredContent: { orders } };
	}
	if (name === "get_customer") {
		const customer = customers.find((c) => c.id === args?.id);
		if (!customer) return { content: [{ type: "text", text: `No customer ${args?.id}` }], isError: true };
		return { content: [{ type: "text", text: JSON.stringify(customer) }] };
	}
	return { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
}

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line) as JsonRpcRequest;
	log(`${message.method}${message.params?.name ? ` ${message.params.name}` : ""}`);
	if (message.id === undefined) return; // notifications
	const reply = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result });
	switch (message.method) {
		case "initialize":
			return reply({
				protocolVersion: message.params?.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "shop", version: "0.1.0" },
				instructions: "Shop backend: orders and customers.",
			});
		case "tools/list":
			return reply({ tools });
		case "tools/call":
			return reply(call(message.params?.name, message.params?.arguments));
		case "ping":
			return reply({});
		default:
			return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } });
	}
});
