import { Setting } from "obsidian";
import { cardOverlayButton, emptyState } from "../cardbodies";
import { dailyPickIndexNoRepeat } from "../dates";
import { folderListEditor } from "../editors";
import { applyFileIcon, fileIconOptions, resolveFileIcon } from "../fileicons";
import { t } from "../i18n";
import { openFile } from "../opener";
import { type DashboardCard } from "../types";
import { makeClickable } from "../ui";
import { type HomeView } from "../view";
import { type CardDefinition, type CardEditorContext } from "./definition";


// ---- Daily random note ----------------------------------------------------

/** Whether `path` falls inside any of `folders` (or equals one exactly). An
 * empty list matches everything — "no restriction". */
function inAnyFolder(path: string, folders: string[]): boolean {
	if (folders.length === 0) return true;
	return folders.some((f) => path === f || path.startsWith(`${f}/`));
}

/**
 * One note, picked deterministically from the pool for today's date — the
 * same note all day, a different one tomorrow, never the same as
 * yesterday's — with no chosen-file state to persist (see
 * dailyPickIndexNoRepeat). Resurfaces something you might otherwise never
 * open again.
 */
export function renderRandomNote(view: HomeView, card: DashboardCard, body: HTMLElement): void {
	const folders = (card.randomNoteFolders ?? []).map((f) => f.trim().replace(/\/+$/, "")).filter(Boolean);
	const pool = view.app.vault
		.getMarkdownFiles()
		.filter((f) => inAnyFolder(f.path, folders))
		// Stable order so the same day always resolves to the same index,
		// independent of the vault's internal file ordering.
		.sort((a, b) => a.path.localeCompare(b.path));

	if (pool.length === 0) {
		emptyState(body, "shuffle", t().cards.empty.randomNoteEmpty);
		return;
	}

	// A manual refresh cycles through the pool for this viewing session only —
	// never persisted, so the deterministic daily pick is back next time the
	// card mounts. `draw` only ever touches `body`'s children, so the overlay
	// button below (appended to the card element, outside `body`) survives
	// every reroll instead of piling up a new one per click.
	let offset = 0;
	const draw = (): void => {
		body.empty();
		const base = dailyPickIndexNoRepeat(Date.now(), pool.length);
		const file = pool[(base + offset) % pool.length];

		const wrap = body.createDiv("hearth-randomnote");
		const icons = fileIconOptions(view.plugin.settings);
		applyFileIcon(wrap.createDiv("hearth-randomnote-icon"), resolveFileIcon(view.app, file, icons));
		wrap.createDiv({ cls: "hearth-randomnote-name", text: file.basename });
		wrap.createDiv({ cls: "hearth-randomnote-hint", text: t().cards.randomNote.hint });

		const open = () => void openFile(view, file, "card");
		wrap.addEventListener("click", open);
		makeClickable(wrap, open, file.basename);
	};
	draw();

	cardOverlayButton(body, "refresh-cw", t().cards.randomNote.refresh, () => {
		offset = (offset + 1) % pool.length;
		draw();
	});
}


export function randomNoteEditor(ctx: CardEditorContext, containerEl: HTMLElement): void {
	const card = ctx.card;
	new Setting(containerEl)
		.setName(t().editors.randomNote.folders)
		.setDesc(t().editors.randomNote.foldersDesc);
	folderListEditor(
		ctx,
		containerEl,
		() => card.randomNoteFolders ?? [],
		(v) => {
			card.randomNoteFolders = v;
		},
	);
	new Setting(containerEl)
		.setName(t().editors.randomNote.info)
		.setDesc(t().editors.randomNote.infoDesc);
}

/** One note per day, picked deterministically so it's stable all day and
 * changes tomorrow. Optionally scoped to one or more folders. */
export const randomNoteCard: CardDefinition<"randomNote"> = {
	kind: "randomNote",
	templates: [
		{
			id: "randomNote",
			name: "Random note",
			icon: "shuffle",
			build: () => ({ kind: "randomNote", title: "Random note", w: 4, h: 3 }),
		},
	],
	render: (view, card, body) => renderRandomNote(view, card, body),
	renderEditor: (container, ctx) => randomNoteEditor(ctx, container),
	cloneConfig: (source, copy) => {
		if (source.randomNoteFolders) copy.randomNoteFolders = [...source.randomNoteFolders];
	},
	liveness: { mode: "static" },
};
