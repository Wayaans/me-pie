import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, Key, matchesKey, type SelectItem, SelectList, truncateToWidth } from "@earendil-works/pi-tui";

export interface WorkerModelOption extends SelectItem {
	readonly searchText: string;
}

interface WorkerModelOptionsInput {
	readonly availableModels: readonly Model<any>[];
	readonly scopedModels: ReadonlyArray<{ readonly model: Model<any> }>;
	readonly currentModel?: Model<any>;
}

function modelReference(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

export function buildWorkerModelOptions(input: WorkerModelOptionsInput): WorkerModelOption[] {
	const scopedReferences = new Set(input.scopedModels.map(({ model }) => modelReference(model)));
	const currentReference = input.currentModel ? modelReference(input.currentModel) : undefined;
	const unique = new Map<string, Model<any>>();
	for (const model of input.availableModels) {
		const reference = modelReference(model);
		if (scopedReferences.size > 0 && !scopedReferences.has(reference)) continue;
		unique.set(reference, model);
	}
	return [...unique.entries()]
		.sort(([left], [right]) => {
			if (left === currentReference) return -1;
			if (right === currentReference) return 1;
			return left.localeCompare(right);
		})
		.map(([reference, model]) => ({
			value: reference,
			label: reference,
			...(model.name && model.name !== model.id ? { description: model.name } : {}),
			searchText: `${reference} ${model.name}`,
		}));
}

export function filterWorkerModelOptions(options: readonly WorkerModelOption[], query: string): WorkerModelOption[] {
	const normalized = query.trim();
	return normalized ? fuzzyFilter([...options], normalized, (option) => option.searchText) : [...options];
}

export async function selectWorkerModel(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const options = buildWorkerModelOptions({
		availableModels: ctx.modelRegistry.getAvailable(),
		scopedModels: ctx.scopedModels,
		...(ctx.model ? { currentModel: ctx.model } : {}),
	});
	if (options.length === 0) throw new Error("No authenticated Worker models are available in the current model scope.");

	const selected = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const input = new Input();
		let list: SelectList;

		const rebuildList = (): void => {
			const filtered = filterWorkerModelOptions(options, input.getValue());
			list = new SelectList(filtered, Math.min(Math.max(filtered.length, 1), 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
		};

		rebuildList();
		input.onSubmit = () => {
			const item = list.getSelectedItem();
			if (item) done(item.value);
		};
		input.onEscape = () => done(undefined);

		return {
			get focused(): boolean { return input.focused; },
			set focused(value: boolean) { input.focused = value; },
			render(width: number): string[] {
				return [
					theme.fg("accent", theme.bold(truncateToWidth("Worker model", width))),
					theme.fg("muted", truncateToWidth("Type to search authenticated provider/model identifiers", width)),
					...input.render(width),
					...list.render(width),
					theme.fg("dim", truncateToWidth("type to filter · ↑↓ navigate · enter select · esc cancel", width)),
				];
			},
			invalidate(): void {
				input.invalidate();
				list.invalidate();
			},
			handleInput(data: string): void {
				if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) list.handleInput(data);
				else {
					const previousQuery = input.getValue();
					input.handleInput(data);
					if (input.getValue() !== previousQuery) rebuildList();
				}
				tui.requestRender();
			},
		};
	});
	return selected;
}
