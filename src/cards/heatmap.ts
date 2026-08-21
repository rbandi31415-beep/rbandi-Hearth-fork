import { Setting } from "obsidian";
import { activityByDay, createDailyNoteAt, dailyNotesOptions, heatLevel, moment, type Moment } from "../cardbodies";
import { addResetButton } from "../editors";
import { commitsByDay } from "../git";
import { t } from "../i18n";
import { openFile } from "../opener";
import { tasksCompletedByDay } from "../tasknotes";
import { type DashboardCard, type HeatmapMetric } from "../types";
import { makeClickable } from "../ui";
import { type HomeView } from "../view";
import { type CardDefinition, type CardEditorContext } from "./definition";


// ---- Activity heatmap (GitHub-style) ------------------------------------

type Rgb = [number, number, number];

/** Every combinable metric, in a fixed order so the picker and the split-cell
 * stripe order never shuffle around as you toggle things on and off. */
const ALL_HEATMAP_METRICS: HeatmapMetric[] = ["modified", "created", "commits", "tasksCompleted"];

/** The metrics a "combined" card starts with before you touch the checkbox
 * row — matches what was originally asked for (modified/created/commits);
 * tasksCompleted is there but off by default so a vault with no TaskNotes
 * tasks doesn't show an empty stripe. */
const DEFAULT_COMBINED_METRICS: HeatmapMetric[] = ["modified", "created", "commits"];

/** The default hue for a metric that isn't "modified" and has no custom
 * color set — chosen distinct enough from each other to read apart in split
 * or mixed mode. "modified" has no entry here: it resolves from the theme's
 * live accent color instead (see accentRgb), matching the card's original,
 * theme-following look. */
const DEFAULT_METRIC_HUE: Record<Exclude<HeatmapMetric, "modified">, number> = {
	created: 150,
	commits: 265,
	tasksCompleted: 35,
};

/** Standard HSL → sRGB conversion (h in degrees, s/l in percent). */
function hslToRgb(h: number, s: number, l: number): Rgb {
	const sN = s / 100;
	const lN = l / 100;
	const k = (n: number) => (n + h / 30) % 12;
	const a = sN * Math.min(lN, 1 - lN);
	const f = (n: number) => lN - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}

/** The theme's current accent color, read once per render from an element's
 * computed style (falls back to Obsidian's default violet-blue if the
 * custom properties aren't set for some reason). */
function accentRgb(el: HTMLElement): Rgb {
	const style = getComputedStyle(el);
	const h = parseFloat(style.getPropertyValue("--accent-h"));
	const s = parseFloat(style.getPropertyValue("--accent-s"));
	const l = parseFloat(style.getPropertyValue("--accent-l"));
	return hslToRgb(Number.isFinite(h) ? h : 266, Number.isFinite(s) ? s : 84, Number.isFinite(l) ? l : 62);
}

/** "#rrggbb" (or "#rgb") → RGB. Malformed input falls back to mid-grey rather
 * than throwing — a bad hand-edited value shouldn't take the card down. */
function hexToRgb(hex: string): Rgb {
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

/** RGB → "#rrggbb", for seeding a color picker with the current effective
 * color (including the theme-accent default, which has no hex of its own
 * until resolved). */
function rgbToHex([r, g, b]: Rgb): string {
	const c = (n: number) =>
		Math.max(0, Math.min(255, Math.round(n)))
			.toString(16)
			.padStart(2, "0");
	return `#${c(r)}${c(g)}${c(b)}`;
}

function rgba([r, g, b]: Rgb, alpha: number): string {
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The color for a metric in split/mixed combined mode: the card's own
 * override if set, otherwise the theme accent for "modified" or the fixed
 * default hue for anything else. */
function resolveMetricRgb(el: HTMLElement, metric: HeatmapMetric, cfg: NonNullable<DashboardCard["heatmap"]>): Rgb {
	const custom = cfg.metricColors?.[metric];
	if (custom) return hexToRgb(custom);
	if (metric === "modified") return accentRgb(el);
	return hslToRgb(DEFAULT_METRIC_HUE[metric], 70, 55);
}

/** The color for single-metric mode and "blended" combined mode: the card's
 * own override if set, otherwise the theme accent — the card's original,
 * always-theme-following look. */
function resolveBaseRgb(el: HTMLElement, cfg: NonNullable<DashboardCard["heatmap"]>): Rgb {
	return cfg.color ? hexToRgb(cfg.color) : accentRgb(el);
}

/** Short label for a metric, used in tooltips ("Aug 21, 2026: 3 commits"). */
function metricWord(metric: HeatmapMetric): string {
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
 * obsidian-git. Wrapping all four as async keeps the caller (which may need
 * several at once for "combined") to one shape. */
async function metricByDay(view: HomeView, metric: HeatmapMetric): Promise<Map<string, number>> {
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

/** The visible window: `weeks` columns ending on the current (partial) week,
 * aligned to the locale's first day of the week. */
function heatmapWindow(weeks: number): { start: Moment; todayKey: string } {
	const startOfWeek = moment.localeData().firstDayOfWeek();
	const today = moment().startOf("day");
	const todayKey: string = today.format("YYYY-MM-DD");
	let start = today.clone().subtract((weeks - 1) * 7, "days");
	start = start.clone().subtract((start.day() - startOfWeek + 7) % 7, "days");
	return { start, todayKey };
}

/** The highest count on any non-future day in the window — 0 when there's no
 * activity at all. Callers that divide by this (heatLevel, share weighting)
 * need at least 1; callers displaying it (the legend) want the real,
 * possibly-zero number. */
function windowPeak(activity: Map<string, number>, start: Moment, todayKey: string, weeks: number): number {
	let peak = 0;
	for (let i = 0; i < weeks * 7; i++) {
		const key = start.clone().add(i, "days").format("YYYY-MM-DD");
		if (key <= todayKey) peak = Math.max(peak, activity.get(key) ?? 0);
	}
	return peak;
}

/** Wire up "click a day to open/create its daily note" on a cell, shared by
 * every rendering mode below. */
function makeDayClickable(view: HomeView, cellEl: HTMLElement, day: Moment): void {
	const options = dailyNotesOptions(view);
	if (!options) return;
	const activate = () => {
		void createDailyNoteAt(view, day, options).then((f) => {
			if (f) void openFile(view, f, "card");
		});
	};
	cellEl.addEventListener("click", activate);
	makeClickable(cellEl, activate, day.format("MMMM D, YYYY"));
}

/** One metric per cell (the card's original look): a solid square shaded by
 * that day's count relative to the window's peak. Used both for a plain
 * single-metric card and for "combined" in its "blended" style, where
 * `activity` is already the several metrics' counts summed per day. */
function paintSingleGrid(
	view: HomeView,
	grid: HTMLElement,
	weeks: number,
	start: Moment,
	todayKey: string,
	activity: Map<string, number>,
	rgb: Rgb,
	peak: number,
	label: string,
): void {
	const divisor = Math.max(1, peak);
	for (let w = 0; w < weeks; w++) {
		for (let r = 0; r < 7; r++) {
			const day = start.clone().add(w * 7 + r, "days");
			const key: string = day.format("YYYY-MM-DD");
			const cellEl = grid.createDiv("hearth-heatmap-cell");
			if (key > todayKey) {
				cellEl.addClass("is-empty");
				continue;
			}
			const count = activity.get(key) ?? 0;
			if (count > 0) {
				cellEl.style.backgroundColor = rgba(rgb, 0.15 + heatLevel(count, divisor) * 0.2125);
			}
			cellEl.setAttribute("aria-label", t().cards.calendar.dayMetric(day.format("MMM D, YYYY"), count, label));
			cellEl.setAttribute("title", `${day.format("MMM D, YYYY")} · ${count} ${label}`);
			makeDayClickable(view, cellEl, day);
		}
	}
}

/** One stripe per metric inside each day's cell, each shaded against its own
 * metric's peak and drawn in that metric's own color — so a quiet metric
 * (say, a handful of commits a day) isn't washed out by sharing a scale with
 * a busy one (dozens of edits a day), and each stripe reads apart from the
 * others by color, not just position. */
function paintSplitGrid(
	view: HomeView,
	grid: HTMLElement,
	weeks: number,
	start: Moment,
	todayKey: string,
	metrics: HeatmapMetric[],
	series: Map<HeatmapMetric, Map<string, number>>,
	colors: Map<HeatmapMetric, Rgb>,
	peaks: Map<HeatmapMetric, number>,
): void {
	for (let w = 0; w < weeks; w++) {
		for (let r = 0; r < 7; r++) {
			const day = start.clone().add(w * 7 + r, "days");
			const key: string = day.format("YYYY-MM-DD");
			const cellEl = grid.createDiv("hearth-heatmap-cell is-split");
			if (key > todayKey) {
				cellEl.addClass("is-empty");
				continue;
			}
			const parts: string[] = [];
			for (const m of metrics) {
				const count = series.get(m)?.get(key) ?? 0;
				const stripe = cellEl.createDiv("hearth-heatmap-stripe");
				if (count > 0) {
					const divisor = Math.max(1, peaks.get(m) ?? 0);
					const rgb = colors.get(m) ?? [128, 128, 128];
					stripe.style.backgroundColor = rgba(rgb, 0.15 + heatLevel(count, divisor) * 0.2125);
				}
				stripe.setAttribute("title", `${metricWord(m)}: ${count}`);
				parts.push(`${count} ${metricWord(m)}`);
			}
			cellEl.setAttribute("aria-label", `${day.format("MMM D, YYYY")}: ${parts.join(", ")}`);
			makeDayClickable(view, cellEl, day);
		}
	}
}

/**
 * One swatch per day, its color a weighted blend of every included metric's
 * own color — which metric "led" that day is visible at a glance, rather
 * than split into separate stripes. Two things are blended independently:
 * - the *color* is a share-weighted average across metrics (a day led by
 *   commits reads in that metric's color), using each metric's own peak so a
 *   quiet metric can still contribute a visible share;
 * - the *opacity* follows overall activity that day (all metrics' raw counts
 *   summed, shaded against a combined peak) — same alpha ramp as every other
 *   mode, so a quiet day still reads as quiet regardless of color.
 */
function paintMixedGrid(
	view: HomeView,
	grid: HTMLElement,
	weeks: number,
	start: Moment,
	todayKey: string,
	metrics: HeatmapMetric[],
	series: Map<HeatmapMetric, Map<string, number>>,
	colors: Map<HeatmapMetric, Rgb>,
	peaks: Map<HeatmapMetric, number>,
): void {
	const blended = new Map<string, number>();
	for (const m of metrics) {
		for (const [key, count] of series.get(m) ?? []) {
			blended.set(key, (blended.get(key) ?? 0) + count);
		}
	}
	const overallDivisor = Math.max(1, windowPeak(blended, start, todayKey, weeks));

	for (let w = 0; w < weeks; w++) {
		for (let r = 0; r < 7; r++) {
			const day = start.clone().add(w * 7 + r, "days");
			const key: string = day.format("YYYY-MM-DD");
			const cellEl = grid.createDiv("hearth-heatmap-cell");
			if (key > todayKey) {
				cellEl.addClass("is-empty");
				continue;
			}

			const parts: string[] = [];
			let shareTotal = 0;
			let r2 = 0;
			let g2 = 0;
			let b2 = 0;
			for (const m of metrics) {
				const count = series.get(m)?.get(key) ?? 0;
				const share = Math.min(1, count / Math.max(1, peaks.get(m) ?? 0));
				if (share > 0) {
					const [mr, mg, mb] = colors.get(m) ?? [128, 128, 128];
					r2 += mr * share;
					g2 += mg * share;
					b2 += mb * share;
					shareTotal += share;
				}
				parts.push(`${count} ${metricWord(m)}`);
			}

			const total = blended.get(key) ?? 0;
			cellEl.setAttribute("aria-label", `${day.format("MMM D, YYYY")}: ${parts.join(", ")}`);
			cellEl.setAttribute("title", `${day.format("MMM D, YYYY")} · ${parts.join(", ")}`);
			if (shareTotal > 0) {
				const alpha = 0.15 + heatLevel(total, overallDivisor) * 0.2125;
				cellEl.style.backgroundColor = rgba(
					[Math.round(r2 / shareTotal), Math.round(g2 / shareTotal), Math.round(b2 / shareTotal)],
					alpha,
				);
			}
			makeDayClickable(view, cellEl, day);
		}
	}
}

interface LegendEntry {
	rgb: Rgb;
	peak: number;
	/** Named in the swatch's tooltip when there's more than one entry (or the
	 * entry's color doesn't obviously stand for one thing, as in "blended"). */
	label?: string;
}

/** One entry: the peak count above a single saturated swatch in that
 * metric's color. Deliberately not the 5-step gradient the grid itself uses
 * — one glance at "how high does this get" per color, not a bucket-by-bucket
 * breakdown (still available as the swatch's tooltip, along with the 0 low
 * end implied by "peak" — every scale here starts at 0). */
function renderLegendEntry(parent: HTMLElement, entry: LegendEntry): void {
	const el = parent.createDiv("hearth-heatmap-legend-entry");
	el.createDiv({ cls: "hearth-heatmap-legend-number", text: String(entry.peak) });
	const swatch = el.createDiv("hearth-heatmap-legend-swatch");
	swatch.style.backgroundColor = rgba(entry.rgb, 1);
	swatch.setAttribute("title", entry.label ? `${entry.label}: 0–${entry.peak}` : `0–${entry.peak}`);
}

function renderLegend(wrap: HTMLElement, entries: LegendEntry[]): void {
	const group = wrap.createDiv("hearth-heatmap-legend-group");
	for (const entry of entries) renderLegendEntry(group, entry);
}

/** A contribution-style grid: one square (or, in split-cell "combined" mode,
 * one striped square) per day for the last N weeks. */
export function renderHeatmap(view: HomeView, card: DashboardCard, body: HTMLElement): void {
	const cfg = card.heatmap ?? {};
	const metric = cfg.metric ?? "modified";
	const weeks = cfg.weeks && cfg.weeks > 0 ? Math.min(cfg.weeks, 53) : 26;
	const combinedMetrics =
		cfg.combinedMetrics && cfg.combinedMetrics.length > 0 ? cfg.combinedMetrics : DEFAULT_COMBINED_METRICS;
	const metrics = metric === "combined" ? combinedMetrics : [metric];

	void Promise.all(metrics.map((m) => metricByDay(view, m))).then((results) => {
		const series = new Map<HeatmapMetric, Map<string, number>>(metrics.map((m, i) => [m, results[i]]));

		body.empty();
		const wrap = body.createDiv("hearth-heatmap");
		const { start, todayKey } = heatmapWindow(weeks);
		const grid = wrap.createDiv("hearth-heatmap-grid");
		grid.style.gridTemplateColumns = `repeat(${weeks}, 1fr)`;

		if (metric !== "combined") {
			const rgb = resolveBaseRgb(grid, cfg);
			const activity = series.get(metric) ?? new Map<string, number>();
			const peak = windowPeak(activity, start, todayKey, weeks);
			paintSingleGrid(view, grid, weeks, start, todayKey, activity, rgb, peak, metricWord(metric));
			renderLegend(wrap, [{ rgb, peak }]);
			return;
		}

		const combinedStyle = cfg.combinedStyle ?? "split";
		if (combinedStyle === "blended") {
			const rgb = resolveBaseRgb(grid, cfg);
			const blended = new Map<string, number>();
			for (const m of metrics) {
				for (const [key, count] of series.get(m) ?? []) {
					blended.set(key, (blended.get(key) ?? 0) + count);
				}
			}
			const peak = windowPeak(blended, start, todayKey, weeks);
			paintSingleGrid(view, grid, weeks, start, todayKey, blended, rgb, peak, t().cards.heatmap.combinedLabel);
			renderLegend(wrap, [{ rgb, peak, label: t().cards.heatmap.combinedLabel }]);
			return;
		}

		// split or mixed: every metric keeps its own color and its own peak, so
		// the legend below shows one row per metric — "for each color", not one
		// shared scale that would misrepresent several different metrics as one.
		const colors = new Map<HeatmapMetric, Rgb>(metrics.map((m) => [m, resolveMetricRgb(grid, m, cfg)]));
		const peaks = new Map<HeatmapMetric, number>(
			metrics.map((m) => [m, windowPeak(series.get(m) ?? new Map<string, number>(), start, todayKey, weeks)]),
		);
		if (combinedStyle === "split") {
			paintSplitGrid(view, grid, weeks, start, todayKey, metrics, series, colors, peaks);
		} else {
			paintMixedGrid(view, grid, weeks, start, todayKey, metrics, series, colors, peaks);
		}
		renderLegend(
			wrap,
			metrics.map((m) => ({ rgb: colors.get(m) ?? [128, 128, 128], peak: peaks.get(m) ?? 0, label: metricWord(m) })),
		);
	});
}


export function heatmapEditor(ctx: CardEditorContext, containerEl: HTMLElement): void {
	const cfg = (ctx.card.heatmap ??= {});
	new Setting(containerEl)
		.setName(t().editors.heatmap.metric)
		.addDropdown((d) => {
			d.addOption("modified", t().editors.metricOptions.modified);
			d.addOption("created", t().editors.metricOptions.created);
			d.addOption("commits", t().editors.metricOptions.commits);
			d.addOption("tasksCompleted", t().editors.metricOptions.tasksCompleted);
			d.addOption("combined", t().editors.metricOptions.combined);
			d.setValue(cfg.metric ?? "modified").onChange((v) => {
				cfg.metric = v === "modified" ? undefined : (v as NonNullable<typeof cfg.metric>);
				ctx.opts.save();
				ctx.requestRender();
			});
		});

	if (cfg.metric !== "combined") {
		const color = new Setting(containerEl).setName(t().editors.heatmap.color).setDesc(t().editors.heatmap.colorDesc);
		color.addColorPicker((picker) => {
			picker.setValue(cfg.color ?? rgbToHex(accentRgb(containerEl))).onChange((hex) => {
				cfg.color = hex;
				ctx.opts.save();
				ctx.requestRender();
			});
		});
		addResetButton(ctx, color, t().settings.resetField, () => {
			cfg.color = undefined;
		});
	}

	if (cfg.metric === "combined") {
		new Setting(containerEl).setName(t().editors.heatmap.combinedMetrics).setHeading();
		const selected = new Set<HeatmapMetric>(cfg.combinedMetrics ?? DEFAULT_COMBINED_METRICS);
		const row = containerEl.createDiv("hearth-type-filter");
		for (const m of ALL_HEATMAP_METRICS) {
			const chip = row.createDiv("hearth-type-filter-chip");
			chip.toggleClass("is-active", selected.has(m));
			chip.createDiv({ cls: "hearth-type-filter-label", text: metricWord(m) });
			chip.setAttribute("role", "button");
			chip.setAttribute("tabindex", "0");
			chip.setAttribute("aria-pressed", String(selected.has(m)));
			const toggle = () => {
				if (selected.has(m)) selected.delete(m);
				else selected.add(m);
				const on = selected.has(m);
				chip.toggleClass("is-active", on);
				chip.setAttribute("aria-pressed", String(on));
				const ordered = ALL_HEATMAP_METRICS.filter((x) => selected.has(x));
				const isDefault =
					ordered.length === DEFAULT_COMBINED_METRICS.length &&
					ordered.every((x, i) => x === DEFAULT_COMBINED_METRICS[i]);
				cfg.combinedMetrics = isDefault ? undefined : ordered;
				ctx.opts.save();
				ctx.requestRender();
			};
			chip.addEventListener("click", toggle);
			chip.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					toggle();
				}
			});
		}

		new Setting(containerEl)
			.setName(t().editors.heatmap.combinedStyle)
			.setDesc(t().editors.heatmap.combinedStyleDesc)
			.addDropdown((d) => {
				d.addOption("split", t().editors.heatmap.combinedStyleSplit);
				d.addOption("blended", t().editors.heatmap.combinedStyleBlended);
				d.addOption("mixed", t().editors.heatmap.combinedStyleMixed);
				d.setValue(cfg.combinedStyle ?? "split").onChange((v) => {
					cfg.combinedStyle = v === "split" ? undefined : (v as NonNullable<typeof cfg.combinedStyle>);
					ctx.opts.save();
					ctx.requestRender();
				});
			});

		const combinedStyle = cfg.combinedStyle ?? "split";
		if (combinedStyle === "blended") {
			const color = new Setting(containerEl)
				.setName(t().editors.heatmap.color)
				.setDesc(t().editors.heatmap.colorDesc);
			color.addColorPicker((picker) => {
				picker.setValue(cfg.color ?? rgbToHex(accentRgb(containerEl))).onChange((hex) => {
					cfg.color = hex;
					ctx.opts.save();
					ctx.requestRender();
				});
			});
			addResetButton(ctx, color, t().settings.resetField, () => {
				cfg.color = undefined;
			});
		} else {
			new Setting(containerEl).setName(t().editors.heatmap.metricColors).setHeading();
			for (const m of ALL_HEATMAP_METRICS) {
				if (!selected.has(m)) continue;
				const picked = new Setting(containerEl).setName(metricWord(m));
				picked.addColorPicker((picker) => {
					const current = cfg.metricColors?.[m] ?? rgbToHex(resolveMetricRgb(containerEl, m, cfg));
					picker.setValue(current).onChange((hex) => {
						(cfg.metricColors ??= {})[m] = hex;
						ctx.opts.save();
						ctx.requestRender();
					});
				});
				addResetButton(ctx, picked, t().settings.resetField, () => {
					if (cfg.metricColors) delete cfg.metricColors[m];
				});
			}
		}
	}

	const weeks = new Setting(containerEl)
		.setName(t().editors.heatmap.weeks)
		.setDesc(t().editors.heatmap.weeksDesc);
	weeks.addSlider((s) => {
		s.setLimits(1, 53, 1)
			.setValue(cfg.weeks ?? 26)
			.setDynamicTooltip()
			.onChange((v) => {
				cfg.weeks = v === 26 ? undefined : v;
				ctx.opts.save();
			});
	});
	weeks.addExtraButton((b) =>
		b
			.setIcon("rotate-ccw")
			.setTooltip(t().settings.resetSlider)
			.onClick(() => {
				cfg.weeks = undefined;
				ctx.opts.save();
				ctx.requestRender();
			}),
	);
}

/** A calendar-style activity heatmap over one or several vault/git/task
 * metrics. */
export const heatmapCard: CardDefinition<"heatmap"> = {
	kind: "heatmap",
	templates: [
		{ id: "heatmap", name: "Activity heatmap", icon: "activity", build: () => ({ kind: "heatmap", title: "Activity", heatmap: {}, w: 6, h: 3 }) },
	],
	render: (view, card, body) => renderHeatmap(view, card, body),
	renderEditor: (container, ctx) => heatmapEditor(ctx, container),
	cloneConfig: (source, copy) => {
		if (source.heatmap) {
			copy.heatmap = {
				...source.heatmap,
				combinedMetrics: source.heatmap.combinedMetrics ? [...source.heatmap.combinedMetrics] : undefined,
				metricColors: source.heatmap.metricColors ? { ...source.heatmap.metricColors } : undefined,
			};
		}
	},
	liveness: { mode: "vault" },
};
