import { Notice, setIcon, Setting, TFile } from "obsidian";
import { emptyState } from "../cardbodies";
import { formatRelativeDate, localDayKey } from "../dates";
import { moveItem } from "../editors";
import { t } from "../i18n";
import { FilePickerModal } from "../pickers";
import { type DashboardCard } from "../types";
import { type HomeView } from "../view";
import { type CardDefinition, type CardEditorContext } from "./definition";


// ---- Ritual stamps (last cleanup / last linking, or anything else) -------

/** The tracking note's path, normalized to end in ".md" — so a path typed
 * without the extension still resolves. Null when unset. */
function resolvedStampPath(card: DashboardCard): string | null {
	const raw = card.stampNote?.trim();
	if (!raw) return null;
	return raw.endsWith(".md") ? raw : `${raw}.md`;
}

/** A frontmatter property's value as a plain string, tolerating a bare string
 * or a single-item list (frontmatter is untyped at the source, so this takes
 * `unknown` and narrows by hand rather than trusting its declared `any`). */
function frontmatterString(fm: unknown, key: string): string | undefined {
	if (!fm || typeof fm !== "object") return undefined;
	const raw = (fm as Record<string, unknown>)[key];
	if (typeof raw === "string") return raw;
	if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
	return undefined;
}


/**
 * A small list of "when did I last do X" rituals — each a label plus a
 * frontmatter property on one shared tracking note. A button writes today's
 * date onto that property; the row shows how long it's been since, via the
 * same relative-date wording tasks use for due dates.
 */
export function renderStamps(view: HomeView, card: DashboardCard, body: HTMLElement): void {
	const path = resolvedStampPath(card);
	if (!path) {
		emptyState(body, "stamp", t().cards.empty.stampsNoNote);
		return;
	}

	const draw = (): void => {
		body.empty();
		const file = view.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			const empty = body.createDiv("hearth-card-empty");
			setIcon(empty.createDiv("hearth-card-empty-icon"), "stamp");
			empty.createDiv({ cls: "hearth-card-empty-text", text: t().cards.empty.stampsMissing });
			const create = empty.createEl("button", {
				cls: "hearth-daily-create",
				text: t().cards.stamps.createNote,
			});
			create.addEventListener("click", () => {
				void view.app.vault
					.create(path, "")
					.then(() => draw())
					.catch(() => new Notice(t().notices.couldNotCreateNote));
			});
			return;
		}

		const fields = card.stampFields ?? [];
		if (fields.length === 0) {
			emptyState(body, "stamp", t().cards.empty.stampsNoFields);
			return;
		}

		const fm = view.app.metadataCache.getFileCache(file)?.frontmatter;
		const list = body.createDiv("hearth-stamps");
		for (const field of fields) {
			const row = list.createDiv("hearth-stamp-row");
			row.createDiv({ cls: "hearth-stamp-label", text: field.label });

			const value = field.property ? frontmatterString(fm, field.property) : undefined;
			row.createDiv({
				cls: "hearth-stamp-value",
				text: value?.trim() ? formatRelativeDate(value) : t().cards.stamps.never,
			});

			const button = row.createEl("button", {
				cls: "hearth-stamp-button",
				text: t().cards.stamps.stampNow,
			});
			button.disabled = !field.property.trim();
			button.addEventListener("click", () => {
				const property = field.property.trim();
				if (!property) return;
				void view.app.fileManager
					.processFrontMatter(file, (data: Record<string, unknown>) => {
						data[property] = localDayKey(Date.now());
					})
					.then(() => draw())
					.catch(() => new Notice(t().notices.couldNotUpdateStamp));
			});
		}
	};

	draw();
}


export function stampsEditor(ctx: CardEditorContext, containerEl: HTMLElement): void {
	const card = ctx.card;

	const note = new Setting(containerEl)
		.setName(t().editors.stamps.note)
		.setDesc(t().editors.stamps.noteDesc);
	note.addText((txt) =>
		txt
			.setPlaceholder(t().editors.stamps.notePlaceholder)
			.setValue(card.stampNote ?? "")
			.onChange((v) => {
				card.stampNote = v.trim() || undefined;
				ctx.opts.save();
				ctx.requestRender();
			}),
	);
	note.addExtraButton((b) =>
		b
			.setIcon("file-symlink")
			.setTooltip(t().editors.stamps.pickNote)
			.onClick(() => {
				new FilePickerModal(ctx.app, (file) => {
					card.stampNote = file.path;
					ctx.opts.save();
					ctx.requestRender();
				}).open();
			}),
	);

	new Setting(containerEl).setName(t().editors.stamps.fieldsHeading).setHeading();
	const fields = (card.stampFields ??= []);
	fields.forEach((field, index) => {
		const row = new Setting(containerEl).setClass("hearth-link-setting");
		row.addText((txt) =>
			txt
				.setPlaceholder(t().editors.stamps.labelPlaceholder)
				.setValue(field.label)
				.onChange((v) => {
					field.label = v;
					ctx.opts.save();
				}),
		);
		row.addText((txt) =>
			txt
				.setPlaceholder(t().editors.stamps.propertyPlaceholder)
				.setValue(field.property)
				.onChange((v) => {
					field.property = v;
					ctx.opts.save();
				}),
		);
		row.addExtraButton((b) =>
			b
				.setIcon("chevron-up")
				.setTooltip(t().editors.links.moveUp)
				.setDisabled(index === 0)
				.onClick(() => moveItem(ctx, fields, index, index - 1)),
		);
		row.addExtraButton((b) =>
			b
				.setIcon("chevron-down")
				.setTooltip(t().editors.links.moveDown)
				.setDisabled(index === fields.length - 1)
				.onClick(() => moveItem(ctx, fields, index, index + 1)),
		);
		row.addExtraButton((b) =>
			b
				.setIcon("trash-2")
				.setTooltip(t().editors.stamps.removeField)
				.onClick(() => {
					fields.splice(index, 1);
					ctx.opts.save();
					ctx.requestRender();
				}),
		);
	});

	new Setting(containerEl).addButton((b) =>
		b.setButtonText(t().editors.stamps.addField).onClick(() => {
			fields.push({ id: `stamp-${Date.now().toString(36)}`, label: "", property: "" });
			ctx.opts.save();
			ctx.requestRender();
		}),
	);
}

/** "When did I last do X": a shared tracking note's frontmatter, stamped with
 * today's date on click, shown as "N days ago". */
export const stampsCard: CardDefinition<"stamps"> = {
	kind: "stamps",
	templates: [
		{
			id: "stamps",
			name: "Ritual stamps",
			icon: "stamp",
			build: () => ({
				kind: "stamps",
				title: "Last done",
				stampFields: [
					{ id: "cleanup", label: "Cleanup", property: "cleanup-last" },
					{ id: "linking", label: "Linking", property: "linking-last" },
				],
				w: 4,
				h: 3,
			}),
		},
	],
	render: (view, card, body) => renderStamps(view, card, body),
	renderEditor: (container, ctx) => stampsEditor(ctx, container),
	cloneConfig: (source, copy) => {
		if (source.stampFields) copy.stampFields = source.stampFields.map((f) => ({ ...f }));
	},
	// The card's own writes (processFrontMatter) already redraw themselves
	// immediately; this mode also catches the note being edited by hand
	// elsewhere (Properties panel, another device via sync).
	liveness: {
		mode: "watch-file",
		watchedPath: (_view, card) => resolvedStampPath(card),
		editableInPlace: () => false,
	},
};
