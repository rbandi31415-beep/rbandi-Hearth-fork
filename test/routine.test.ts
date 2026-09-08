import { describe, expect, it } from "vitest";
import {
	ROUTINE_DATE_COLUMN,
	addSubtaskColumn,
	completeInstancesFor,
	deriveSessionColumns,
	makeColumnName,
	meetsThreshold,
	parseRoutineCsv,
	parseTick,
	resolveThreshold,
	serializeRoutineCsv,
	sessionSubtasks,
	setTick,
	tickValue,
	tickedCount,
} from "../src/routine";

const HEADER = "date,morning:Weigh in,morning:Plan the day,closing:Recount the day";

describe("parseRoutineCsv", () => {
	it("reads the header and rows, coercing tick tokens", () => {
		const data = parseRoutineCsv(
			`${HEADER}\n2026-09-07,1,0,true\n2026-09-08,x,,0\n`,
		);
		expect(data.columns).toEqual([
			"date",
			"morning:Weigh in",
			"morning:Plan the day",
			"closing:Recount the day",
		]);
		expect(data.rows).toEqual([
			{ date: "2026-09-07", ticks: { "morning:Weigh in": true, "closing:Recount the day": true } },
			{ date: "2026-09-08", ticks: { "morning:Weigh in": true } },
		]);
	});

	it("treats an empty or unrecognised file as an empty log", () => {
		expect(parseRoutineCsv("")).toEqual({ columns: [ROUTINE_DATE_COLUMN], rows: [] });
		expect(parseRoutineCsv("name,foo\nbar,1")).toEqual({ columns: [ROUTINE_DATE_COLUMN], rows: [] });
	});

	it("skips rows without a valid ISO date", () => {
		const data = parseRoutineCsv(`${HEADER}\nnot-a-date,1,1,1\n2026-09-08,1,0,0\n`);
		expect(data.rows.map((r) => r.date)).toEqual(["2026-09-08"]);
	});

	it("handles quoted labels containing commas", () => {
		const data = parseRoutineCsv(`date,"morning:Plan, then review"\n2026-09-08,1\n`);
		expect(data.columns[1]).toBe("morning:Plan, then review");
		expect(data.rows[0].ticks["morning:Plan, then review"]).toBe(true);
	});
});

describe("serializeRoutineCsv", () => {
	it("normalises ticks + row order and is idempotent", () => {
		const text = serializeRoutineCsv(
			parseRoutineCsv(`${HEADER}\n2026-09-08,x,,0\n2026-09-07,1,true,0\n`),
		);
		expect(text).toBe(`${HEADER}\n2026-09-07,1,1,0\n2026-09-08,1,0,0\n`);
		expect(serializeRoutineCsv(parseRoutineCsv(text))).toBe(text);
	});

	it("quotes a column name with a comma", () => {
		const text = serializeRoutineCsv({ columns: ["date", "am:a, b"], rows: [] });
		expect(text).toBe('date,"am:a, b"\n');
	});
});

describe("deriveSessionColumns", () => {
	it("groups columns by session key in first-seen order", () => {
		const groups = deriveSessionColumns([
			"date",
			"morning:Weigh in",
			"closing:Recount",
			"morning:Plan",
			"nope-no-colon",
			":missing key",
			"orphan:",
		]);
		expect(groups).toEqual([
			{
				key: "morning",
				subtasks: [
					{ column: "morning:Weigh in", label: "Weigh in" },
					{ column: "morning:Plan", label: "Plan" },
				],
			},
			{ key: "closing", subtasks: [{ column: "closing:Recount", label: "Recount" }] },
		]);
	});

	it("sessionSubtasks pulls one session out", () => {
		expect(sessionSubtasks(parseRoutineCsv(HEADER).columns, "closing")).toEqual([
			{ column: "closing:Recount the day", label: "Recount the day" },
		]);
	});
});

describe("setTick / addSubtaskColumn", () => {
	it("adds a row for a new day and keeps rows sorted", () => {
		const base = parseRoutineCsv(`${HEADER}\n2026-09-08,1,0,0\n`);
		const next = setTick(base, "2026-09-05", "morning:Weigh in", true);
		expect(next.rows.map((r) => r.date)).toEqual(["2026-09-05", "2026-09-08"]);
		expect(tickValue(next, "2026-09-05", "morning:Weigh in")).toBe(true);
		// original is untouched
		expect(base.rows).toHaveLength(1);
	});

	it("un-ticking drops the key", () => {
		const base = parseRoutineCsv(`${HEADER}\n2026-09-08,1,0,0\n`);
		const next = setTick(base, "2026-09-08", "morning:Weigh in", false);
		expect(next.rows[0].ticks).toEqual({});
	});

	it("addSubtaskColumn is idempotent", () => {
		const base = parseRoutineCsv(HEADER);
		const col = makeColumnName("closing", "Messages");
		const once = addSubtaskColumn(base, col);
		expect(once.columns).toContain("closing:Messages");
		expect(addSubtaskColumn(once, col)).toBe(once);
	});
});

describe("thresholds", () => {
	it("defaults to every subtask", () => {
		const th = resolveThreshold(3, undefined, undefined);
		expect(th).toEqual({ mode: "count", value: 3 });
		expect(meetsThreshold(2, 3, th)).toBe(false);
		expect(meetsThreshold(3, 3, th)).toBe(true);
	});

	it("count mode crosses in both directions", () => {
		const th = resolveThreshold(6, "count", 3);
		expect(meetsThreshold(3, 6, th)).toBe(true);
		expect(meetsThreshold(2, 6, th)).toBe(false);
	});

	it("percent mode", () => {
		const th = resolveThreshold(4, "percent", 50);
		expect(meetsThreshold(2, 4, th)).toBe(true);
		expect(meetsThreshold(1, 4, th)).toBe(false);
	});

	it("a session with no subtasks is never done", () => {
		expect(meetsThreshold(0, 0, resolveThreshold(0, undefined, undefined))).toBe(false);
	});

	it("a count above the subtask total still completes at 'all ticked'", () => {
		const th = resolveThreshold(2, "count", 9);
		expect(meetsThreshold(2, 2, th)).toBe(true);
	});
});

describe("tickedCount", () => {
	it("counts only the session's own subtasks", () => {
		const data = parseRoutineCsv(`${HEADER}\n2026-09-08,1,1,0\n`);
		const morning = sessionSubtasks(data.columns, "morning");
		expect(tickedCount(data, "2026-09-08", morning)).toBe(2);
		expect(tickedCount(data, "2026-09-01", morning)).toBe(0);
	});
});

describe("completeInstancesFor", () => {
	it("adds, de-dupes and sorts", () => {
		expect(
			completeInstancesFor(["2026-09-08", "2026-09-06"], "2026-09-07", true),
		).toEqual(["2026-09-06", "2026-09-07", "2026-09-08"]);
	});

	it("removes and slices datetimes to date-only", () => {
		expect(
			completeInstancesFor(["2026-09-08T06:30", "2026-09-07"], "2026-09-08", false),
		).toEqual(["2026-09-07"]);
	});
});

describe("parseTick", () => {
	it("accepts the documented truthy tokens", () => {
		for (const v of ["1", "true", "YES", "x", " done "]) expect(parseTick(v)).toBe(true);
		for (const v of ["0", "", "false", "no"]) expect(parseTick(v)).toBe(false);
	});
});
