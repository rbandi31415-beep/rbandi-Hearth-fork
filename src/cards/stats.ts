import { type Component, debounce, getAllTags, setIcon, Setting, TFile, TFolder } from "obsidian";
import { dailyNotePath, dailyNotesOptions, moment, type Moment } from "../cardbodies";
import { addNumberField, addResetButton, moveItem } from "../editors";
import { FILE_TYPE_GROUPS, fileTypeLabel, FOLDERS_GROUP_ID, groupById, groupForFile } from "../filetypes";
import { t } from "../i18n";
import { countQuery } from "../query";
import { taskDateCounts } from "../tasknotes";
import { ALL_STATS, DEFAULT_STATS, STAT_ICONS, type DashboardCard, type StatId } from "../types";
import { type HomeView } from "../view";
import { type CardDefinition, type CardEditorContext } from "./definition";


// ---- Vault statistics -----------------------------------------------------

/** Cheap vault stats — the counts here come from the already-loaded vault index
 * and metadata cache, never a file read, so it's fast even on large vaults.
 *
 * With no advanced config the card shows its fixed default set. When the card's
 * `stats.advanced` flag is on the user picks which built-in stats appear, breaks
 * attachments out into per file-type tiles, and adds custom query counts. */
export function renderStats(view: HomeView, card: DashboardCard, body: HTMLElement, component: Component): void {
	const cfg = card.stats;
	const advanced = cfg?.advanced ?? false;
	const vault = view.app.vault;

	let notes = 0;
	let attachments = 0;
	let folders = 0;
	// Oldest file creation time across the whole vault — the "days using Obsidian"
	// stat counts from here. Infinity so the first file always wins the min.
	let oldestCtime = Infinity;
	// Bytes across every file (notes + attachments), and notes whose last edit is
	// older than the stale cutoff — both free off `file.stat` in the pass below.
	let totalBytes = 0;
	let staleNotes = 0;
	const staleCutoff = Date.now() - Math.max(1, cfg?.staleDays ?? 180) * 86_400_000;
	// Single pass over the loaded files: counts plus the tag set (collected
	// inline for markdown files) instead of a second full getMarkdownFiles scan.
	// Per-file-type-group counts feed the advanced attachment breakdown.
	const tags = new Set<string>();
	const byType = new Map<string, number>();
	for (const f of vault.getAllLoadedFiles()) {
		if (f instanceof TFolder) {
			if (f.path !== "/") folders++;
		} else if (f instanceof TFile) {
			if (f.extension.toLowerCase() === "md") {
				notes++;
				if (f.stat.mtime > 0 && f.stat.mtime < staleCutoff) staleNotes++;
				const cache = view.app.metadataCache.getFileCache(f);
				if (cache) {
					for (const t of getAllTags(cache) ?? []) tags.add(t.toLowerCase());
				}
			} else {
				attachments++;
			}
			totalBytes += f.stat.size;
			if (f.stat.ctime > 0 && f.stat.ctime < oldestCtime) oldestCtime = f.stat.ctime;
			if (advanced) {
				const group = groupForFile(f);
				if (group) byType.set(group.id, (byType.get(group.id) ?? 0) + 1);
			}
		}
	}

	// Whole days between the oldest file's creation and now (0 for an empty vault
	// or one created today), so the tile reads as a tenure counter.
	const daysUsing = Number.isFinite(oldestCtime)
		? Math.max(0, Math.floor((Date.now() - oldestCtime) / 86_400_000))
		: 0;

	const builtins = advanced && cfg?.builtins ? cfg.builtins : DEFAULT_STATS;
	// Only walked when actually shown — a TaskNotes scan on top of the vault
	// pass above, so it stays out of the fixed default card's cost.
	const needsTaskCounts =
		builtins.includes("tasksOverdue") || builtins.includes("tasksPlanned") || builtins.includes("hoursPlanned");
	const taskCounts = needsTaskCounts ? taskDateCounts(view.app) : { overdue: 0, planned: 0, plannedMinutes: 0 };

	// Orphans: markdown notes with no resolved link in either direction — the
	// same notion as Obsidian's graph "no links" filter. Only computed when the
	// tile is shown; walks the link graph once to collect every linked path.
	const orphans = builtins.includes("orphans") ? orphanNoteCount(view) : 0;

	// Link totals from the already-resolved graph: `totalLinks` sums every
	// resolved wikilink, `brokenLinks` every link whose target doesn't exist.
	let totalLinks = 0;
	let brokenLinks = 0;
	if (builtins.includes("totalLinks") || builtins.includes("brokenLinks")) {
		const mc = view.app.metadataCache;
		for (const targets of Object.values(mc.resolvedLinks ?? {})) {
			for (const count of Object.values(targets)) totalLinks += count;
		}
		for (const targets of Object.values(mc.unresolvedLinks ?? {})) {
			for (const count of Object.values(targets)) brokenLinks += count;
		}
	}

	const values: Record<StatId, number | string> = {
		notes,
		attachments,
		folders,
		tags: tags.size,
		dayStreak: 0,
		daysUsing,
		tasksOverdue: taskCounts.overdue,
		tasksPlanned: taskCounts.planned,
		// Rounded to one decimal place — a whole number of minutes almost never
		// lands on a whole number of hours.
		hoursPlanned: Math.round((taskCounts.plannedMinutes / 60) * 10) / 10,
		orphans,
		brokenLinks,
		totalLinks,
		staleNotes,
		vaultSize: formatBytes(totalBytes),
	};
	const streak = dailyNoteStreak(view);

	const grid = body.createDiv("hearth-stats");
	for (const id of builtins) {
		// The day-streak tile only appears when daily notes are configured — same
		// as it always has — whether or not it's explicitly selected.
		if (id === "dayStreak") {
			if (streak !== null) addStat(grid, STAT_ICONS.dayStreak, streak, t().cards.stats.dayStreak);
			continue;
		}
		addStat(grid, STAT_ICONS[id], values[id], t().cards.stats[id]);
	}

	if (advanced) {
		// Attachment breakdown: one tile per selected file-type group.
		for (const groupId of cfg?.attachmentTypes ?? []) {
			const group = groupById(groupId);
			if (!group) continue;
			addStat(grid, group.icon, byType.get(groupId) ?? 0, fileTypeLabel(group));
		}

		// Custom query counts.
		for (const q of cfg?.queries ?? []) {
			const query = q.query?.trim();
			if (!query) continue;
			addStat(grid, q.icon?.trim() || "hash", countQuery(view.app, query), q.label?.trim() || query);
		}
	}

	if (cfg?.fitToCard) fitStatsToCard(component, body, grid);
}


/** Bytes as a compact human string: "820 B", "4.2 KB", "1.3 GB". */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let n = bytes / 1024;
	let unit = 0;
	while (n >= 1024 && unit < units.length - 1) {
		n /= 1024;
		unit++;
	}
	return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`;
}


function addStat(grid: HTMLElement, icon: string, value: number | string, label: string): void {
	const cell = grid.createDiv("hearth-stat");
	setIcon(cell.createDiv("hearth-stat-icon"), icon);
	cell.createDiv({ cls: "hearth-stat-value", text: String(value) });
	cell.createDiv({ cls: "hearth-stat-label", text: label });
}


/**
 * Shrinks tiles — icon/text size, gaps, and the grid's minimum column width
 * — via a --stat-scale custom property every one of those is defined
 * against, just enough that every stat tile fits the card without scrolling.
 * Handy once "Advanced" and a stack of custom stats push the grid past what
 * a single view of the card shows.
 *
 * Shrinking the column width too (not just row height) matters: it's what
 * lets more tiles fit per row as they shrink, which is the only thing that
 * actually reduces the row count on a card that's wide but short. That also
 * rules out a one-shot ratio (unlike a purely vertical shrink, smaller tiles
 * change the column count in discrete steps, not continuously), so this
 * steps the scale down and re-measures until it fits or hits the floor.
 *
 * Recomputes on resize (dragging the card, or the window) and stops
 * watching once this render is torn down.
 */
function fitStatsToCard(component: Component, body: HTMLElement, grid: HTMLElement): void {
	const FLOOR = 0.5;
	const STEP = 0.05;
	const fit = (): void => {
		let scale = 1;
		grid.style.removeProperty("--stat-scale");
		if (body.clientHeight <= 0) return;
		while (scale > FLOOR && grid.scrollHeight > body.clientHeight) {
			scale = Math.max(FLOOR, scale - STEP);
			grid.style.setProperty("--stat-scale", String(scale));
		}
	};
	fit();
	const observer = new ResizeObserver(debounce(fit, 60, true));
	observer.observe(body);
	component.register(() => observer.disconnect());
}


/**
 * Markdown notes that neither link to anything nor are linked to — Obsidian's
 * graph "no links" set. A note counts as connected if it has any outgoing link
 * (resolved or not) or appears as the target of another note's resolved link;
 * everything else in the vault's markdown file list is an orphan.
 */
function orphanNoteCount(view: HomeView): number {
	const cache = view.app.metadataCache;
	const resolved = cache.resolvedLinks ?? {};
	const unresolved = cache.unresolvedLinks ?? {};
	const connected = new Set<string>();
	for (const [source, targets] of Object.entries(resolved)) {
		const keys = Object.keys(targets);
		if (keys.length === 0) continue;
		connected.add(source);
		for (const target of keys) connected.add(target);
	}
	for (const [source, targets] of Object.entries(unresolved)) {
		if (Object.keys(targets).length > 0) connected.add(source);
	}
	let orphans = 0;
	for (const file of view.app.vault.getMarkdownFiles()) {
		if (!connected.has(file.path)) orphans++;
	}
	return orphans;
}


/** Consecutive days with an existing daily note, counting back from today —
 * or from yesterday if today's isn't written yet, so an otherwise-unbroken
 * streak doesn't read as zero just because the day isn't over. */
function dailyNoteStreak(view: HomeView): number | null {
	const options = dailyNotesOptions(view);
	if (!options) return null;

	let day: Moment = moment();
	if (!(view.app.vault.getAbstractFileByPath(dailyNotePath(day, options)) instanceof TFile)) {
		day = day.clone().subtract(1, "day");
	}

	let streak = 0;
	while (view.app.vault.getAbstractFileByPath(dailyNotePath(day, options)) instanceof TFile) {
		streak++;
		day = day.clone().subtract(1, "day");
		if (streak > 3650) break;
	}
	return streak;
}


/**
 * The stats card is plain by default — a fixed set of tiles, no controls. An
 * "Advanced" toggle unlocks the rest: choosing which built-in stats show,
 * breaking attachments out into per-file-type tiles, and custom query counts.
 * Everything below the toggle is gated on it, so a basic card stays basic.
 */
export function statsEditor(ctx: CardEditorContext, containerEl: HTMLElement): void {
	const cfg = (ctx.card.stats ??= {});

	new Setting(containerEl)
		.setName(t().editors.stats.advanced)
		.setDesc(t().editors.stats.advancedDesc)
		.addToggle((tg) =>
			tg.setValue(cfg.advanced ?? false).onChange((v) => {
				cfg.advanced = v || undefined;
				ctx.opts.save();
				ctx.opts.rerender();
				// Show/hide the advanced controls below.
				ctx.requestRender();
			}),
		);

	if (!cfg.advanced) return;

	new Setting(containerEl)
		.setName(t().editors.stats.fitToCard)
		.setDesc(t().editors.stats.fitToCardDesc)
		.addToggle((tg) =>
			tg.setValue(cfg.fitToCard ?? false).onChange((v) => {
				cfg.fitToCard = v || undefined;
				ctx.opts.save();
				ctx.requestRender();
			}),
		);

	// ---- Which built-in stats to show --------------------------------------
	new Setting(containerEl).setName(t().editors.stats.builtins).setHeading();
	const builtinSetting = new Setting(containerEl).setDesc(t().editors.stats.builtinsDesc);
	addResetButton(ctx, builtinSetting, t().settings.resetField, () => {
		cfg.builtins = undefined;
	});
	const selectedBuiltins = new Set<StatId>(cfg.builtins ?? DEFAULT_STATS);
	const builtinRow = containerEl.createDiv("hearth-type-filter");
	for (const id of ALL_STATS) {
		const chip = builtinRow.createDiv("hearth-type-filter-chip");
		const on = selectedBuiltins.has(id);
		chip.toggleClass("is-active", on);
		setIcon(chip.createDiv("hearth-type-filter-icon"), STAT_ICONS[id]);
		chip.createDiv({ cls: "hearth-type-filter-label", text: t().cards.stats[id] });
		chip.setAttribute("role", "button");
		chip.setAttribute("tabindex", "0");
		chip.setAttribute("aria-pressed", String(on));
		const toggle = () => {
			if (selectedBuiltins.has(id)) selectedBuiltins.delete(id);
			else selectedBuiltins.add(id);
			const active = selectedBuiltins.has(id);
			chip.toggleClass("is-active", active);
			chip.setAttribute("aria-pressed", String(active));
			// Keep the canonical order and collapse "exactly the default set"
			// back to undefined so the card reads as unconfigured. Compared
			// element-wise (not by length) since an optional stat can stand in
			// for a deselected default at the same count.
			const ordered = ALL_STATS.filter((s) => selectedBuiltins.has(s));
			const isDefault =
				ordered.length === DEFAULT_STATS.length &&
				ordered.every((s, i) => s === DEFAULT_STATS[i]);
			cfg.builtins = isDefault ? undefined : ordered;
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

	const stale = new Setting(containerEl)
		.setName(t().editors.stats.staleDays)
		.setDesc(t().editors.stats.staleDaysDesc);
	addNumberField(ctx, stale, {
		value: cfg.staleDays ?? 180,
		min: 1,
		max: 3650,
		default: 180,
		set: (n) => {
			cfg.staleDays = n === 180 ? undefined : n;
		},
		clear: () => {
			cfg.staleDays = undefined;
		},
	});

	// ---- Attachment breakdown by file type ---------------------------------
	new Setting(containerEl).setName(t().editors.stats.attachmentTypes).setHeading();
	const attachSetting = new Setting(containerEl).setDesc(t().editors.stats.attachmentTypesDesc);
	addResetButton(ctx, attachSetting, t().settings.resetField, () => {
		cfg.attachmentTypes = undefined;
	});
	const selectedTypes = new Set(cfg.attachmentTypes ?? []);
	const typeRow = containerEl.createDiv("hearth-type-filter");
	// Attachments are non-note files, so offer every file-type group except
	// folders and markdown notes.
	const groups = FILE_TYPE_GROUPS.filter(
		(g) => g.id !== FOLDERS_GROUP_ID && g.id !== "markdown",
	);
	for (const group of groups) {
		const chip = typeRow.createDiv("hearth-type-filter-chip");
		const on = selectedTypes.has(group.id);
		chip.toggleClass("is-active", on);
		setIcon(chip.createDiv("hearth-type-filter-icon"), group.icon);
		chip.createDiv({ cls: "hearth-type-filter-label", text: fileTypeLabel(group) });
		chip.setAttribute("role", "button");
		chip.setAttribute("tabindex", "0");
		chip.setAttribute("aria-pressed", String(on));
		const toggle = () => {
			if (selectedTypes.has(group.id)) selectedTypes.delete(group.id);
			else selectedTypes.add(group.id);
			const active = selectedTypes.has(group.id);
			chip.toggleClass("is-active", active);
			chip.setAttribute("aria-pressed", String(active));
			cfg.attachmentTypes = selectedTypes.size > 0 ? Array.from(selectedTypes) : undefined;
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

	// ---- Custom query counts ------------------------------------------------
	new Setting(containerEl).setName(t().editors.stats.customCounts).setHeading();
	new Setting(containerEl).setDesc(t().editors.stats.customCountsDesc);
	const queries = (cfg.queries ??= []);
	queries.forEach((q, index) => {
		const row = new Setting(containerEl).setClass("hearth-link-setting");
		row.addText((txt) =>
			txt
				.setPlaceholder(t().editors.stats.labelPlaceholder)
				.setValue(q.label ?? "")
				.onChange((v) => {
					q.label = v || undefined;
					ctx.opts.save();
					ctx.opts.rerender();
				}),
		);
		row.addText((txt) =>
			txt
				.setPlaceholder(t().editors.stats.iconPlaceholder)
				.setValue(q.icon ?? "")
				.onChange((v) => {
					q.icon = v || undefined;
					ctx.opts.save();
					ctx.opts.rerender();
				}),
		);
		row.addText((txt) =>
			txt
				.setPlaceholder(t().editors.stats.queryPlaceholder)
				.setValue(q.query)
				.onChange((v) => {
					q.query = v;
					ctx.opts.save();
					ctx.opts.rerender();
				}),
		);
		row.addExtraButton((b) =>
			b
				.setIcon("chevron-up")
				.setTooltip(t().editors.links.moveUp)
				.setDisabled(index === 0)
				.onClick(() => moveItem(ctx, queries, index, index - 1)),
		);
		row.addExtraButton((b) =>
			b
				.setIcon("chevron-down")
				.setTooltip(t().editors.links.moveDown)
				.setDisabled(index === queries.length - 1)
				.onClick(() => moveItem(ctx, queries, index, index + 1)),
		);
		row.addExtraButton((b) =>
			b
				.setIcon("trash-2")
				.setTooltip(t().editors.stats.removeCount)
				.onClick(() => {
					queries.splice(index, 1);
					ctx.opts.save();
					ctx.opts.rerender();
					ctx.requestRender();
				}),
		);
	});
	new Setting(containerEl).addButton((b) =>
		b.setButtonText(t().editors.stats.addCount).onClick(() => {
			queries.push({
				id: `stat-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
				query: "",
			});
			ctx.opts.save();
			ctx.requestRender();
		}),
	);
}

/** Vault statistics: note/word counts, attachment breakdown, custom queries. */
export const statsCard: CardDefinition<"stats"> = {
	kind: "stats",
	templates: [
		{ id: "stats", name: "Vault statistics", icon: "bar-chart-3", build: () => ({ kind: "stats", title: "Stats", w: 4, h: 2 }) },
	],
	render: (view, card, body, component) => renderStats(view, card, body, component),
	renderEditor: (container, ctx) => statsEditor(ctx, container),
	cloneConfig: (source, copy) => {
		if (source.stats)
			copy.stats = {
				...source.stats,
				builtins: source.stats.builtins ? [...source.stats.builtins] : undefined,
				attachmentTypes: source.stats.attachmentTypes ? [...source.stats.attachmentTypes] : undefined,
				queries: source.stats.queries ? source.stats.queries.map((q) => ({ ...q })) : undefined,
			};
	},
	liveness: { mode: "vault" },
};
