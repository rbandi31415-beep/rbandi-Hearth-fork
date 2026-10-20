import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityTotals,
	buildInteractionsUrl,
	buildSnapshotUrl,
	filterPeople,
	formatDepth,
	formatLastContact,
	type InteractionRow,
	interactionEffectiveScore,
	parseInteractions,
	parseSnapshot,
	type PersonCadenceEntry,
	sortPeople,
	summarizeInteractionsByDay,
	summarizeInteractionsByPersonDay,
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
		depthUpdatedAt: null,
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

	it("picks up depth_updated_at when the feed sends it, without requiring it", () => {
		const raw = [
			{
				person_key: "People/Persons/Zoe Dang.md",
				display_name: "Zoe Dang",
				depth: 45.5,
				half_life_days: 30,
				last_contact_at: "2026-09-24",
				last_medium: "imessage",
				depth_updated_at: "2026-09-29T11:00:00Z",
			},
		];
		expect(parseSnapshot(raw)[0].depthUpdatedAt).toBe("2026-09-29T11:00:00Z");
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

describe("buildInteractionsUrl", () => {
	it("omits the person_key param when none is given (whole-feed request)", () => {
		expect(buildInteractionsUrl("https://example.com").toString()).toBe("https://example.com/interactions");
	});

	it("scopes to one person via the person_key query param", () => {
		expect(buildInteractionsUrl("https://example.com", "People/Persons/Zoe Dang.md").toString()).toBe(
			"https://example.com/interactions?person_key=People%2FPersons%2FZoe+Dang.md",
		);
	});

	it("rejects a non-https host the same way buildSnapshotUrl does", () => {
		expect(() => buildInteractionsUrl("http://example.com")).toThrow();
	});
});

function interaction(overrides: Partial<InteractionRow> = {}): InteractionRow {
	return {
		id: "i1",
		personKey: "People/Persons/Zoe Dang.md",
		displayName: "Zoe Dang",
		medium: "imessage",
		occurredOn: "2026-09-24",
		deterministicScore: 10,
		qualityScore: null,
		status: "pending_quality",
		folded: false,
		initiatedByMe: null,
		messageCount: null,
		createdAt: null,
		...overrides,
	};
}

describe("parseInteractions", () => {
	it("parses a well-formed row, normalizing a null-ish quality score", () => {
		const raw = [
			{
				id: "i1",
				person_key: "People/Persons/Zoe Dang.md",
				display_name: "Zoe Dang",
				medium: "imessage",
				occurred_on: "2026-09-24",
				deterministic_score: 10,
				status: "pending_quality",
			},
		];
		expect(parseInteractions(raw)).toEqual([interaction()]);
	});

	it("picks up initiated_by_me, message_count and created_at when the feed sends them", () => {
		const raw = [
			{
				id: "i1",
				person_key: "p",
				display_name: "Name",
				medium: "imessage",
				occurred_on: "2026-09-24",
				deterministic_score: 10,
				status: "pending_quality",
				initiated_by_me: true,
				message_count: 4,
				created_at: "2026-09-24T18:00:00Z",
			},
		];
		const parsed = parseInteractions(raw)[0];
		expect(parsed.initiatedByMe).toBe(true);
		expect(parsed.messageCount).toBe(4);
		expect(parsed.createdAt).toBe("2026-09-24T18:00:00Z");
	});

	it("doesn't drop a row over a malformed optional field — it just nulls it out", () => {
		const raw = [
			{
				id: "i1",
				person_key: "p",
				display_name: "Name",
				medium: "imessage",
				occurred_on: "2026-09-24",
				deterministic_score: 10,
				status: "pending_quality",
				initiated_by_me: "yes", // not a recognized boolean form
				message_count: "four", // wrong type
			},
		];
		const parsed = parseInteractions(raw);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].initiatedByMe).toBeNull();
		expect(parsed[0].messageCount).toBeNull();
	});

	// Regression: a SQLite-backed API commonly serializes a boolean column as
	// 0/1 (or occasionally "true"/"false") rather than a JSON boolean — the
	// same class of type surprise as the `id`-as-number bug. A strict
	// `typeof === "boolean"` check silently turned every real row's direction
	// into "unknown" until this was widened.
	it.each([
		[true, true],
		[false, false],
		[1, true],
		[0, false],
		["true", true],
		["false", false],
	])("accepts initiated_by_me = %j as %j", (wire, expected) => {
		const raw = [
			{
				id: "i1",
				person_key: "p",
				display_name: "Name",
				medium: "imessage",
				occurred_on: "2026-09-24",
				deterministic_score: 10,
				status: "pending_quality",
				initiated_by_me: wire,
			},
		];
		expect(parseInteractions(raw)[0].initiatedByMe).toBe(expected);
	});

	// Regression: the feed sends `id` as a JSON number (e.g. 59), not a
	// string — a real /interactions response with a numeric id silently
	// dropped every single row until this was normalized instead of rejected.
	it("accepts a numeric id, normalizing it to a string", () => {
		const raw = [
			{
				id: 59,
				person_key: "People/Persons/Ahyaan Sayed.md",
				display_name: "Ahyaan Sayed",
				medium: "memory",
				occurred_on: "2025-04-21",
				deterministic_score: 50,
				quality_score: 50,
				status: "scored",
				folded_at: "2026-09-30T00:26:10.265Z",
			},
		];
		const parsed = parseInteractions(raw);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].id).toBe("59");
	});

	it("keeps a scored row's quality score and folded flag", () => {
		const raw = [
			{
				id: "i1",
				person_key: "p",
				display_name: "Name",
				medium: "memory",
				occurred_on: "2026-09-20",
				deterministic_score: 50,
				quality_score: 82,
				status: "scored",
				folded_at: "2026-09-21T00:00:00Z",
			},
		];
		expect(parseInteractions(raw)).toEqual([
			interaction({
				personKey: "p",
				displayName: "Name",
				medium: "memory",
				occurredOn: "2026-09-20",
				deterministicScore: 50,
				qualityScore: 82,
				status: "scored",
				folded: true,
			}),
		]);
	});

	it("drops a row with an unrecognized status", () => {
		const raw = [
			{
				id: "i1",
				person_key: "p",
				display_name: "Name",
				medium: "imessage",
				occurred_on: "2026-09-20",
				deterministic_score: 10,
				status: "rejected",
			},
		];
		expect(parseInteractions(raw)).toEqual([]);
	});

	it("returns an empty list for non-array input", () => {
		expect(parseInteractions(null)).toEqual([]);
		expect(parseInteractions({})).toEqual([]);
	});
});

describe("interactionEffectiveScore", () => {
	it("uses the deterministic score while pending", () => {
		expect(interactionEffectiveScore(interaction({ deterministicScore: 10, status: "pending_quality" }))).toBe(10);
	});

	it("uses the quality score once scored", () => {
		expect(
			interactionEffectiveScore(
				interaction({ deterministicScore: 10, qualityScore: 82, status: "scored" }),
			),
		).toBe(82);
	});

	it("falls back to the deterministic score if a 'scored' row has no quality score yet", () => {
		expect(
			interactionEffectiveScore(interaction({ deterministicScore: 10, qualityScore: null, status: "scored" })),
		).toBe(10);
	});
});

describe("summarizeInteractionsByDay", () => {
	it("sums same-day, same-medium scores and gives that medium a 100% share", () => {
		const rows = [
			interaction({ medium: "imessage", occurredOn: "2026-09-20", deterministicScore: 10, status: "scored", qualityScore: 10 }),
			interaction({ id: "i2", medium: "imessage", occurredOn: "2026-09-20", deterministicScore: 8, status: "scored", qualityScore: 8 }),
		];
		const summary = summarizeInteractionsByDay(rows);
		expect(summary.get("2026-09-20")).toEqual({
			total: 18,
			shareByMedium: { imessage: 1 },
			pending: false,
			initiator: "unknown",
			totalMessages: 0,
		});
	});

	it("splits share proportionally across mediums present the same day", () => {
		const rows = [
			interaction({ medium: "imessage", occurredOn: "2026-09-20", deterministicScore: 10, status: "scored", qualityScore: 10 }),
			interaction({ id: "i2", medium: "memory", occurredOn: "2026-09-20", deterministicScore: 50, status: "scored", qualityScore: 50 }),
		];
		const summary = summarizeInteractionsByDay(rows)?.get("2026-09-20");
		expect(summary?.total).toBe(60);
		expect(summary?.shareByMedium.imessage).toBeCloseTo(10 / 60);
		expect(summary?.shareByMedium.memory).toBeCloseTo(50 / 60);
	});

	it("marks a day pending when any of its rows haven't been scored yet", () => {
		const rows = [
			interaction({ occurredOn: "2026-09-20", status: "scored", qualityScore: 10, deterministicScore: 10 }),
			interaction({ id: "i2", occurredOn: "2026-09-20", status: "pending_quality", deterministicScore: 3 }),
		];
		expect(summarizeInteractionsByDay(rows).get("2026-09-20")?.pending).toBe(true);
	});

	it("uses the provisional deterministic score for a still-pending row, not zero", () => {
		const rows = [interaction({ occurredOn: "2026-09-20", status: "pending_quality", deterministicScore: 10 })];
		expect(summarizeInteractionsByDay(rows).get("2026-09-20")?.total).toBe(10);
	});

	it("keeps separate days apart", () => {
		const rows = [
			interaction({ occurredOn: "2026-09-20", deterministicScore: 5 }),
			interaction({ id: "i2", occurredOn: "2026-09-21", deterministicScore: 7 }),
		];
		const summary = summarizeInteractionsByDay(rows);
		expect(summary.size).toBe(2);
		expect(summary.get("2026-09-20")?.total).toBe(5);
		expect(summary.get("2026-09-21")?.total).toBe(7);
	});

	it("reports 'me' when every row that day was initiated by me", () => {
		const rows = [
			interaction({ occurredOn: "2026-09-20", initiatedByMe: true }),
			interaction({ id: "i2", occurredOn: "2026-09-20", initiatedByMe: true }),
		];
		expect(summarizeInteractionsByDay(rows).get("2026-09-20")?.initiator).toBe("me");
	});

	it("reports 'them' when every row that day was initiated by them", () => {
		const rows = [interaction({ occurredOn: "2026-09-20", initiatedByMe: false })];
		expect(summarizeInteractionsByDay(rows).get("2026-09-20")?.initiator).toBe("them");
	});

	it("reports 'mixed' when a day has both directions", () => {
		const rows = [
			interaction({ occurredOn: "2026-09-20", initiatedByMe: true }),
			interaction({ id: "i2", occurredOn: "2026-09-20", initiatedByMe: false }),
		];
		expect(summarizeInteractionsByDay(rows).get("2026-09-20")?.initiator).toBe("mixed");
	});

	it("reports 'unknown' when no row that day says who initiated", () => {
		const rows = [interaction({ occurredOn: "2026-09-20", initiatedByMe: null })];
		expect(summarizeInteractionsByDay(rows).get("2026-09-20")?.initiator).toBe("unknown");
	});

	it("sums messageCount across the day's rows, skipping rows with no count", () => {
		const rows = [
			interaction({ occurredOn: "2026-09-20", messageCount: 3 }),
			interaction({ id: "i2", occurredOn: "2026-09-20", messageCount: 2 }),
			interaction({ id: "i3", occurredOn: "2026-09-20", medium: "memory", messageCount: null }),
		];
		expect(summarizeInteractionsByDay(rows).get("2026-09-20")?.totalMessages).toBe(5);
	});
});

describe("summarizeInteractionsByPersonDay", () => {
	it("groups rows by person before bucketing each person's own days", () => {
		const rows = [
			interaction({ personKey: "a", occurredOn: "2026-09-20", deterministicScore: 5 }),
			interaction({ id: "i2", personKey: "b", occurredOn: "2026-09-20", deterministicScore: 9 }),
			interaction({ id: "i3", personKey: "a", occurredOn: "2026-09-21", deterministicScore: 2 }),
		];
		const byPersonDay = summarizeInteractionsByPersonDay(rows);
		expect(byPersonDay.size).toBe(2);
		expect(byPersonDay.get("a")?.get("2026-09-20")?.total).toBe(5);
		expect(byPersonDay.get("a")?.get("2026-09-21")?.total).toBe(2);
		expect(byPersonDay.get("b")?.get("2026-09-20")?.total).toBe(9);
		expect(byPersonDay.get("b")?.has("2026-09-21")).toBe(false);
	});

	it("returns an empty map for no rows", () => {
		expect(summarizeInteractionsByPersonDay([]).size).toBe(0);
	});
});

describe("activityTotals", () => {
	it("sums only the given day keys, ignoring data outside the window", () => {
		const byPersonDay = summarizeInteractionsByPersonDay([
			interaction({ personKey: "a", occurredOn: "2026-09-20", deterministicScore: 5 }),
			interaction({ id: "i2", personKey: "a", occurredOn: "2026-09-21", deterministicScore: 2 }),
			interaction({ id: "i3", personKey: "a", occurredOn: "2026-08-01", deterministicScore: 100 }),
		]);
		const totals = activityTotals(byPersonDay, ["2026-09-20", "2026-09-21"]);
		expect(totals.get("a")).toBe(7);
	});

	it("gives a person with no interactions in the map a total of 0 via the default lookup", () => {
		const totals = activityTotals(new Map(), ["2026-09-20"]);
		expect(totals.get("someone")).toBeUndefined();
	});
});

function person(overrides: Partial<PersonCadenceEntry> = {}): PersonCadenceEntry {
	return entry(overrides);
}

describe("sortPeople", () => {
	const people = [
		person({ personKey: "b", displayName: "Bob", depth: 20 }),
		person({ personKey: "a", displayName: "Alice", depth: 5 }),
		person({ personKey: "c", displayName: "Cara", depth: 40 }),
	];

	it("keeps the feed's own order for 'depth' — no recomputation", () => {
		expect(sortPeople(people, "depth")).toBe(people);
	});

	it("sorts alphabetically by display name for 'name'", () => {
		expect(sortPeople(people, "name").map((p) => p.displayName)).toEqual(["Alice", "Bob", "Cara"]);
	});

	it("sorts by activity total, busiest first, for 'activity'", () => {
		const totals = new Map([
			["a", 3],
			["b", 50],
			["c", 10],
		]);
		expect(sortPeople(people, "activity", totals).map((p) => p.personKey)).toEqual(["b", "c", "a"]);
	});

	it("treats a person missing from the activity map as 0", () => {
		const totals = new Map([["b", 50]]);
		expect(sortPeople(people, "activity", totals).map((p) => p.personKey)).toEqual(["b", "a", "c"]);
	});
});

describe("filterPeople", () => {
	const people = [
		person({ personKey: "a", displayName: "Alice Adams", depth: 5, lastMedium: "imessage", lastContactAt: "2026-09-20" }),
		person({ personKey: "b", displayName: "Bob Barnes", depth: 40, lastMedium: "memory", lastContactAt: "2026-09-01" }),
		person({ personKey: "c", displayName: "Cara", depth: 20, lastMedium: "imessage_group", lastContactAt: "2026-08-01" }),
	];
	const NOW = Date.parse("2026-09-29T00:00:00Z");

	it("matches name search case-insensitively as a substring", () => {
		expect(filterPeople(people, { search: "adams" }, NOW).map((p) => p.personKey)).toEqual(["a"]);
	});

	it("filters by last-contact medium", () => {
		expect(filterPeople(people, { mediums: new Set(["memory"]) }, NOW).map((p) => p.personKey)).toEqual(["b"]);
	});

	it("filters by a depth range", () => {
		expect(filterPeople(people, { minDepth: 10, maxDepth: 30 }, NOW).map((p) => p.personKey)).toEqual(["c"]);
	});

	it("filters by minimum days since last contact", () => {
		// NOW is 2026-09-29: a is 9 days ago, b is 28 days ago, c is 59 days ago.
		expect(filterPeople(people, { minDaysSinceContact: 20 }, NOW).map((p) => p.personKey)).toEqual(["b", "c"]);
	});

	it("combines filters with AND", () => {
		expect(
			filterPeople(people, { mediums: new Set(["imessage", "memory"]), minDepth: 30 }, NOW).map((p) => p.personKey),
		).toEqual(["b"]);
	});

	it("returns everyone when the filter is empty", () => {
		expect(filterPeople(people, {}, NOW)).toHaveLength(3);
	});
});
