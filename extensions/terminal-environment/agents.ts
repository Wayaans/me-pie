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

const MANAGED_FLAGS: Readonly<Record<CodingAgent, readonly string[]>> = {
	pi: ["--model", "--provider", "--thinking"],
	codex: ["--model", "-m", "--cd", "-C", "--config", "-c", "--profile", "-p", "model_reasoning_effort"],
	claude: ["--model", "--effort"],
	opencode: ["--model", "-m", "--variant", "--dir"],
};

function validateText(value: string, field: string, allowNewlines = false): void {
	if (value.includes("\0") || (!allowNewlines && /[\r\n]/.test(value))) {
		throw environmentError("build agent invocation", `${field} contains unsupported control characters.`);
	}
}

function validateExtraArgs(agent: CodingAgent, args: readonly string[]): void {
	for (const argument of args) {
		validateText(argument, "extraArgs entry");
		const managed = MANAGED_FLAGS[agent].find((flag) =>
			argument === flag
			|| argument.startsWith(`${flag}=`)
			|| (flag.startsWith("-") && !flag.startsWith("--") && argument.startsWith(flag)),
		);
		if (managed) throw environmentError("build agent invocation", `extraArgs cannot override managed ${managed} for ${agent}.`);
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
	validateExtraArgs(agent, request.extraArgs ?? []);
	args.push(...(request.extraArgs ?? []));
	if (request.prompt) {
		validateText(request.prompt, "prompt", true);
		if (agent === "opencode") args.push("--prompt", request.prompt);
		else if (agent === "pi") {
			if (request.prompt.startsWith("-") || request.prompt.startsWith("@")) {
				throw environmentError("build agent invocation", "Pi cannot safely accept an initial prompt beginning with '-' or '@'; start Pi first, then use workspace send.");
			}
			args.push(request.prompt);
		} else args.push("--", request.prompt);
	}
	return { agent, executableName: agent, args };
}
