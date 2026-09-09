import { getAllTags, Setting, TFile } from "obsidian";
import { sparklinePoints } from "../chartbars";
import { emptyState } from "../cardbodies";
import { t } from "../i18n";
import { FolderPickerModal } from "../pickers";
import {
	type NewNotesScope,
	type NoteRecord,
	summarise,
} from "../newnotes";
import { openFile } from "../opener";
import { type DashboardCard } from "../types";
import { makeClickable } from "../ui";
import { type HomeView } from "../view";
import { type CardDefinition, type CardEditorContext } from "./definition";


// ---- New notes -----------------------------------------------------------
//
// A count of notes matching a scope — a tag (e.g. #person), a folder, or a
// frontmatter property — created in the last N days, with the change against
// the N days before it and an optional per-day sparkline and note list.
// General on purpose: "people added this month" and "recipes added this week"
// are the same card with a different scope.

const DEFAULT_DAYS = 30;

function windowDays(cfg: NonNullable<DashboardCard["newNotes"]>): number {
	return cfg.days && cfg.days > 0 ? Math.min(cfg.days, 365) : DEFAULT_DAYS;
}

/** The scope object from the flat card config, or null when it isn't filled
 * in yet (an unset tag / property key — a folder scope is always valid, "" =
 * whole vault). */
function resolveScope(cfg: NonNullable<DashboardCard["newNotes"]>): NewNotesScope | null {
	switch (cfg.scopeKind) {
		case "folder":
			return { kind: "folder", folder: cfg.folder ?? "" };
		case "property":
			return cfg.propertyKey?.trim()
				? { kind: "property", key: cfg.propertyKey.trim(), value: cfg.propertyValue?.trim() || undefined }
				: null;
		default:
			return cfg.tag?.trim() ? { kind: "tag", tag: cfg.tag.trim() } : null;
	}
}

/** Read every markdown file into the shape `summarise` needs. */
function collectNotes(view: HomeView): NoteRecord[] {
	const out: NoteRecord[] = [];
	for (const file of view.app.vault.getMarkdownFiles()) {
		const cache = view.app.metadataCache.getFileCache(file);
		const slash = file.path.lastIndexOf("/");
		out.push({
			path: file.path,
			folder: slash < 0 ? "" : file.path.slice(0, slash),
			ctime: file.stat.ctime,
			tags: (getAllTags(cache ?? {}) ?? []).map((tag) => tag.replace(/^#/, "").toLowerCase()),
			frontmatter: cache?.frontmatter ?? {},
		});
	}
	return out;
}

export function renderNewNotes(view: HomeView, card: DashboardCard, body: HTMLElement): void {
	const cfg = card.newNotes ?? {};
	const scope = resolveScope(cfg);
	if (!scope) {
		emptyState(body, "sparkles", t().cards.newnotes.unset);
		return;
	}

	const days = windowDays(cfg);
	const result = summarise(collectNotes(view), scope, days, Date.now());

	const wrap = body.createDiv("hearth-newnotes");

	const headline = wrap.createDiv("hearth-newnotes-headline");
	headline.createDiv({ cls: "hearth-newnotes-count", text: String(result.count) });

	const dir = result.delta > 0 ? "up" : result.delta < 0 ? "down" : "flat";
	const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "–";
	const delta = headline.createDiv({
		cls: `hearth-newnotes-delta is-${dir}`,
		text: `${arrow} ${Math.abs(result.delta)}`,
	});
	delta.setAttribute("title", t().cards.newnotes.vsPrevious(days, result.previous));

	wrap.createDiv({ cls: "hearth-newnotes-sub", text: t().cards.newnotes.inLastDays(days) });

	if (cfg.showSparkline && result.series.length >= 2) {
		const points = sparklinePoints(result.series, 100, 24);
		if (points) {
			const svg = wrap.createSvg("svg", {
				cls: "hearth-newnotes-spark",
				attr: { viewBox: "0 0 100 24", preserveAspectRatio: "none" },
			});
			svg.createSvg("polyline", { attr: { points, "vector-effect": "non-scaling-stroke" } });
		}
	}

	if (cfg.showList && result.recent.length > 0) {
		const list = wrap.createDiv("hearth-list hearth-newnotes-list");
		for (const note of result.recent) {
			const file = view.app.vault.getAbstractFileByPath(note.path);
			if (!(file instanceof TFile)) continue;
			const row = list.createDiv("hearth-list-item");
			row.createDiv({ cls: "hearth-list-label", text: file.basename });
			const open = () => void openFile(view, file, "card");
			row.addEventListener("click", open);
			makeClickable(row, open, file.basename);
		}
	}
}


export function newNotesEditor(ctx: CardEditorContext, containerEl: HTMLElement): void {
	const cfg = (ctx.card.newNotes ??= {});

	new Setting(containerEl).setName(t().editors.newnotes.scope).addDropdown((d) => {
		d.addOption("tag", t().editors.newnotes.scopeTag);
		d.addOption("folder", t().editors.newnotes.scopeFolder);
		d.addOption("property", t().editors.newnotes.scopeProperty);
		d.setValue(cfg.scopeKind ?? "tag").onChange((v) => {
			cfg.scopeKind = v === "tag" ? undefined : (v as "folder" | "property");
			ctx.opts.save();
			ctx.requestRender();
		});
	});

	const kind = cfg.scopeKind ?? "tag";
	if (kind === "tag") {
		new Setting(containerEl)
			.setName(t().editors.newnotes.tag)
			.setDesc(t().editors.newnotes.tagDesc)
			.addText((txt) =>
				txt
					.setPlaceholder("#person")
					.setValue(cfg.tag ?? "")
					.onChange((v) => {
						cfg.tag = v.trim() || undefined;
						ctx.opts.save();
					}),
			);
	} else if (kind === "folder") {
		const folder = new Setting(containerEl)
			.setName(t().editors.newnotes.folder)
			.setDesc(t().editors.newnotes.folderDesc);
		folder.addText((txt) =>
			txt
				.setPlaceholder(t().editors.newnotes.folderPlaceholder)
				.setValue(cfg.folder ?? "")
				.onChange((v) => {
					cfg.folder = v.trim() || undefined;
					ctx.opts.save();
				}),
		);
		folder.addExtraButton((b) =>
			b
				.setIcon("folder-symlink")
				.setTooltip(t().editors.newnotes.pickFolder)
				.onClick(() => {
					new FolderPickerModal(ctx.app, (f) => {
						cfg.folder = f.path === "/" ? undefined : f.path;
						ctx.opts.save();
						ctx.requestRender();
					}).open();
				}),
		);
	} else {
		new Setting(containerEl)
			.setName(t().editors.newnotes.propertyKey)
			.setDesc(t().editors.newnotes.propertyKeyDesc)
			.addText((txt) =>
				txt
					.setPlaceholder("type")
					.setValue(cfg.propertyKey ?? "")
					.onChange((v) => {
						cfg.propertyKey = v.trim() || undefined;
						ctx.opts.save();
					}),
			);
		new Setting(containerEl)
			.setName(t().editors.newnotes.propertyValue)
			.setDesc(t().editors.newnotes.propertyValueDesc)
			.addText((txt) =>
				txt
					.setPlaceholder(t().editors.newnotes.propertyValuePlaceholder)
					.setValue(cfg.propertyValue ?? "")
					.onChange((v) => {
						cfg.propertyValue = v.trim() || undefined;
						ctx.opts.save();
					}),
			);
	}

	const days = new Setting(containerEl)
		.setName(t().editors.newnotes.days)
		.setDesc(t().editors.newnotes.daysDesc);
	days.addSlider((s) => {
		s.setLimits(1, 365, 1)
			.setValue(cfg.days ?? DEFAULT_DAYS)
			.setDynamicTooltip()
			.onChange((v) => {
				cfg.days = v === DEFAULT_DAYS ? undefined : v;
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

	new Setting(containerEl).setName(t().editors.newnotes.showSparkline).addToggle((tg) =>
		tg.setValue(cfg.showSparkline ?? false).onChange((v) => {
			cfg.showSparkline = v || undefined;
			ctx.opts.save();
			ctx.requestRender();
		}),
	);

	new Setting(containerEl).setName(t().editors.newnotes.showList).addToggle((tg) =>
		tg.setValue(cfg.showList ?? false).onChange((v) => {
			cfg.showList = v || undefined;
			ctx.opts.save();
			ctx.requestRender();
		}),
	);
}

/** How many notes matching a tag, folder or property were created recently,
 * and the change from the window before. */
export const newNotesCard: CardDefinition<"newnotes"> = {
	kind: "newnotes",
	templates: [
		{
			id: "newnotes",
			name: "New notes",
			icon: "sparkles",
			build: () => ({ kind: "newnotes", title: "New notes", newNotes: {}, w: 4, h: 2 }),
		},
	],
	render: (view, card, body) => renderNewNotes(view, card, body),
	renderEditor: (container, ctx) => newNotesEditor(ctx, container),
	liveness: { mode: "vault" },
};
