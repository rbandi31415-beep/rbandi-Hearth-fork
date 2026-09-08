import { activityByDay, moment, type Moment } from "../cardbodies";
import { commitsByDay } from "../git";
import { t } from "../i18n";
import { tasksCompletedByDay } from "../tasknotes";
import { type HeatmapMetric } from "../types";
import { type HomeView } from "../view";

// ---- Shared activity-metric plumbing ----------------------------------
//
// The heatmap card and the trend (line-graph) card show the same underlying
// numbers — notes edited/created per day, commits per day, tasks completed
// per day — drawn two different ways. Everything they have in common lives
// here: the metric list, the day-bucketers, and the colour resolution.

export type Rgb = [number, number, number];

/** Every combinable metric, in a fixed order so pickers and the heatmap's
 * split-cell stripe order never shuffle around as things are toggled. */
export const ALL_ACTIVITY_METRICS: HeatmapMetric[] = ["modified", "created", "commits", "tasksCompleted"];

/** The default hue for a metric that isn't "modified" and has no custom
 * colour set — chosen distinct enough from each other to read apart when
 * several share a grid. "modified" has no entry here: it resolves from the
 * theme's live accent colour instead (see accentRgb). */
export const DEFAULT_METRIC_HUE: Record<Exclude<HeatmapMetric, "modified">, number> = {
	created: 150,
	commits: 265,
	tasksCompleted: 35,
};

/** Standard HSL → sRGB conversion (h in degrees, s/l in percent). */
export function hslToRgb(h: number, s: number, l: number): Rgb {
	const sN = s / 100;
	const lN = l / 100;
	const k = (n: number) => (n + h / 30) % 12;
	const a = sN * Math.min(lN, 1 - lN);
	const f = (n: number) => lN - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}

/** The theme's current accent colour, read once per render from an element's
 * computed style (falls back to Obsidian's default violet-blue if the custom
 * properties aren't set for some reason). */
export function accentRgb(el: HTMLElement): Rgb {
	const style = getComputedStyle(el);
	const h = parseFloat(style.getPropertyValue("--accent-h"));
	const s = parseFloat(style.getPropertyValue("--accent-s"));
	const l = parseFloat(style.getPropertyValue("--accent-l"));
	return hslToRgb(Number.isFinite(h) ? h : 266, Number.isFinite(s) ? s : 84, Number.isFinite(l) ? l : 62);
}

/** "#rrggbb" (or "#rgb") → RGB. Malformed input falls back to mid-grey rather
 * than throwing — a bad hand-edited value shouldn't take the card down. */
export function hexToRgb(hex: string): Rgb {
	const clean = hex.trim().replace(/^#/, "");
	const full =
		clean.length === 3
			? clean
					.split("")
					.map((c) => c + c)
					.join("")
			: clean;
	const n = parseInt(full, 16);
	if (full.length !== 6 || Number.isNaN(n)) return [128, 128, 128];
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** RGB → "#rrggbb", for seeding a colour picker with the current effective
 * colour (including the theme-accent default, which has no hex of its own
 * until resolved). */
export function rgbToHex([r, g, b]: Rgb): string {
	const c = (n: number) =>
		Math.max(0, Math.min(255, Math.round(n)))
			.toString(16)
			.padStart(2, "0");
	return `#${c(r)}${c(g)}${c(b)}`;
}

export function rgba([r, g, b]: Rgb, alpha: number): string {
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The colour for a metric: the card's own override if set, otherwise the
 * theme accent for "modified" or the fixed default hue for anything else. */
export function resolveMetricRgb(
	el: HTMLElement,
	metric: HeatmapMetric,
	metricColors?: Partial<Record<HeatmapMetric, string>>,
): Rgb {
	const custom = metricColors?.[metric];
	if (custom) return hexToRgb(custom);
	if (metric === "modified") return accentRgb(el);
	return hslToRgb(DEFAULT_METRIC_HUE[metric], 70, 55);
}

/** Short label for a metric, used in tooltips ("Aug 21, 2026: 3 commits"). */
export function metricWord(metric: HeatmapMetric): string {
	switch (metric) {
		case "modified":
			return t().editors.metricOptions.modified;
		case "created":
			return t().editors.metricOptions.created;
		case "commits":
			return t().editors.metricOptions.commits;
		case "tasksCompleted":
			return t().editors.metricOptions.tasksCompleted;
	}
}

/** Day-bucketed counts for one metric. modified/created/tasksCompleted are
 * synchronous under the hood; commits needs an async read through
 * obsidian-git. Wrapping all four as async keeps the caller to one shape. */
export async function metricByDay(view: HomeView, metric: HeatmapMetric): Promise<Map<string, number>> {
	switch (metric) {
		case "modified":
		case "created":
			return activityByDay(view.app, metric);
		case "commits":
			return commitsByDay(view.app);
		case "tasksCompleted":
			return tasksCompletedByDay(view.app);
	}
}

/** The last `days` calendar days, oldest first, ending on today. */
export function dayWindow(days: number): Moment[] {
	const today = moment().startOf("day");
	const out: Moment[] = [];
	for (let i = days - 1; i >= 0; i--) out.push(today.clone().subtract(i, "days"));
	return out;
}
