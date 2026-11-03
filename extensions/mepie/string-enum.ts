import { Type, type TUnsafe } from "typebox";

/**
 * TypeBox string enum emitted as `{ type: "string", enum: [...] }`, which every
 * provider accepts. Pi 1.5's `StringEnum` from `@earendil-works/pi-ai` returns a
 * pi-schema type that TypeBox's `Static` cannot infer, so tool schemas built with
 * TypeBox use this instead.
 */
export function StringEnum<const T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}
