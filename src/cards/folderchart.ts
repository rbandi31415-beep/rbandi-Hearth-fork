import { Setting, TFile } from "obsidian";
import {
	type ChartDatum,
	type RolledDatum,
	barLayout,
	pieLayout,
	polarPoint,
	radialLayout,
	rollUp,
	sortData,
	sunburstLayout,
} from "../chartbars";
import { emptyState } from "../cardbodies";
import { addNumberField, addResetButton, folderListEditor } from "../editors";
import {
	type FolderBucket,
	type NestedBucket,
	bucketByFolder,
	bucketRoots,
	drillCrumbs,
	nestedBuckets,
	normalizeFolder,
} from "../folderchart";
import { t } from "../i18n";
import { type DashboardCard } from "../types";
import { type HomeView } from "../view";
import { type CardDefinition, type CardEditorContext } from "./definition";
import {
	type Rgb,
	accentRgb,
	categoricalHues,
	hexToRgb,
	hslToRgb,
	rgba,
	rgbToHex,
} from "./activityMetrics";


// ---- Folder distribution chart --------------------------------------------
//
// Vault notes grouped by folder, drawn four ways: radial bars, horizontal
// bars, a flat pie, or a two-ring sunburst (top folders inside, their
// subfolders outside). Each slice is one immediate child folder of whatever
// folder is in view, counting every note beneath it; clicking a slice with
// subfolders drills in, with a breadcrumb back out. Pointed at several roots
// at once, the top level shows one slice per root.
//
// The bar and pie views colour by magnitude — one hue (theme accent or a
// per-card override), shaded by each slice's share — so they need no palette
// validation. The sunburst is the exception: it needs categorical hues to
// tell top folders apart, so it spaces `categoricalHues` around the wheel
// from the accent and shades each folder's subfolders within that hue,
// folding anything past SUNBURST_COLOR_CAP into a neutral "Other".

const DEFAULT_MAX_SLICES = 12;

/** Per-card drill position: the folder path currently in view, or absent for
 * the card's initial view. Kept out of the card config on purpose — drilling
 * is a viewing gesture, not a saved setting — but held here so a live redraw
 * (any vault change) doesn't bounce the user back to the root. */
const drillState = new Map<string, string>();

interface SliceMeta {
	path: string | null;
	hasChildren: boolean;
}

/** Fill opacity for a bar at `fraction` of the axis max: a floor so the
 * smallest slice is still visible, ramping to near-solid at the peak. */
function fillAlpha(fraction: number): number {
	return 0.32 + Math.max(0, Math.min(1, fraction)) * 0.5;
}

export function renderFolderChart(view: HomeView, card: DashboardCard, body: HTMLElement): void {
	const cfg = card.folderChart ?? {};
	const roots = (cfg.roots ?? []).map(normalizeFolder);
	const style = cfg.style ?? "radial";
	const sort = cfg.sort ?? "count";
	const maxSlices = cfg.maxSlices ?? DEFAULT_MAX_SLICES;

	const files =
		cfg.include === "files"
			? view.app.vault.getAllLoadedFiles().filter((f): f is TFile => f instanceof TFile)
			: view.app.vault.getMarkdownFiles();
	const paths = files.map((f) => f.path);

	const multiRoot = roots.length > 1;
	const homePath = multiRoot ? null : (roots[0] ?? "");
	const homeLabel = multiRoot
		? t().cards.folderchart.allRoots
		: homePath
			? (homePath.split("/").pop() ?? homePath)
			: t().cards.folderchart.vault;

	const bucketsFor = (drill: string | null): FolderBucket[] => {
		if (drill) return bucketByFolder(paths, drill, t().cards.folderchart.here);
		return multiRoot
			? bucketRoots(paths, roots, homeLabel)
			: bucketByFolder(paths, homePath ?? "", t().cards.folderchart.here);
	};

	let drill: string | null = drillState.get(card.id) ?? null;
	let buckets = bucketsFor(drill);
	// A drill path saved before the roots were changed can end up matching
	// nothing — fall back to the initial view rather than showing an empty card.
	if (drill && buckets.length === 0) {
		drillState.delete(card.id);
		drill = null;
		buckets = bucketsFor(null);
	}

	const setDrill = (target: string | null): void => {
		if (target) drillState.set(card.id, target);
		else drillState.delete(card.id);
		renderFolderChart(view, card, body);
	};

	body.empty();
	const wrap = body.createDiv("hearth-folderchart");

	const crumbs = drillCrumbs(homeLabel, homePath, drill);
	if (crumbs.length > 1) {
		const crumbRow = wrap.createDiv("hearth-folderchart-crumbs");
		crumbs.forEach((crumb, i) => {
			if (i > 0) crumbRow.createSpan({ cls: "hearth-folderchart-sep", text: "›" });
			const last = i === crumbs.length - 1;
			const el = crumbRow.createEl(last ? "span" : "a", {
				cls: "hearth-folderchart-crumb",
				text: crumb.label,
			});
			if (!last) {
				el.addClass("is-link");
				el.addEventListener("click", () => setDrill(crumb.target));
			}
		});
	}

	if (buckets.length === 0) {
		emptyState(wrap, "chart-pie", t().cards.folderchart.empty);
		return;
	}

	const plot = wrap.createDiv("hearth-folderchart-plot");

	if (style === "sunburst") {
		paintSunburst(plot, paths, buckets, sort, maxSlices, setDrill);
		return;
	}

	const metaByLabel = new Map<string, SliceMeta>(
		buckets.map((b) => [b.label, { path: b.path, hasChildren: b.hasChildren }]),
	);
	const data: ChartDatum[] = sortData(
		buckets.map((b) => ({ label: b.label, value: b.count })),
		sort,
	);
	const rolled = rollUp(data, maxSlices, t().cards.folderchart.other);
	const rgb = cfg.color ? hexToRgb(cfg.color) : accentRgb(wrap);

	if (style === "bars") paintBars(plot, rolled, metaByLabel, rgb, setDrill);
	else if (style === "pie") paintPie(plot, rolled, metaByLabel, rgb, setDrill);
	else paintRadial(plot, rolled, metaByLabel, rgb, setDrill);
}

/** Order a folder-bucket list by the card's sort choice. */
function bucketComparator(sort: "count" | "name"): (a: FolderBucket, b: FolderBucket) => number {
	return sort === "name"
		? (a, b) => a.label.localeCompare(b.label)
		: (a, b) => b.count - a.count || a.label.localeCompare(b.label);
}

/** Whether a slice can be drilled into (a real folder with subfolders below). */
function drillTarget(meta: SliceMeta | undefined): string | null {
	return meta?.path && meta.hasChildren ? meta.path : null;
}

function paintBars(
	container: HTMLElement,
	data: RolledDatum[],
	meta: Map<string, SliceMeta>,
	rgb: Rgb,
	onDrill: (target: string) => void,
): void {
	const list = container.createDiv("hearth-folderchart-bars");
	for (const row of barLayout(data)) {
		const target = drillTarget(meta.get(row.label));
		const rowEl = list.createDiv("hearth-folderchart-bar-row");
		rowEl.setAttribute("title", `${row.label} · ${row.value}`);
		if (target) {
			rowEl.addClass("is-drillable");
			rowEl.addEventListener("click", () => onDrill(target));
		}
		rowEl.createDiv({ cls: "hearth-folderchart-bar-label", text: row.label });
		const track = rowEl.createDiv("hearth-folderchart-bar-track");
		const fill = track.createDiv("hearth-folderchart-bar-fill");
		fill.style.width = `${(row.fraction * 100).toFixed(1)}%`;
		fill.style.backgroundColor = rgba(rgb, fillAlpha(row.fraction));
		rowEl.createDiv({ cls: "hearth-folderchart-bar-value", text: String(row.value) });
	}
}

function paintRadial(
	container: HTMLElement,
	data: RolledDatum[],
	meta: Map<string, SliceMeta>,
	rgb: Rgb,
	onDrill: (target: string) => void,
): void {
	const SIZE = 200;
	const R_INNER = 30;
	const TRACK = 64;

	const radial = container.createDiv("hearth-folderchart-radial");
	const svg = radial.createSvg("svg", {
		cls: "hearth-folderchart-svg",
		attr: { viewBox: `0 0 ${SIZE} ${SIZE}` },
	});
	const bars = radialLayout(
		data.map((d) => ({ label: d.label, value: d.value })),
		{ cx: SIZE / 2, cy: SIZE / 2, rInner: R_INNER, track: TRACK, padAngle: 2 },
	);
	const total = data.reduce((sum, d) => sum + d.value, 0);

	for (const bar of bars) {
		const fraction = (bar.outerRadius - R_INNER) / TRACK;
		const target = drillTarget(meta.get(bar.label));
		svg.createSvg("path", { cls: "hearth-folderchart-track", attr: { d: bar.trackPath } });
		const path = svg.createSvg("path", {
			cls: "hearth-folderchart-wedge",
			attr: { d: bar.barPath, fill: rgba(rgb, fillAlpha(fraction)) },
		});
		path.createSvg("title").textContent = `${bar.label} · ${bar.value}`;
		if (target) {
			path.addClass("is-drillable");
			path.addEventListener("click", () => onDrill(target));
		}
	}

	// The hub carries the running total for whatever folder is in view.
	svg.createSvg("text", {
		cls: "hearth-folderchart-total",
		attr: { x: SIZE / 2, y: SIZE / 2, "text-anchor": "middle", "dominant-baseline": "central" },
	}).textContent = String(total);

	// One hue for every wedge, so a legend is what ties a name to a slice.
	paintLegend(
		container,
		bars.map((bar) => ({
			label: bar.label,
			value: bar.value,
			alpha: fillAlpha((bar.outerRadius - R_INNER) / TRACK),
		})),
		meta,
		rgb,
		onDrill,
	);
}

function paintPie(
	container: HTMLElement,
	data: RolledDatum[],
	meta: Map<string, SliceMeta>,
	rgb: Rgb,
	onDrill: (target: string) => void,
): void {
	const SIZE = 200;
	const RADIUS = 92;

	const wrapEl = container.createDiv("hearth-folderchart-pie");
	const svg = wrapEl.createSvg("svg", {
		cls: "hearth-folderchart-svg",
		attr: { viewBox: `0 0 ${SIZE} ${SIZE}` },
	});
	const slices = pieLayout(
		data.map((d) => ({ label: d.label, value: d.value })),
		{ cx: SIZE / 2, cy: SIZE / 2, radius: RADIUS, padAngle: 1 },
	);
	// Shade each slice against the largest so neighbours read apart even in one
	// hue; a sorted-by-count chart then steps cleanly from solid to faint.
	const maxFraction = Math.max(...slices.map((s) => s.fraction), 0.0001);

	for (const slice of slices) {
		const target = drillTarget(meta.get(slice.label));
		const path = svg.createSvg("path", {
			cls: "hearth-folderchart-slice",
			attr: { d: slice.path, fill: rgba(rgb, fillAlpha(slice.fraction / maxFraction)) },
		});
		path.createSvg("title").textContent = `${slice.label} · ${slice.value} (${Math.round(slice.fraction * 100)}%)`;
		if (target) {
			path.addClass("is-drillable");
			path.addEventListener("click", () => onDrill(target));
		}
		// Name a slice on the wheel only when its wedge is wide enough to hold it.
		if (slice.endAngle - slice.startAngle >= 26) {
			const at = polarPoint(SIZE / 2, SIZE / 2, RADIUS * 0.62, slice.midAngle);
			svg.createSvg("text", {
				cls: "hearth-folderchart-slice-label",
				attr: { x: at.x, y: at.y, "text-anchor": "middle", "dominant-baseline": "central" },
			}).textContent = slice.label;
		}
	}

	paintLegend(
		container,
		slices.map((slice) => ({
			label: slice.label,
			value: slice.value,
			alpha: fillAlpha(slice.fraction / maxFraction),
		})),
		meta,
		rgb,
		onDrill,
	);
}

/** The name→slice legend shared by the radial and pie views: one row per
 * slice, drillable when its folder has subfolders. */
function paintLegend(
	container: HTMLElement,
	entries: { label: string; value: number; alpha: number }[],
	meta: Map<string, SliceMeta>,
	rgb: Rgb,
	onDrill: (target: string) => void,
): void {
	const legend = container.createDiv("hearth-folderchart-legend");
	for (const item of entries) {
		const target = drillTarget(meta.get(item.label));
		const entry = legend.createDiv("hearth-folderchart-legend-entry");
		if (target) {
			entry.addClass("is-drillable");
			entry.addEventListener("click", () => onDrill(target));
		}
		const swatch = entry.createDiv("hearth-folderchart-legend-swatch");
		swatch.style.backgroundColor = rgba(rgb, item.alpha);
		entry.createSpan({ cls: "hearth-folderchart-legend-label", text: item.label });
		entry.createSpan({ cls: "hearth-folderchart-legend-value", text: String(item.value) });
	}
}

/** Beyond this many top folders the hue wheel stops reading apart, so the
 * remainder folds into one neutral "Other" arc regardless of Max slices. */
const SUNBURST_COLOR_CAP = 8;

interface SunburstEntry {
	bucket: NestedBucket;
	/** The neutral roll-up arc, which gets no hue and no children. */
	isOther: boolean;
}

function paintSunburst(
	container: HTMLElement,
	paths: string[],
	topBuckets: FolderBucket[],
	sort: "count" | "name",
	maxSlices: number,
	onDrill: (target: string) => void,
): void {
	const otherLabel = t().cards.folderchart.other;
	const nested = nestedBuckets(
		paths,
		[...topBuckets].sort(bucketComparator(sort)),
		t().cards.folderchart.here,
	);

	const limit = Math.min(maxSlices > 0 ? maxSlices : nested.length, SUNBURST_COLOR_CAP + 1);
	let entries: SunburstEntry[];
	if (nested.length > limit) {
		const kept = nested.slice(0, limit - 1).map((bucket) => ({ bucket, isOther: false }));
		const rest = nested.slice(limit - 1);
		kept.push({
			bucket: {
				label: otherLabel,
				path: null,
				count: rest.reduce((sum, b) => sum + b.count, 0),
				hasChildren: false,
				children: [],
			},
			isOther: true,
		});
		entries = kept;
	} else {
		entries = nested.map((bucket) => ({ bucket, isOther: false }));
	}

	const SIZE = 220;
	const R_INNER = 24;
	const R_MID = 72;
	const R_OUTER = 106;

	const wrapEl = container.createDiv("hearth-folderchart-sunburst");
	const svg = wrapEl.createSvg("svg", {
		cls: "hearth-folderchart-svg",
		attr: { viewBox: `0 0 ${SIZE} ${SIZE}` },
	});

	const coloredCount = entries.filter((e) => !e.isOther).length;
	const hues = categoricalHues(container, Math.max(1, coloredCount));
	const arcs = sunburstLayout(
		entries.map((e) => ({
			label: e.bucket.label,
			value: e.bucket.count,
			children: e.bucket.children.map((c) => ({ label: c.label, value: c.count })),
		})),
		{ cx: SIZE / 2, cy: SIZE / 2, rInner: R_INNER, rMid: R_MID, rOuter: R_OUTER, padAngle: 1 },
	);
	const total = entries.reduce((sum, e) => sum + e.bucket.count, 0);

	arcs.forEach((arc, i) => {
		const entry = entries[i];
		const hue = hues[i] ?? hues[0];
		const parentRgb: Rgb = entry.isOther ? [150, 150, 150] : hslToRgb(hue, 55, 50);

		const inner = svg.createSvg("path", {
			cls: "hearth-folderchart-arc",
			attr: { d: arc.path, fill: rgba(parentRgb, 0.9) },
		});
		inner.createSvg("title").textContent = `${arc.label} · ${arc.value}`;
		if (entry.bucket.path && entry.bucket.hasChildren) {
			inner.addClass("is-drillable");
			const target = entry.bucket.path;
			inner.addEventListener("click", () => onDrill(target));
		}
		if (arc.endAngle - arc.startAngle >= 22) {
			const at = polarPoint(SIZE / 2, SIZE / 2, (R_INNER + R_MID) / 2, arc.midAngle);
			svg.createSvg("text", {
				cls: "hearth-folderchart-arc-label",
				attr: { x: at.x, y: at.y, "text-anchor": "middle", "dominant-baseline": "central" },
			}).textContent = arc.label;
		}

		arc.children.forEach((seg, j) => {
			const childBucket = entry.bucket.children[j];
			const k = arc.children.length;
			const light = entry.isOther ? 60 : k <= 1 ? 62 : 40 + (j / (k - 1)) * 32;
			const childRgb: Rgb = entry.isOther ? [176, 176, 176] : hslToRgb(hue, 48, light);
			const outer = svg.createSvg("path", {
				cls: "hearth-folderchart-arc",
				attr: { d: seg.path, fill: rgba(childRgb, 0.92) },
			});
			outer.createSvg("title").textContent = `${seg.label} · ${seg.value}`;
			if (childBucket?.path && childBucket.hasChildren) {
				outer.addClass("is-drillable");
				const target = childBucket.path;
				outer.addEventListener("click", () => onDrill(target));
			}
		});
	});

	svg.createSvg("text", {
		cls: "hearth-folderchart-total",
		attr: { x: SIZE / 2, y: SIZE / 2, "text-anchor": "middle", "dominant-baseline": "central" },
	}).textContent = String(total);

	// Legend names the inner ring (top folders) in their own colour.
	const legend = container.createDiv("hearth-folderchart-legend");
	entries.forEach((entry, i) => {
		const hue = hues[i] ?? hues[0];
		const swatchRgb: Rgb = entry.isOther ? [150, 150, 150] : hslToRgb(hue, 55, 50);
		const el = legend.createDiv("hearth-folderchart-legend-entry");
		if (entry.bucket.path && entry.bucket.hasChildren) {
			el.addClass("is-drillable");
			const target = entry.bucket.path;
			el.addEventListener("click", () => onDrill(target));
		}
		const swatch = el.createDiv("hearth-folderchart-legend-swatch");
		swatch.style.backgroundColor = rgba(swatchRgb, 0.9);
		el.createSpan({ cls: "hearth-folderchart-legend-label", text: entry.bucket.label });
		el.createSpan({ cls: "hearth-folderchart-legend-value", text: String(entry.bucket.count) });
	});
}


export function folderChartEditor(ctx: CardEditorContext, containerEl: HTMLElement): void {
	const cfg = (ctx.card.folderChart ??= {});

	new Setting(containerEl)
		.setName(t().editors.folderchart.roots)
		.setDesc(t().editors.folderchart.rootsDesc)
		.setHeading();
	folderListEditor(
		ctx,
		containerEl,
		() => cfg.roots ?? [],
		(folders) => {
			cfg.roots = folders;
		},
	);
	new Setting(containerEl).addButton((b) =>
		b.setButtonText(t().editors.folderchart.addRoot).onClick(() => {
			cfg.roots = [...(cfg.roots ?? []), ""];
			ctx.opts.save();
			ctx.requestRender();
		}),
	);

	new Setting(containerEl)
		.setName(t().editors.folderchart.style)
		.addDropdown((d) => {
			d.addOption("radial", t().editors.folderchart.styleRadial);
			d.addOption("bars", t().editors.folderchart.styleBars);
			d.addOption("pie", t().editors.folderchart.stylePie);
			d.addOption("sunburst", t().editors.folderchart.styleSunburst);
			d.setValue(cfg.style ?? "radial").onChange((v) => {
				cfg.style = v === "radial" ? undefined : (v as "bars" | "pie" | "sunburst");
				ctx.opts.save();
				ctx.requestRender();
			});
		});

	new Setting(containerEl)
		.setName(t().editors.folderchart.include)
		.addDropdown((d) => {
			d.addOption("notes", t().editors.folderchart.includeNotes);
			d.addOption("files", t().editors.folderchart.includeFiles);
			d.setValue(cfg.include ?? "notes").onChange((v) => {
				cfg.include = v === "files" ? "files" : undefined;
				ctx.opts.save();
				ctx.requestRender();
			});
		});

	new Setting(containerEl)
		.setName(t().editors.folderchart.sort)
		.addDropdown((d) => {
			d.addOption("count", t().editors.folderchart.sortCount);
			d.addOption("name", t().editors.folderchart.sortName);
			d.setValue(cfg.sort ?? "count").onChange((v) => {
				cfg.sort = v === "name" ? "name" : undefined;
				ctx.opts.save();
				ctx.requestRender();
			});
		});

	const slices = new Setting(containerEl)
		.setName(t().editors.folderchart.maxSlices)
		.setDesc(t().editors.folderchart.maxSlicesDesc);
	addNumberField(ctx, slices, {
		value: cfg.maxSlices ?? DEFAULT_MAX_SLICES,
		min: 0,
		max: 24,
		default: DEFAULT_MAX_SLICES,
		set: (n) => {
			cfg.maxSlices = n === DEFAULT_MAX_SLICES ? undefined : n;
		},
		clear: () => {
			cfg.maxSlices = undefined;
		},
	});

	const color = new Setting(containerEl)
		.setName(t().editors.folderchart.color)
		.setDesc(t().editors.folderchart.colorDesc);
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

/** Vault notes grouped by folder as a radial or horizontal bar chart, with
 * drill-down into subfolders. */
export const folderChartCard: CardDefinition<"folderchart"> = {
	kind: "folderchart",
	templates: [
		{
			id: "folderchart",
			name: "Folder distribution",
			icon: "chart-pie",
			build: () => ({ kind: "folderchart", title: "Folders", folderChart: {}, w: 5, h: 4 }),
		},
	],
	render: (view, card, body) => renderFolderChart(view, card, body),
	renderEditor: (container, ctx) => folderChartEditor(ctx, container),
	cloneConfig: (source, copy) => {
		if (source.folderChart) {
			copy.folderChart = {
				...source.folderChart,
				roots: source.folderChart.roots ? [...source.folderChart.roots] : undefined,
			};
		}
	},
	liveness: { mode: "vault" },
};
