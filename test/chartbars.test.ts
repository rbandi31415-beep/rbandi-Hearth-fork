import { describe, expect, it } from "vitest";
import {
	annularSectorPath,
	barLayout,
	niceMax,
	polarPoint,
	radialLayout,
	rollUp,
	sortData,
	sparklinePoints,
	type ChartDatum,
} from "../src/chartbars";

/**
 * The chart maths is pure — counts in, geometry out — so it's all covered
 * here. The cases that matter in practice: a long folder list rolled into
 * "Other", a name-sorted chart keeping its order through the roll-up, and the
 * polar paths staying on the unit circle.
 */

const folders: ChartDatum[] = [
	{ label: "Knowledge", value: 120 },
	{ label: "People", value: 40 },
	{ label: "Meta", value: 8 },
	{ label: "Temp", value: 3 },
	{ label: "Attachments", value: 1 },
];

describe("sortData", () => {
	it("orders by descending value, ties by label", () => {
		const tied: ChartDatum[] = [
			{ label: "b", value: 5 },
			{ label: "a", value: 5 },
			{ label: "c", value: 9 },
		];
		expect(sortData(tied, "count").map((d) => d.label)).toEqual(["c", "a", "b"]);
	});

	it("orders by label without touching the input", () => {
		const input = folders.slice();
		const out = sortData(input, "name");
		expect(out.map((d) => d.label)).toEqual(["Attachments", "Knowledge", "Meta", "People", "Temp"]);
		expect(input).toEqual(folders);
	});
});

describe("rollUp", () => {
	it("keeps the largest maxSlices-1 and sums the rest into Other", () => {
		const out = rollUp(folders, 3, "Other");
		expect(out).toEqual([
			{ label: "Knowledge", value: 120, rolledFrom: 1 },
			{ label: "People", value: 40, rolledFrom: 1 },
			{ label: "Other", value: 12, rolledFrom: 3 },
		]);
	});

	it("preserves the input order of the surviving slices", () => {
		const byName = sortData(folders, "name");
		const out = rollUp(byName, 3, "Other");
		// Knowledge (120) and People (40) survive; they stay in name order.
		expect(out.map((d) => d.label)).toEqual(["Knowledge", "People", "Other"]);
	});

	it("returns every item tagged rolledFrom:1 when it already fits", () => {
		const out = rollUp(folders, 10, "Other");
		expect(out).toHaveLength(folders.length);
		expect(out.every((d) => d.rolledFrom === 1)).toBe(true);
	});

	it("treats a non-positive cap as no cap", () => {
		expect(rollUp(folders, 0, "Other")).toHaveLength(folders.length);
	});
});

describe("niceMax", () => {
	it("rounds up to a 1/2/5 x 10^n step", () => {
		expect(niceMax(3)).toBe(3);
		expect(niceMax(7)).toBe(10);
		expect(niceMax(12)).toBe(20);
		expect(niceMax(40)).toBe(50);
		expect(niceMax(120)).toBe(200);
	});

	it("never returns less than 1", () => {
		expect(niceMax(0)).toBe(1);
		expect(niceMax(-4)).toBe(1);
	});
});

describe("barLayout", () => {
	it("scales each value against the nice axis max", () => {
		const rows = barLayout([
			{ label: "a", value: 120 },
			{ label: "b", value: 40 },
		]);
		// niceMax(120) = 200
		expect(rows[0].fraction).toBeCloseTo(0.6);
		expect(rows[1].fraction).toBeCloseTo(0.2);
	});

	it("clamps to [0,1] and handles zero without NaN", () => {
		const rows = barLayout([{ label: "z", value: 0 }], 10);
		expect(rows[0].fraction).toBe(0);
	});
});

describe("sparklinePoints", () => {
	it("spans the full width and flips y so the max is at the top", () => {
		const pts = sparklinePoints([0, 5, 10], 100, 20, 0).split(" ");
		expect(pts[0]).toBe("0.00,20.00"); // min -> bottom
		expect(pts[2]).toBe("100.00,0.00"); // max -> top, last x
	});

	it("returns empty for fewer than two points", () => {
		expect(sparklinePoints([3], 100, 20)).toBe("");
	});

	it("draws a flat series along the middle", () => {
		const pts = sparklinePoints([4, 4, 4], 100, 20, 0).split(" ");
		expect(pts.every((p) => p.endsWith(",10.00"))).toBe(true);
	});
});

describe("polarPoint", () => {
	it("puts 0 degrees straight up and 90 to the right", () => {
		const up = polarPoint(0, 0, 10, 0);
		expect(up.x).toBeCloseTo(0);
		expect(up.y).toBeCloseTo(-10);
		const right = polarPoint(0, 0, 10, 90);
		expect(right.x).toBeCloseTo(10);
		expect(right.y).toBeCloseTo(0);
	});
});

describe("annularSectorPath", () => {
	it("builds a closed path with both arcs", () => {
		const d = annularSectorPath(50, 50, 10, 20, 0, 90);
		expect(d.startsWith("M ")).toBe(true);
		expect(d.endsWith("Z")).toBe(true);
		expect(d.match(/A /g)).toHaveLength(2);
	});

	it("sets the large-arc flag past 180 degrees", () => {
		expect(annularSectorPath(0, 0, 5, 10, 0, 200)).toContain("A 10 10 0 1 1");
		expect(annularSectorPath(0, 0, 5, 10, 0, 90)).toContain("A 10 10 0 0 1");
	});
});

describe("radialLayout", () => {
	const bars = radialLayout(
		[
			{ label: "a", value: 100 },
			{ label: "b", value: 50 },
			{ label: "c", value: 0 },
		],
		{ cx: 100, cy: 100, rInner: 20, track: 60, padAngle: 0 },
	);

	it("splits the full sweep evenly", () => {
		expect(bars.map((b) => [b.startAngle, b.endAngle])).toEqual([
			[0, 120],
			[120, 240],
			[240, 360],
		]);
	});

	it("scales bar length from rInner by value/max", () => {
		// niceMax(100) = 100 -> full-value bar reaches rInner + track.
		expect(bars[0].outerRadius).toBeCloseTo(80);
		expect(bars[1].outerRadius).toBeCloseTo(50);
		expect(bars[2].outerRadius).toBeCloseTo(20);
	});

	it("gives every bar a track path at the max radius", () => {
		for (const bar of bars) expect(bar.trackPath).toContain("80 80");
	});
});
