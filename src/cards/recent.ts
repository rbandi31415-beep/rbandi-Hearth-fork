import { setIcon, Setting, TFile } from "obsidian";
import { emptyState } from "../cardbodies";
import { addResetButton, folderListEditor } from "../editors";
import { applyFileIcon, fileIconOptions, resolveFileIcon } from "../fileicons";
import { FILE_TYPE_GROUPS, fileTypeLabel, FOLDERS_GROUP_ID, groupForFile } from "../filetypes";
import { t } from "../i18n";
import { openFile } from "../opener";
import { type DashboardCard } from "../types";
import { makeClickable } from "../ui";
import { type HomeView } from "../view";
import { type CardDefinition, type CardEditorContext } from "./definition";


// ---- Recent files -------------------------------------------------------

/** Whether `path` falls inside any of `folders` (or equals one exactly). An
 * empty list matches everything — "no restriction". */
function inAnyFolder(path: string, folders: string[]): boolean {
	if (folders.length === 0) return true;
	return folders.some((f) => path === f || path.startsWith(`${f}/`));
}

export function renderRecent(view: HomeView, card: DashboardCard, body: HTMLElement): void {
	const count = card.count && card.count > 0 ? card.count : 8;
	// Optional file-type filter: keep only files whose group is selected. An
	// empty/undefined list means no filtering (show every type). The filter is
	// applied before the count is capped, so the card shows the N most recent
	// files of the chosen types rather than the N most recent overall.
	const types = card.recentTypes && card.recentTypes.length > 0 ? new Set(card.recentTypes) : null;
	// Optional folder scope: any of these folders (or their subfolders).
	const folders = (card.recentFolders ?? []).map((f) => f.trim().replace(/\/+$/, "")).filter(Boolean);
	// Optional age cutoff, in days, against whichever timestamp the sort mode
	// uses. Only meaningful for "created"/"modified" — "opened" comes from
	// workspace history, which carries no per-file timestamp to filter by.
	const withinMs =
		card.recentWithinDays && card.recentWithinDays > 0 ? card.recentWithinDays * 86_400_000 : 0;
	const cutoff = withinMs ? Date.now() - withinMs : 0;
	const matches = (f: TFile): boolean => {
		if (!inAnyFolder(f.path, folders)) return false;
		if (!types) return true;
		const group = groupForFile(f);
		return group != null && types.has(group.id);
	};

	// "opened" (default) follows the workspace's recently-opened history, same
	// as always. "created"/"modified" instead scan the vault by that file
	// timestamp, so they surface files regardless of whether they've been
	// opened here — and can be filtered to a recent window.
	const sort = card.recentSort;
	const files =
		sort === "created" || sort === "modified"
			? view.app.vault
					.getAllLoadedFiles()
					.filter((f): f is TFile => f instanceof TFile)
					.filter(matches)
					.map((f) => ({ f, ts: sort === "created" ? f.stat.ctime : f.stat.mtime }))
					.filter(({ ts }) => !cutoff || ts >= cutoff)
					.sort((a, b) => b.ts - a.ts)
					.map(({ f }) => f)
					.slice(0, count)
			: view.app.workspace
					.getLastOpenFiles()
					.map((p) => view.app.vault.getAbstractFileByPath(p))
					.filter((f): f is TFile => f instanceof TFile)
					.filter(matches)
					.slice(0, count);

	if (files.length === 0) {
		emptyState(body, "history", t().cards.empty.recentEmpty);
		return;
	}

	const list = body.createDiv("hearth-list");
	const icons = fileIconOptions(view.plugin.settings);
	for (const file of files) {
		const row = list.createDiv("hearth-list-item");
		applyFileIcon(row.createDiv("hearth-list-icon"), resolveFileIcon(view.app, file, icons));
		row.createDiv({ cls: "hearth-list-label", text: file.basename });
		const open = () => void openFile(view, file, "card");
		row.addEventListener("click", open);
		makeClickable(row, open, file.basename);
	}
}


export function recentEditor(ctx: CardEditorContext, containerEl: HTMLElement): void {
	const card = ctx.card;
	const recent = new Setting(containerEl)
		.setName(t().editors.recent.count)
		.setDesc(t().editors.recent.countDesc);
	recent.addText((txt) => {
		txt.setValue(String(card.count ?? 8)).onChange((v) => {
			const n = parseInt(v, 10);
			card.count = Number.isNaN(n) ? undefined : n;
			ctx.opts.save();
		});
		txt.inputEl.type = "number";
		txt.inputEl.addClass("hearth-count-input");
	});
	addResetButton(ctx, recent, t().settings.resetField, () => {
		card.count = undefined;
	});

	new Setting(containerEl)
		.setName(t().editors.recent.sort)
		.setDesc(t().editors.recent.sortDesc)
		.addDropdown((d) => {
			d.addOption("opened", t().editors.recent.sortOpened);
			d.addOption("created", t().editors.recent.sortCreated);
			d.addOption("modified", t().editors.recent.sortModified);
			d.setValue(card.recentSort ?? "opened").onChange((v) => {
				card.recentSort = v === "created" || v === "modified" ? v : undefined;
				ctx.opts.save();
				// The "within N days" field only applies to created/modified, so it
				// needs to appear or disappear when the sort mode changes.
				ctx.requestRender();
			});
		});

	// Only meaningful once the list is sorted by a real file timestamp — the
	// "opened" mode has none to filter by (see renderRecent).
	if (card.recentSort === "created" || card.recentSort === "modified") {
		const within = new Setting(containerEl)
			.setName(t().editors.recent.withinDays)
			.setDesc(t().editors.recent.withinDaysDesc);
		within.addText((txt) => {
			txt
				.setPlaceholder(t().editors.recent.withinDaysPlaceholder)
				.setValue(card.recentWithinDays ? String(card.recentWithinDays) : "")
				.onChange((v) => {
					const n = parseInt(v, 10);
					card.recentWithinDays = Number.isNaN(n) || n <= 0 ? undefined : n;
					ctx.opts.save();
				});
			txt.inputEl.type = "number";
			txt.inputEl.addClass("hearth-count-input");
		});
		addResetButton(ctx, within, t().settings.resetField, () => {
			card.recentWithinDays = undefined;
		});
	}

	new Setting(containerEl)
		.setName(t().editors.recent.folders)
		.setDesc(t().editors.recent.foldersDesc);
	folderListEditor(
		ctx,
		containerEl,
		() => card.recentFolders ?? [],
		(v) => {
			card.recentFolders = v;
		},
	);

	recentTypesEditor(ctx, containerEl, card);
}


/** File-type filter for the recent-files card: a row of toggleable chips
 * mirroring the search filter's types. Any combination may be selected; an
 * empty selection means every type is shown. */
export function recentTypesEditor(ctx: CardEditorContext, containerEl: HTMLElement, card: DashboardCard): void {
	const setting = new Setting(containerEl)
		.setName(t().editors.recent.types)
		.setDesc(t().editors.recent.typesDesc);
	addResetButton(ctx, setting, t().settings.resetField, () => {
		card.recentTypes = undefined;
	});

	const selected = new Set(card.recentTypes ?? []);
	const row = containerEl.createDiv("hearth-type-filter");
	// Folders can never appear among recently-opened files, so offer every
	// search-filter type except that one.
	const groups = FILE_TYPE_GROUPS.filter((g) => g.id !== FOLDERS_GROUP_ID);
	for (const group of groups) {
		const chip = row.createDiv("hearth-type-filter-chip");
		chip.toggleClass("is-active", selected.has(group.id));
		setIcon(chip.createDiv("hearth-type-filter-icon"), group.icon);
		chip.createDiv({ cls: "hearth-type-filter-label", text: fileTypeLabel(group) });
		chip.setAttribute("role", "button");
		chip.setAttribute("tabindex", "0");
		chip.setAttribute("aria-pressed", String(selected.has(group.id)));
		const toggle = () => {
			if (selected.has(group.id)) selected.delete(group.id);
			else selected.add(group.id);
			const on = selected.has(group.id);
			chip.toggleClass("is-active", on);
			chip.setAttribute("aria-pressed", String(on));
			card.recentTypes = selected.size > 0 ? Array.from(selected) : undefined;
			ctx.opts.save();
			ctx.opts.rerender();
		};
		chip.addEventListener("click", toggle);
		chip.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				toggle();
			}
		});
	}
}

/** Recently opened (or created/modified) files, filtered by type, folder and
 * age. One configurable card kind — see recentEditor — rather than several
 * near-duplicate presets. */
export const recentCard: CardDefinition<"recent"> = {
	kind: "recent",
	templates: [
		{ id: "recent", name: "Recent files", icon: "history", build: () => ({ kind: "recent", title: "Recent", count: 8, w: 4, h: 3 }) },
	],
	render: (view, card, body) => renderRecent(view, card, body),
	renderEditor: (container, ctx) => recentEditor(ctx, container),
	cloneConfig: (source, copy) => {
		if (source.recentTypes) copy.recentTypes = [...source.recentTypes];
		if (source.recentFolders) copy.recentFolders = [...source.recentFolders];
	},
	// "created"/"modified" sort and the folder scope are vault-data-driven
	// (unlike plain "opened", which only reflects local workspace history), so
	// the card redraws on vault/metadata changes like stats and heatmap do.
	liveness: { mode: "vault" },
};
