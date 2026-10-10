import { request } from "node:http";

export interface RawResponse {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	text: string;
	json: () => any;
}

/**
 * Sends a request without URL normalization (unlike fetch), so tests control the exact path and Host header. Rejects
 * when the server destroys the connection mid-body.
 */
export function raw(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: init.headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("error", reject);
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
			});
		});
		req.on("error", reject);
		if (init.body !== undefined) req.write(init.body);
		req.end();
	});
}
