import { parentPort, workerData } from "node:worker_threads";

interface MatchJob {
	pattern: string;
	flags?: string;
	text: string;
}

const job = workerData as MatchJob;
parentPort?.postMessage(new RegExp(job.pattern, job.flags).test(job.text));
