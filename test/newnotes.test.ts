import { describe, expect, it } from "vitest";
import { inScope, summarise, type NewNotesScope, type NoteRecord } from "../src/newnotes";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 30); // a fixed "now"

function note(over: Partial<NoteRecord>): NoteRecord {
	return { path: "n.md", folder: "", ctime: NOW, tags: [], frontmatter: {}, ...over };
}

describe("inScope", () => {
	it("matches a tag and its subtags, with or without #", () => {
		const n = note({ tags: ["project/work"] });
		expect(inScope(n, { kind: "tag", tag: "project" })).toBe(true);
		expect(inScope(n, { kind: "tag", tag: "#project/work" })).toBe(true);
		expect(inScope(n, { kind: "tag", tag: "proj" })).toBe(false);
	});

	it("matches a folder subtree, and everything for an empty folder", () => {
		const n = note({ folder: "People/Persons" });
		expect(inScope(n, { kind: "folder", folder: "People" })).toBe(true);
		expect(inScope(n, { kind: "folder", folder: "People/Persons" })).toBe(true);
		expect(inScope(n, { kind: "folder", folder: "Peo" })).toBe(false);
		expect(inScope(n, { kind: "folder", folder: "" })).toBe(true);
	});

	it("matches a property by presence or by value", () => {
		const n = note({ frontmatter: { type: "person", tags: ["x"] } });
		expect(inScope(n, { kind: "property", key: "type" })).toBe(true);
		expect(inScope(n, { kind: "property", key: "type", value: "PERSON" })).toBe(true);
		expect(inScope(n, { kind: "property", key: "type", value: "place" })).toBe(false);
		expect(inScope(n, { kind: "property", key: "missing" })).toBe(false);
	});

	it("matches a property whose value is a list", () => {
		const n = note({ frontmatter: { association: ["friend", "colleague"] } });
		expect(inScope(n, { kind: "property", key: "association", value: "colleague" })).toBe(true);
	});
});

describe("summarise", () => {
	const scope: NewNotesScope = { kind: "tag", tag: "person" };

	const notes: NoteRecord[] = [
		note({ path: "a.md", tags: ["person"], ctime: NOW - 1 * DAY }),
		note({ path: "b.md", tags: ["person"], ctime: NOW - 3 * DAY }),
		note({ path: "c.md", tags: ["person"], ctime: NOW - 9 * DAY }), // previous window
		note({ path: "d.md", tags: ["person"], ctime: NOW - 40 * DAY }), // older than both
		note({ path: "e.md", tags: ["place"], ctime: NOW - 1 * DAY }), // out of scope
		note({ path: "f.md", tags: ["person"], ctime: NOW + 2 * DAY }), // future, ignored
	];

	it("counts the window, the window before, and the delta", () => {
		const r = summarise(notes, scope, 5, NOW);
		expect(r.count).toBe(2); // a, b
		expect(r.previous).toBe(1); // c
		expect(r.delta).toBe(1);
	});

	it("buckets the window into per-day counts, oldest first", () => {
		const r = summarise(notes, scope, 5, NOW);
		expect(r.series).toHaveLength(5);
		// window starts at now-5d: b (now-3d) -> index 2, a (now-1d) -> index 4
		expect(r.series).toEqual([0, 0, 1, 0, 1]);
	});

	it("returns the in-window notes newest first", () => {
		const r = summarise(notes, scope, 5, NOW);
		expect(r.recent.map((n) => n.path)).toEqual(["a.md", "b.md"]);
	});
});
