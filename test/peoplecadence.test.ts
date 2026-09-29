import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildSnapshotUrl,
	formatDepth,
	formatLastContact,
	parseSnapshot,
	type PersonCadenceEntry,
} from "../src/peoplecadence";

/**
 * Pure logic only, per the project's testing convention (see currency.test.ts):
 * requestSnapshot() itself is a network call through Obsidian's requestUrl and
 * isn't exercised here. What's covered is everything this module does without
 * touching the network — parsing the feed's response defensively, building its
 * URL safely, and formatting depth/recency for display.
 */

function entry(overrides: Partial<PersonCadenceEntry> = {}): PersonCadenceEntry {
	return {
		personKey: "People/Persons/Zoe Dang.md",
		displayName: "Zoe Dang",
		depth: 45.5,
		halfLifeDays: 30,
		lastContactAt: "2026-09-24",
		lastMedium: "imessage",
		...overrides,
	};
}

describe("parseSnapshot", () => {
	it("parses a well-formed feed array", () => {
		const raw = [
			{
				person_key: "People/Persons/Zoe Dang.md",
				display_name: "Zoe Dang",
				depth: 45.5,
				half_life_days: 30,
				last_contact_at: "2026-09-24",
				last_medium: "imessage",
			},
		];
		expect(parseSnapshot(raw)).toEqual([entry()]);
	});

	it("returns an empty list for non-array input", () => {
		expect(parseSnapshot(null)).toEqual([]);
		expect(parseSnapshot(undefined)).toEqual([]);
		expect(parseSnapshot({})).toEqual([]);
		expect(parseSnapshot("not an array")).toEqual([]);
	});

	it("drops entries missing a required field", () => {
		const raw = [
			{ display_name: "No key", depth: 1, half_life_days: 30, last_contact_at: "2026-01-01", last_medium: "imessage" },
			{ person_key: "p", depth: 1, half_life_days: 30, last_contact_at: "2026-01-01", last_medium: "imessage" },
		];
		expect(parseSnapshot(raw)).toEqual([]);
	});

	it("drops entries with the wrong field types", () => {
		const raw = [
			{
				person_key: "p",
				display_name: "Name",
				depth: "45.5", // string, not a number
				half_life_days: 30,
				last_contact_at: "2026-01-01",
				last_medium: "imessage",
			},
		];
		expect(parseSnapshot(raw)).toEqual([]);
	});

	it("drops entries with an unrecognized medium", () => {
		const raw = [
			{
				person_key: "p",
				display_name: "Name",
				depth: 1,
				half_life_days: 30,
				last_contact_at: "2026-01-01",
				last_medium: "carrier_pigeon",
			},
		];
		expect(parseSnapshot(raw)).toEqual([]);
	});

	it("keeps the feed's own order (already lowest-depth-first) rather than resorting", () => {
		const raw = [
			{ person_key: "b", display_name: "B", depth: 10, half_life_days: 30, last_contact_at: "2026-01-01", last_medium: "memory" },
			{ person_key: "a", display_name: "A", depth: 5, half_life_days: 30, last_contact_at: "2026-01-01", last_medium: "memory" },
		];
		expect(parseSnapshot(raw).map((p) => p.personKey)).toEqual(["b", "a"]);
	});

	it("drops one malformed entry without discarding the rest of the array", () => {
		const raw = [
			{ person_key: "ok", display_name: "Ok", depth: 1, half_life_days: 30, last_contact_at: "2026-01-01", last_medium: "memory" },
			{ person_key: "bad" }, // missing everything else
		];
		expect(parseSnapshot(raw)).toEqual([
			entry({ personKey: "ok", displayName: "Ok", depth: 1, lastContactAt: "2026-01-01", lastMedium: "memory" }),
		]);
	});
});

describe("buildSnapshotUrl", () => {
	it("appends /snapshot to the configured host", () => {
		expect(buildSnapshotUrl("https://messages-mcp.monitorme.org").toString()).toBe(
			"https://messages-mcp.monitorme.org/snapshot",
		);
	});

	it("strips a trailing slash before appending the path", () => {
		expect(buildSnapshotUrl("https://example.com/").toString()).toBe("https://example.com/snapshot");
	});

	it("rejects a non-https host", () => {
		expect(() => buildSnapshotUrl("http://example.com")).toThrow();
	});

	it("rejects a host carrying credentials, a query, or a fragment", () => {
		expect(() => buildSnapshotUrl("https://user:pass@example.com")).toThrow();
		expect(() => buildSnapshotUrl("https://example.com?x=1")).toThrow();
		expect(() => buildSnapshotUrl("https://example.com#frag")).toThrow();
	});

	it("rejects an unparsable host", () => {
		expect(() => buildSnapshotUrl("not a url")).toThrow();
	});
});

describe("formatDepth", () => {
	it("shows a whole number bare", () => {
		expect(formatDepth(45)).toBe("45");
		expect(formatDepth(0)).toBe("0");
	});

	it("shows a fractional depth to one decimal place", () => {
		expect(formatDepth(45.5)).toBe("45.5");
		expect(formatDepth(10.2)).toBe("10.2");
	});

	it("falls back to 0 for a non-finite depth", () => {
		expect(formatDepth(NaN)).toBe("0");
		expect(formatDepth(Infinity)).toBe("0");
	});
});

describe("formatLastContact", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("combines relative recency with the medium label", () => {
		const text = formatLastContact(entry({ lastContactAt: "2026-09-24", lastMedium: "imessage" }));
		expect(text).toContain("via iMessage");
		expect(text).toContain("ago");
	});

	it("labels a group chat and an in-person memory distinctly", () => {
		expect(formatLastContact(entry({ lastMedium: "imessage_group" }))).toContain("via a group chat");
		expect(formatLastContact(entry({ lastMedium: "memory" }))).toContain("via in person");
	});

	it("falls back to the raw date string when it can't be parsed", () => {
		const text = formatLastContact(entry({ lastContactAt: "not-a-date" }));
		expect(text).toBe("not-a-date via iMessage");
	});
});
