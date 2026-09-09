import { describe, expect, it } from "vitest";
import {
	bucketByFolder,
	bucketRoots,
	drillCrumbs,
	normalizeFolder,
} from "../src/folderchart";

/**
 * The folder-distribution card's grouping is pure — file paths in, chart
 * slices out — so the drill-down maths is all covered here. The cases that
 * matter: recursive counts, the "files directly here" slice, and a breadcrumb
 * that jumps to any ancestor.
 */

const paths = [
	"Knowledge/Physics/Optics.md",
	"Knowledge/Physics/Thermo.md",
	"Knowledge/Chemistry/Acids.md",
	"Knowledge/index.md",
	"People/Persons/Adhya.md",
	"People/Persons/Chow.md",
	"People/Education/Chow - BSc.md",
	"Inbox.md",
];

describe("normalizeFolder", () => {
	it("strips leading ./ and trailing slashes, treats . and / as root", () => {
		expect(normalizeFolder("./Knowledge/")).toBe("Knowledge");
		expect(normalizeFolder("/")).toBe("");
		expect(normalizeFolder(".")).toBe("");
		expect(normalizeFolder("  People/Persons  ")).toBe("People/Persons");
	});
});

describe("bucketByFolder", () => {
	it("groups the vault root into top folders plus a here-slice", () => {
		expect(bucketByFolder(paths, "", "(here)")).toEqual([
			{ label: "Knowledge", path: "Knowledge", count: 4, hasChildren: true },
			{ label: "People", path: "People", count: 3, hasChildren: true },
			{ label: "(here)", path: null, count: 1, hasChildren: false },
		]);
	});

	it("counts every descendant, and flags folders with subfolders", () => {
		const out = bucketByFolder(paths, "Knowledge", "(here)");
		expect(out).toEqual([
			{ label: "Physics", path: "Knowledge/Physics", count: 2, hasChildren: false },
			{ label: "Chemistry", path: "Knowledge/Chemistry", count: 1, hasChildren: false },
			{ label: "(here)", path: null, count: 1, hasChildren: false },
		]);
	});

	it("returns nothing for a folder with no notes", () => {
		expect(bucketByFolder(paths, "Archive", "(here)")).toEqual([]);
	});
});

describe("bucketRoots", () => {
	it("gives one bucket per root with a full recursive count", () => {
		expect(bucketRoots(paths, ["Knowledge", "People"], "Vault")).toEqual([
			{ label: "Knowledge", path: "Knowledge", count: 4, hasChildren: true },
			{ label: "People", path: "People", count: 3, hasChildren: true },
		]);
	});

	it("drops a root that matches no files", () => {
		expect(bucketRoots(paths, ["People", "Templates"], "Vault").map((b) => b.label)).toEqual(["People"]);
	});
});

describe("drillCrumbs", () => {
	it("is just the home crumb at the initial view", () => {
		expect(drillCrumbs("Vault", "", null)).toEqual([{ label: "Vault", target: null }]);
	});

	it("builds a jump target for every ancestor, relative to a single root", () => {
		expect(drillCrumbs("Knowledge", "Knowledge", "Knowledge/Physics/Optics")).toEqual([
			{ label: "Knowledge", target: null },
			{ label: "Physics", target: "Knowledge/Physics" },
			{ label: "Optics", target: "Knowledge/Physics/Optics" },
		]);
	});

	it("uses absolute segments when the card started from several roots", () => {
		expect(drillCrumbs("All folders", null, "People/Persons")).toEqual([
			{ label: "All folders", target: null },
			{ label: "People", target: "People" },
			{ label: "Persons", target: "People/Persons" },
		]);
	});
});
