import { Setting } from "obsidian";
import { moment, type Moment } from "../cardbodies";
import { addResetButton } from "../editors";
import { t } from "../i18n";
import { type DashboardCard, type HeatmapMetric, type TrendConfig } from "../types";
import { type HomeView } from "../view";
import { type CardDefinition, type CardEditorContext } from "./definition";
import {
	type Rgb,
	dayWindow,
	hexToRgb,
	makeDayClickable,
	metricByDay,
	metricWord,
	resolveMetricRgb,
	rgba,
	rgbToHex,
} from "./activityMetrics";


// ---- Activity trend (line graph) --------------------------------------
//
// The same numbers the heatmap card shows — one activity metric bucketed by
// time — drawn as a time series instead of a calendar grid: x is time, y is
// the count. One metric per card (the heatmap owns the "several at once"
// case), so the y-axis never has to carry two different scales at once.
//
// Three orthogonal knobs shape it:
//   • grouping  — a point per day, or per week (auto-switches to weeks past a
//     120-day window so a long span doesn't turn into noise);
//   • values    — each period's own count, or a running total that only climbs;
//   • smoothing — an N-day rolling average over a daily per-period line, since
//     raw daily counts are spiky. Smoothing only applies to the daily
//     per-period case: a running total is already smooth, and a weekly sum
//     already is its own average.

/** Beyond this many days the auto grouping switches from day to week. */
const AUTO_WEEK_THRESHOLD = 120;

/** Default rolling-average window (days) when the card hasn't set one. 0 in
 * the config explicitly turns smoothing off. */
const DEFAULT_ROLLING_AVG = 7;

/** viewBox: one x-unit per point, a fixed 0–100 y the scale maps into,
 * stretched to the card with preserveAspectRatio="none". A little head-room
 * at the top keeps the peak's stroke off the edge. */
const VB_HEIGHT = 100;
const VB_TOP_PAD = 8;

/** How many x-axis date labels to print, at most. */
const X_LABELS = 5;

/** The resolved day-count window, clamped the same way in the editor and the
 * renderer. */
function windowDays(cfg: TrendConfig): number {
	return cfg.days && cfg.days > 0 ? Math.min(cfg.days, 365) : 90;
}

/** Day or week, resolving the "auto" (undefined) case from the window size. */
export function effectiveBucket(cfg: TrendConfig): "day" | "week" {
	return cfg.bucket ?? (windowDays(cfg) > AUTO_WEEK_THRESHOLD ? "week" : "day");
}

/** The rolling-average window in days, or 0 when smoothing is off or doesn't
 * apply (running total / weekly grouping). */
function rollingWindow(cfg: TrendConfig): number {
	if (cfg.mode === "cumulative" || effectiveBucket(cfg) === "week") return 0;
	const raw = cfg.rollingAvg ?? DEFAULT_ROLLING_AVG;
	return raw > 1 ? Math.min(raw, 60) : 0;
}

/** The number the y-axis tops out at: `raw` rounded up to a 1/2/5·10ⁿ step so
 * the gridlines land on readable numbers. Always ≥ 1. */
function niceCeil(raw: number): number {
	if (raw <= 5) return Math.max(1, Math.ceil(raw));
	const mag = 10 ** Math.floor(Math.log10(raw));
	const norm = raw / mag;
	const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
	return step * mag;
}

/** Gridline values for a 0..max axis: 0, ¼, ½, ¾, max — whole numbers,
 * de-duplicated (a small max collapses the middle rungs). */
function axisTicks(max: number): number[] {
	const raw = [0, max / 4, max / 2, (max * 3) / 4, max].map((v) => Math.round(v));
	return [...new Set(raw)].sort((a, b) => a - b);
}

/** An N-point trailing average, same length — the window is short at the left
 * edge rather than undefined, so the line starts where the data does. */
function rollingAverage(values: number[], window: number): number[] {
	return values.map((_, i) => {
		const slice = values.slice(Math.max(0, i - window + 1), i + 1);
		return slice.reduce((sum, v) => sum + v, 0) / slice.length;
	});
}

interface Point {
	/** The day the point represents — for a weekly bucket, the week's first
	 * day (used for the label and the daily-note click). */
	day: Moment;
	value: number;
}

/** The first day of `day`'s week, per the active locale. */
function weekStart(day: Moment): Moment {
	const fdow = moment.localeData().firstDayOfWeek();
	return day.clone().subtract((day.day() - fdow + 7) % 7, "days");
}

/** Collapse a daily series into one point per locale week, summing counts.
 * The first and last weeks in view are usually partial — that's expected for
 * this kind of chart. */
function bucketByWeek(points: Point[]): Point[] {
	const groups = new Map<string, number>();
	for (const p of points) {
		const key = weekStart(p.day).format("YYYY-MM-DD");
		groups.set(key, (groups.get(key) ?? 0) + p.value);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([key, value]) => ({ day: moment(key, "YYYY-MM-DD"), value }));
}

/** A running total in place of each period's own count. */
function cumulate(points: Point[]): Point[] {
	let run = 0;
	return points.map((p) => ({ day: p.day, value: (run += p.value) }));
}

/** x for the point at index `i` (centre of its column), in viewBox units. */
function xAt(i: number): number {
	return i + 0.5;
}

/** y for `value` against a 0..max axis — already a 0–100 percentage since the
 * viewBox is 100 tall. */
function yFor(value: number, max: number): number {
	const usable = VB_HEIGHT - VB_TOP_PAD;
	return VB_HEIGHT - VB_TOP_PAD - (value / max) * usable;
}

function pointsList(values: number[], max: number): string {
	return values.map((v, i) => `${xAt(i).toFixed(2)},${yFor(v, max).toFixed(2)}`).join(" ");
}

/** The date label and metric phrase for a point's tooltip / aria-label. */
function describe(point: Point, label: string, weekly: boolean, cumulative: boolean): { date: string; metric: string } {
	const date = weekly
		? t().cards.trend.weekOf(point.day.format("MMM D, YYYY"))
		: point.day.format("MMM D, YYYY");
	const metric = cumulative ? `${label} (${t().cards.trend.runningTotal})` : label;
	return { date, metric };
}

interface ChartOptions {
	showArea: boolean;
	weekly: boolean;
	cumulative: boolean;
}

function paintChart(
	view: HomeView,
	wrap: HTMLElement,
	series: Point[],
	average: number[] | null,
	rgb: Rgb,
	label: string,
	opts: ChartOptions,
): void {
	const values = series.map((p) => p.value);
	const max = niceCeil(Math.max(1, ...values));
	const width = series.length;

	const plot = wrap.createDiv("hearth-trend-plot");

	// y-axis: one number per tick, positioned by the same scale as the grid.
	const yAxis = plot.createDiv("hearth-trend-yaxis");
	for (const tick of axisTicks(max)) {
		const tickEl = yAxis.createDiv({ cls: "hearth-trend-ytick", text: String(tick) });
		tickEl.style.top = `${yFor(tick, max)}%`;
	}

	const svgWrap = plot.createDiv("hearth-trend-svg-wrap");
	const svg = svgWrap.createSvg("svg", {
		cls: "hearth-trend-svg",
		attr: { viewBox: `0 0 ${width} ${VB_HEIGHT}`, preserveAspectRatio: "none" },
	});

	for (const tick of axisTicks(max)) {
		const y = yFor(tick, max);
		svg.createSvg("line", {
			cls: "hearth-trend-gridline",
			attr: { x1: 0, y1: y, x2: width, y2: y, "vector-effect": "non-scaling-stroke" },
		});
	}

	if (series.length >= 2) {
		const line = average ?? values;
		if (opts.showArea) {
			svg.createSvg("polygon", {
				cls: "hearth-trend-area",
				attr: {
					points: `${xAt(0).toFixed(2)},${VB_HEIGHT} ${pointsList(line, max)} ${xAt(width - 1).toFixed(2)},${VB_HEIGHT}`,
					fill: rgba(rgb, 0.14),
				},
			});
		}
		// With smoothing on, the raw series drops to a faint context line and the
		// average is the one that reads.
		if (average) {
			svg.createSvg("polyline", {
				cls: "hearth-trend-rawline",
				attr: { points: pointsList(values, max), stroke: rgba(rgb, 0.35), "vector-effect": "non-scaling-stroke" },
			});
		}
		svg.createSvg("polyline", {
			cls: "hearth-trend-line",
			attr: { points: pointsList(line, max), stroke: rgba(rgb, 1), "vector-effect": "non-scaling-stroke" },
		});
	}

	// Hover layer + click-to-open: marker, crosshair and tooltip are HTML
	// positioned in %, so they stay the right size whatever the viewBox stretch
	// (13 weekly columns vs 90 daily ones) works out to.
	const crosshair = svgWrap.createDiv("hearth-trend-crosshair");
	const marker = svgWrap.createDiv("hearth-trend-marker");
	marker.style.setProperty("--marker-rgb", `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`);
	const tip = svgWrap.createDiv("hearth-trend-tip");
	const hideHover = () => {
		crosshair.removeClass("is-visible");
		marker.removeClass("is-visible");
		tip.removeClass("is-visible");
	};
	hideHover();

	const shownValues = average ?? values;
	series.forEach((point, i) => {
		const hit = svgWrap.createDiv("hearth-trend-hit");
		hit.style.left = `${(i / width) * 100}%`;
		hit.style.width = `${(1 / width) * 100}%`;
		const { date, metric } = describe(point, label, opts.weekly, opts.cumulative);
		hit.setAttribute("aria-label", t().cards.calendar.dayMetric(date, point.value, metric));
		hit.addEventListener("mouseenter", () => {
			const xPct = (xAt(i) / width) * 100;
			crosshair.style.left = `${xPct}%`;
			marker.style.left = `${xPct}%`;
			marker.style.top = `${yFor(shownValues[i], max)}%`;
			tip.setText(`${date} · ${point.value} ${metric}`);
			tip.style.left = `${xPct}%`;
			crosshair.addClass("is-visible");
			marker.addClass("is-visible");
			tip.addClass("is-visible");
		});
		hit.addEventListener("mouseleave", hideHover);
		makeDayClickable(view, hit, point.day);
	});

	// x-axis: a handful of evenly spaced dates, inset to clear the y-axis gutter.
	const xAxis = wrap.createDiv("hearth-trend-xaxis");
	const step = Math.max(1, Math.round((width - 1) / (X_LABELS - 1)));
	for (let i = 0; i < width; i += step) {
		const labelEl = xAxis.createDiv({ cls: "hearth-trend-xtick", text: series[i].day.format("MMM D") });
		labelEl.style.left = `${(xAt(i) / width) * 100}%`;
	}
}

export function renderTrend(view: HomeView, card: DashboardCard, body: HTMLElement): void {
	const cfg = card.trend ?? {};
	const metric: HeatmapMetric = cfg.metric ?? "modified";
	const weekly = effectiveBucket(cfg) === "week";
	const cumulative = cfg.mode === "cumulative";
	const avgWindow = rollingWindow(cfg);
	const showArea = cfg.area !== false;

	void metricByDay(view, metric).then((counts) => {
		body.empty();
		const wrap = body.createDiv("hearth-trend");
		const rgb = cfg.color ? hexToRgb(cfg.color) : resolveMetricRgb(wrap, metric);

		let series: Point[] = dayWindow(windowDays(cfg)).map((day) => ({
			day,
			value: counts.get(day.format("YYYY-MM-DD")) ?? 0,
		}));
		if (weekly) series = bucketByWeek(series);
		if (cumulative) series = cumulate(series);

		const average = avgWindow ? rollingAverage(series.map((p) => p.value), avgWindow) : null;
		paintChart(view, wrap, series, average, rgb, metricWord(metric), { showArea, weekly, cumulative });
	});
}


export function trendEditor(ctx: CardEditorContext, containerEl: HTMLElement): void {
	const cfg = (ctx.card.trend ??= {});

	new Setting(containerEl).setName(t().editors.trend.metric).addDropdown((d) => {
		d.addOption("modified", t().editors.metricOptions.modified);
		d.addOption("created", t().editors.metricOptions.created);
		d.addOption("commits", t().editors.metricOptions.commits);
		d.addOption("tasksCompleted", t().editors.metricOptions.tasksCompleted);
		d.setValue(cfg.metric ?? "modified").onChange((v) => {
			cfg.metric = v === "modified" ? undefined : (v as NonNullable<typeof cfg.metric>);
			ctx.opts.save();
			ctx.requestRender();
		});
	});

	new Setting(containerEl)
		.setName(t().editors.trend.values)
		.setDesc(t().editors.trend.valuesDesc)
		.addDropdown((d) => {
			d.addOption("daily", t().editors.trend.valuesDaily);
			d.addOption("cumulative", t().editors.trend.valuesCumulative);
			d.setValue(cfg.mode ?? "daily").onChange((v) => {
				cfg.mode = v === "cumulative" ? "cumulative" : undefined;
				ctx.opts.save();
				ctx.requestRender();
			});
		});

	new Setting(containerEl)
		.setName(t().editors.trend.group)
		.setDesc(t().editors.trend.groupDesc)
		.addDropdown((d) => {
			d.addOption("auto", t().editors.trend.groupAuto);
			d.addOption("day", t().editors.trend.groupDay);
			d.addOption("week", t().editors.trend.groupWeek);
			d.setValue(cfg.bucket ?? "auto").onChange((v) => {
				cfg.bucket = v === "day" || v === "week" ? v : undefined;
				ctx.opts.save();
				ctx.requestRender();
			});
		});

	const color = new Setting(containerEl).setName(t().editors.trend.color).setDesc(t().editors.trend.colorDesc);
	color.addColorPicker((picker) => {
		picker.setValue(cfg.color ?? rgbToHex(resolveMetricRgb(containerEl, cfg.metric ?? "modified"))).onChange((hex) => {
			cfg.color = hex;
			ctx.opts.save();
			ctx.requestRender();
		});
	});
	addResetButton(ctx, color, t().settings.resetField, () => {
		cfg.color = undefined;
	});

	new Setting(containerEl)
		.setName(t().editors.trend.area)
		.setDesc(t().editors.trend.areaDesc)
		.addToggle((tog) => {
			tog.setValue(cfg.area !== false).onChange((on) => {
				cfg.area = on ? undefined : false;
				ctx.opts.save();
				ctx.requestRender();
			});
		});

	// Smoothing only does something for a daily per-period line; a running total
	// is already smooth and a weekly sum is its own average.
	if (cfg.mode !== "cumulative" && effectiveBucket(cfg) === "day") {
		const avg = new Setting(containerEl)
			.setName(t().editors.trend.rollingAvg)
			.setDesc(t().editors.trend.rollingAvgDesc);
		avg.addSlider((s) => {
			s.setLimits(0, 60, 1)
				.setValue(cfg.rollingAvg ?? DEFAULT_ROLLING_AVG)
				.onChange((v) => {
					cfg.rollingAvg = v === DEFAULT_ROLLING_AVG ? undefined : v;
					ctx.opts.save();
				});
		});
		avg.addExtraButton((b) =>
			b
				.setIcon("rotate-ccw")
				.setTooltip(t().settings.resetSlider)
				.onClick(() => {
					cfg.rollingAvg = undefined;
					ctx.opts.save();
					ctx.requestRender();
				}),
		);
	}

	const days = new Setting(containerEl).setName(t().editors.trend.days).setDesc(t().editors.trend.daysDesc);
	days.addSlider((s) => {
		s.setLimits(14, 365, 1)
			.setValue(cfg.days ?? 90)
			.onChange((v) => {
				cfg.days = v === 90 ? undefined : v;
				ctx.opts.save();
			});
	});
	days.addExtraButton((b) =>
		b
			.setIcon("rotate-ccw")
			.setTooltip(t().settings.resetSlider)
			.onClick(() => {
				cfg.days = undefined;
				ctx.opts.save();
				ctx.requestRender();
			}),
	);
}

/** A line graph of one vault/git/task activity metric over time — the
 * heatmap's numbers, plotted period by period. */
export const trendCard: CardDefinition<"trend"> = {
	kind: "trend",
	templates: [
		{
			id: "trend",
			name: "Activity trend",
			icon: "trending-up",
			build: () => ({ kind: "trend", title: "Activity trend", trend: {}, w: 6, h: 3 }),
		},
	],
	render: (view, card, body) => renderTrend(view, card, body),
	renderEditor: (container, ctx) => trendEditor(ctx, container),
	liveness: { mode: "vault" },
};
