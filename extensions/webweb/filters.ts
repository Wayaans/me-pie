export interface DomainFilters {
	readonly include: ReadonlyArray<string>;
	readonly exclude: ReadonlyArray<string>;
}

/** Both providers accept hostnames, not URLs or query operators. */
export function parseDomainFilters(filters: ReadonlyArray<string> = []): DomainFilters {
	const include = new Set<string>();
	const exclude = new Set<string>();
	for (const filter of filters) {
		const blocked = filter.startsWith("-");
		const domain = (blocked ? filter.slice(1) : filter).toLowerCase();
		if (domain.length > 253 || !domain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
			throw new Error("domainFilter entries must be hostnames only, optionally prefixed with '-'.");
		}
		(blocked ? exclude : include).add(domain);
	}
	if (include.size && exclude.size) {
		throw new Error("Mixed include/exclude domainFilter entries are unsupported. Use only included domains or only excluded domains.");
	}
	if (include.size > 100 || exclude.size > 100) throw new Error("domainFilter supports at most 100 domains.");
	return { include: [...include], exclude: [...exclude] };
}
