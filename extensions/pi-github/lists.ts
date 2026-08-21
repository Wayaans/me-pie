type RecordValue = Record<string, unknown>;

export type BlockerSummary = {
	number: number;
	title: string;
	state: string;
	url: string;
};

export type IssueIndexItem = {
	number: number;
	title: string;
	state: string;
	url: string;
	updatedAt: string;
	labels: string[];
	assignees: string[];
	blockedBy: BlockerSummary[];
};

function asRecord(value: unknown, label: string): RecordValue {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as RecordValue;
}

function positiveInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`);
	return value as number;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}

function optionalText(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function names(value: unknown, label: string): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((entry, index) => {
		if (typeof entry === "string") return entry;
		const item = asRecord(entry, `${label}[${index}]`);
		const name = item.name ?? item.login;
		return text(name, `${label}[${index}]`);
	});
}

function blockerState(value: RecordValue, label: string): string {
	return text(value.state ?? value.state_name, `${label}.state`).toLowerCase();
}

function blocker(value: unknown, label: string): BlockerSummary | undefined {
	const item = asRecord(value, label);
	const state = blockerState(item, label);
	if (state !== "open") return undefined;
	const number = positiveInteger(item.number, `${label}.number`);
	return {
		number,
		title: text(item.title, `${label}.title`),
		state,
		url: text(item.url ?? item.html_url, `${label}.url`),
	};
}

export function normalizeBlockers(value: unknown, label = "blockedBy"): BlockerSummary[] {
	if (value === undefined || value === null) return [];
	const raw = Array.isArray(value)
		? value
		: asRecord(value, label).nodes;
	if (!Array.isArray(raw)) throw new Error(`${label} must contain an array`);
	return raw.flatMap((entry, index) => {
		const parsed = blocker(entry, `${label}[${index}]`);
		return parsed ? [parsed] : [];
	});
}

export function normalizeIssueIndex(value: unknown, label: string, excludePullRequests = true): IssueIndexItem[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.flatMap((entry, index) => {
		const item = asRecord(entry, `${label}[${index}]`);
		if (excludePullRequests && (item.pull_request !== undefined || item.pullRequest !== undefined)) return [];
		const number = positiveInteger(item.number, `${label}[${index}].number`);
		return [{
			number,
			title: text(item.title, `${label}[${index}].title`),
			state: text(item.state, `${label}[${index}].state`).toLowerCase(),
			url: text(item.url ?? item.html_url, `${label}[${index}].url`),
			updatedAt: text(item.updatedAt ?? item.updated_at, `${label}[${index}].updatedAt`),
			labels: names(item.labels, `${label}[${index}].labels`),
			assignees: names(item.assignees, `${label}[${index}].assignees`),
			blockedBy: normalizeBlockers(item.blockedBy ?? item.blocked_by, `${label}[${index}].blockedBy`),
		}];
	});
}

export function isUnblocked(item: IssueIndexItem): boolean {
	return item.blockedBy.length === 0;
}
