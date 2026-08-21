import { Notice, setIcon, Setting, TFile } from "obsidian";
import { cardOverlayButton, emptyState, stripFrontmatter } from "../cardbodies";
import { dailyPickIndexNoRepeat } from "../dates";
import { moveItem } from "../editors";
import { t } from "../i18n";
import { FilePickerModal } from "../pickers";
import { type DashboardCard } from "../types";
import { type HomeView } from "../view";
import { type CardDefinition, type CardEditorContext } from "./definition";


// ---- Daily question -------------------------------------------------------

/** Shown when the card has no custom pool of its own — a broad, varied set so
 * the card is useful right out of the box. Editable per-card; see
 * questionEditor. */
export const DEFAULT_QUESTIONS: string[] = [
	"What did you avoid today, and why?",
	"What would you do differently if no one were watching?",
	"What's a belief you hold that you haven't questioned in years?",
	"Who in your life deserves a thank-you you haven't given?",
	"What's the smallest thing you could change that would make the biggest difference?",
	"What are you tolerating that you shouldn't be?",
	"If this week were the last chance to say something, what would it be?",
	"What did your younger self want that you've quietly given up on?",
	"What's something you're proud of that no one else noticed?",
	"Where are you playing it safe when you'd rather take the risk?",
	"What conversation have you been putting off?",
	"What would you do this year if you knew you couldn't fail?",
	"What's a habit that's quietly shaping who you're becoming?",
	"Who do you need to forgive — including yourself?",
	"What's something you learned the hard way that you'd tell a friend?",
	"What does \"enough\" look like for you right now?",
	"What are you optimizing for, and is it still the right thing?",
	"What would you regret not trying?",
	"What's a question you're afraid to ask someone?",
	"What did you used to love doing that you've stopped making time for?",
	"What's one assumption about your life you've never tested?",
	"Whose opinion of you matters more than it should?",
	"What would \"good enough for today\" actually look like?",
	"What's the story you tell about yourself that might not be true anymore?",
	"What are you waiting for permission to do?",
];


/** The tracking note's path, normalized to end in ".md". Null when unset. */
function resolvedQuestionNotePath(card: DashboardCard): string | null {
	const raw = card.questionNote?.trim();
	if (!raw) return null;
	return raw.endsWith(".md") ? raw : `${raw}.md`;
}

/** One question per non-blank line of the note's body, with a leading list
 * marker ("- ", "1. ", "2)", …) stripped — so a plain bullet list works too,
 * and an external agent can drive the card just by editing lines of text. */
function parseQuestionLines(raw: string): string[] {
	return stripFrontmatter(raw)
		.split("\n")
		.map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim())
		.filter((line) => line.length > 0);
}

/** Paint the picked question and wire up the refresh button, once the pool
 * is known (synchronously for the array/default pool, after a read for a
 * note-backed one). Mirrors the random-note card's refresh: a manual click
 * cycles the pool for this viewing session only, never persisted, and the
 * overlay button lives outside `body` so repeated `draw()` calls (each just
 * emptying `body`) never pile up a duplicate. */
function mountQuestion(body: HTMLElement, pool: string[], card: DashboardCard): void {
	if (pool.length === 0) {
		emptyState(body, "help-circle", t().cards.empty.questionEmptyPool);
		return;
	}

	let offset = 0;
	const draw = (): void => {
		body.empty();
		const base = dailyPickIndexNoRepeat(Date.now(), pool.length);
		const idx = (base + offset) % pool.length;
		const wrap = body.createDiv("hearth-question");
		if (card.questionShowMark !== false) {
			wrap.createDiv({ cls: "hearth-question-mark", text: "?" });
		}
		wrap.createDiv({ cls: "hearth-question-text", text: pool[idx] });
	};
	draw();

	cardOverlayButton(
		body,
		"refresh-cw",
		t().cards.question.refresh,
		() => {
			offset = (offset + 1) % pool.length;
			draw();
		},
		"bottom-right",
	);
}

/**
 * One question, picked deterministically for today's date — the same
 * question all day, a different one tomorrow. The pool is either the card's
 * own list (or the built-in default), or — when questionNote is set — the
 * lines of a vault note, so an external agent or script can drive the card
 * by editing plain text.
 */
export function renderQuestion(view: HomeView, card: DashboardCard, body: HTMLElement): void {
	const notePath = resolvedQuestionNotePath(card);
	if (!notePath) {
		const pool = card.questions && card.questions.length > 0 ? card.questions : DEFAULT_QUESTIONS;
		mountQuestion(body, pool, card);
		return;
	}

	const file = view.app.vault.getAbstractFileByPath(notePath);
	if (!(file instanceof TFile)) {
		const empty = body.createDiv("hearth-card-empty");
		setIcon(empty.createDiv("hearth-card-empty-icon"), "help-circle");
		empty.createDiv({ cls: "hearth-card-empty-text", text: t().cards.empty.questionMissing });
		const create = empty.createEl("button", {
			cls: "hearth-daily-create",
			text: t().cards.question.createNote,
		});
		create.addEventListener("click", () => {
			const starter = `${DEFAULT_QUESTIONS.join("\n")}\n`;
			void view.app.vault
				.create(notePath, starter)
				.catch(() => new Notice(t().notices.couldNotCreateNote));
		});
		return;
	}

	void view.app.vault.cachedRead(file).then((raw) => {
		mountQuestion(body, parseQuestionLines(raw), card);
	});
}


export function questionEditor(ctx: CardEditorContext, containerEl: HTMLElement): void {
	const card = ctx.card;

	new Setting(containerEl)
		.setName(t().editors.question.showMark)
		.setDesc(t().editors.question.showMarkDesc)
		.addToggle((tg) =>
			tg.setValue(card.questionShowMark !== false).onChange((v) => {
				card.questionShowMark = v ? undefined : false;
				ctx.opts.save();
				ctx.requestRender();
			}),
		);

	new Setting(containerEl).setName(t().editors.question.sourceHeading).setHeading();
	const note = new Setting(containerEl)
		.setName(t().editors.question.note)
		.setDesc(t().editors.question.noteDesc);
	note.addText((txt) =>
		txt
			.setPlaceholder(t().editors.question.notePlaceholder)
			.setValue(card.questionNote ?? "")
			.onChange((v) => {
				card.questionNote = v.trim() || undefined;
				ctx.opts.save();
				ctx.requestRender();
			}),
	);
	note.addExtraButton((b) =>
		b
			.setIcon("file-symlink")
			.setTooltip(t().editors.question.pickNote)
			.onClick(() => {
				new FilePickerModal(ctx.app, (file) => {
					card.questionNote = file.path;
					ctx.opts.save();
					ctx.requestRender();
				}).open();
			}),
	);
	if (card.questionNote) {
		note.addExtraButton((b) =>
			b
				.setIcon("x")
				.setTooltip(t().editors.question.clearNote)
				.onClick(() => {
					card.questionNote = undefined;
					ctx.opts.save();
					ctx.requestRender();
				}),
		);
	}

	// A note-driven pool is edited as a note (by you, or by an agent) — the
	// card's own list editor below only applies when there's no note.
	if (card.questionNote) {
		new Setting(containerEl)
			.setName(t().editors.question.noteModeInfo)
			.setDesc(t().editors.question.noteModeInfoDesc);
		return;
	}

	new Setting(containerEl)
		.setName(t().editors.question.heading)
		.setDesc(t().editors.question.headingDesc)
		.setHeading();

	const questions = (ctx.card.questions ??= []);
	const pool = questions.length > 0 ? questions : DEFAULT_QUESTIONS;
	const usingDefaults = questions.length === 0;

	pool.forEach((question, index) => {
		const row = new Setting(containerEl).setClass("hearth-link-setting");
		row.addText((txt) => {
			txt.setValue(question).onChange((v) => {
				// Editing a default-pool row forks it into a real custom pool,
				// seeded with the defaults, so the other rows aren't lost.
				const list = usingDefaults ? [...DEFAULT_QUESTIONS] : questions;
				list[index] = v;
				ctx.card.questions = list;
				ctx.opts.save();
			});
			txt.inputEl.addClass("hearth-question-input");
		});
		row.addExtraButton((b) =>
			b
				.setIcon("chevron-up")
				.setTooltip(t().editors.links.moveUp)
				.setDisabled(index === 0)
				.onClick(() => {
					ctx.card.questions = usingDefaults ? [...DEFAULT_QUESTIONS] : questions;
					moveItem(ctx, ctx.card.questions, index, index - 1);
				}),
		);
		row.addExtraButton((b) =>
			b
				.setIcon("chevron-down")
				.setTooltip(t().editors.links.moveDown)
				.setDisabled(index === pool.length - 1)
				.onClick(() => {
					ctx.card.questions = usingDefaults ? [...DEFAULT_QUESTIONS] : questions;
					moveItem(ctx, ctx.card.questions, index, index + 1);
				}),
		);
		row.addExtraButton((b) =>
			b
				.setIcon("trash-2")
				.setTooltip(t().editors.question.removeQuestion)
				.onClick(() => {
					const list = usingDefaults ? [...DEFAULT_QUESTIONS] : questions;
					list.splice(index, 1);
					ctx.card.questions = list;
					ctx.opts.save();
					ctx.requestRender();
				}),
		);
	});

	new Setting(containerEl).addButton((b) =>
		b.setButtonText(t().editors.question.addQuestion).onClick(() => {
			const list = usingDefaults ? [...DEFAULT_QUESTIONS] : questions;
			list.push("");
			ctx.card.questions = list;
			ctx.opts.save();
			ctx.requestRender();
		}),
	);

	if (!usingDefaults) {
		new Setting(containerEl)
			.setName(t().editors.question.resetDefaults)
			.setDesc(t().editors.question.resetDefaultsDesc)
			.addButton((b) =>
				b.setButtonText(t().editors.question.resetDefaultsButton).onClick(() => {
					ctx.card.questions = undefined;
					ctx.opts.save();
					ctx.requestRender();
				}),
			);
	}
}

/** A thought-provoking question, picked deterministically once per day. */
export const questionCard: CardDefinition<"question"> = {
	kind: "question",
	templates: [
		{
			id: "question",
			name: "Daily question",
			icon: "help-circle",
			build: () => ({ kind: "question", title: "Today's question", w: 5, h: 3 }),
		},
	],
	render: (view, card, body) => renderQuestion(view, card, body),
	renderEditor: (container, ctx) => questionEditor(ctx, container),
	cloneConfig: (source, copy) => {
		if (source.questions) copy.questions = [...source.questions];
	},
	// Only meaningful while questionNote is set (returns null otherwise, so
	// the card just doesn't get vault-driven redraws — same as daily/embed
	// before their tracked file is configured).
	liveness: {
		mode: "watch-file",
		watchedPath: (_view, card) => resolvedQuestionNotePath(card),
		editableInPlace: () => false,
	},
};
