import { Setting, TFile } from "obsidian";
import {
	type ChartDatum,
	type RolledDatum,
	barLayout,
	radialLayout,
	rollUp,
	sortData,
} from "../chartbars";
import { emptyState } from "../cardbodies";
import { addResetButton, folderListEditor } from "../editors";
import {
	type FolderBucket,
	bucketByFolder,
	bucketRoots,
	drillCrumbs,
	normalizeFolder,
} from "../folderchart";
import { t } from "../i18n";
import { type DashboardCard } from "../types";
import { type HomeView } from "../view";
import { type CardDefinition, type CardEditorContext } from "./definition";
import { type Rgb, accentRgb, hexToRgb, rgba, rgbToHex } from "./activityMetrics";


// ---- Folder distribution chart --------------------------------------------
//
// Vault notes grouped by folder, drawn as a radial ("circular barplot") or a
// horizontal bar chart. Each bar is one immediate child folder of whatever
// folder is in view, counting every note beneath it; clicking a bar with
// subfolders drills in, with a breadcrumb back out. Pointed at several roots
// at once, the top level shows one bar per root.
//
// Colour follows the heatmap/trend convention — one hue (the theme accent, or
// a per-card override), each bar's fill opacity ramped by its share of the
// largest — so a folder chart reads as magnitude, not as an unbounded
// categorical palette, and needs no palette validation.

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

	const metaByLabel = new Map<string, SliceMeta>(
		buckets.map((b) => [b.label, { path: b.path, hasChildren: b.hasChildren }]),
	);
	const data: ChartDatum[] = sortData(
		buckets.map((b) => ({ label: b.label, value: b.count })),
		sort,
	);
	const rolled = rollUp(data, maxSlices, t().cards.folderchart.other);
	const rgb = cfg.color ? hexToRgb(cfg.color) : accentRgb(wrap);

	const plot = wrap.createDiv("hearth-folderchart-plot");
	if (style === "bars") paintBars(plot, rolled, metaByLabel, rgb, setDrill);
	else paintRadial(plot, rolled, metaByLabel, rgb, setDrill);
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
	const legend = container.createDiv("hearth-folderchart-legend");
	for (const bar of bars) {
		const target = drillTarget(meta.get(bar.label));
		const entry = legend.createDiv("hearth-folderchart-legend-entry");
		if (target) {
			entry.addClass("is-drillable");
			entry.addEventListener("click", () => onDrill(target));
		}
		const swatch = entry.createDiv("hearth-folderchart-legend-swatch");
		swatch.style.backgroundColor = rgba(rgb, fillAlpha((bar.outerRadius - R_INNER) / TRACK));
		entry.createSpan({ cls: "hearth-folderchart-legend-label", text: bar.label });
		entry.createSpan({ cls: "hearth-folderchart-legend-value", text: String(bar.value) });
	}
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
			d.setValue(cfg.style ?? "radial").onChange((v) => {
				cfg.style = v === "bars" ? "bars" : undefined;
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
	slices.addSlider((s) => {
		s.setLimits(0, 24, 1)
			.setValue(cfg.maxSlices ?? DEFAULT_MAX_SLICES)
			.setDynamicTooltip()
			.onChange((v) => {
				cfg.maxSlices = v === DEFAULT_MAX_SLICES ? undefined : v;
				ctx.opts.save();
			});
	});
	slices.addExtraButton((b) =>
		b
			.setIcon("rotate-ccw")
			.setTooltip(t().settings.resetSlider)
			.onClick(() => {
				cfg.maxSlices = undefined;
				ctx.opts.save();
				ctx.requestRender();
			}),
	);

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
