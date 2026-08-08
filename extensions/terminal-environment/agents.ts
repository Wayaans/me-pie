import { environmentError } from "./errors.ts";
import type { CodingAgent, RunRequest, ThinkingLevel } from "./model.ts";

export interface AgentInvocation {
	readonly agent: CodingAgent;
	readonly executableName: CodingAgent;
	readonly args: readonly string[];
}

const THINKING_SUPPORT: Readonly<Record<CodingAgent, readonly ThinkingLevel[]>> = {
	pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
	codex: ["minimal", "low", "medium", "high", "xhigh", "max"],
	claude: ["low", "medium", "high", "xhigh", "max"],
	opencode: ["minimal", "low", "medium", "high", "xhigh", "max"],
};

function validateText(value: string, field: string): void {
	if (value.includes("\0") || /[\r\n]/.test(value)) {
		throw environmentError("build agent invocation", `${field} contains unsupported control characters.`);
	}
}

function appendModel(args: string[], request: RunRequest): void {
	if (!request.model) return;
	validateText(request.model, "model");
	args.push("--model", request.model);
}

function appendThinking(agent: CodingAgent, args: string[], thinking: ThinkingLevel | undefined): void {
	if (!thinking) return;
	if (!THINKING_SUPPORT[agent].includes(thinking)) {
		throw environmentError("build agent invocation", `${agent} does not support thinking=${thinking}.`);
	}
	switch (agent) {
		case "pi": args.push("--thinking", thinking); break;
		case "codex": args.push("-c", `model_reasoning_effort=${JSON.stringify(thinking)}`); break;
		case "claude": args.push("--effort", thinking); break;
		case "opencode": args.push("--variant", thinking); break;
	}
}

export function buildAgentInvocation(request: RunRequest): AgentInvocation {
	const agent = request.agent ?? "pi";
	const args: string[] = [];
	appendModel(args, request);
	appendThinking(agent, args, request.thinking);
	return { agent, executableName: agent, args };
}
