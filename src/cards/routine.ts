import { Notice, Setting, TFile, setIcon } from "obsidian";
import { emptyState, moment } from "../cardbodies";
import { localDayKey } from "../dates";
import { addResetButton, moveItem } from "../editors";
import { t } from "../i18n";
import { FilePickerModal } from "../pickers";
import {
	ROUTINE_DATE_COLUMN,
	addSubtaskColumn,
	completeInstancesFor,
	deriveSessionColumns,
	makeColumnName,
	meetsThreshold,
	parseRoutineCsv,
	resolveThreshold,
	serializeRoutineCsv,
	setTick,
	tickValue,
	tickedCount,
	type RoutineData,
} from "../routine";
import { readTaskNotesSetup } from "../tasknotes";
import { promptForText } from "../ui";
import { type DashboardCard, type RoutineSession } from "../types";
import { type HomeView } from "../view";
import { type CardDefinition, type CardEditorContext } from "./definition";


// ---- Routine checklist grid --------------------------------------------
//
// A scrolling grid: rows are subtasks grouped by session, columns are days
// (oldest → today, today rightmost). Each cell is a checkbox stored as a
// boolean in a card-owned CSV, one row per day. When a day's ticked count for
// a session meets that session's threshold, the card writes the date into the
// session's recurring TaskNotes note's `complete_instances`; dropping back
// below the threshold removes it again.
//
// The CSV header is the source of truth for which subtasks exist — a column
// named `<sessionKey>:<label>` is one checklist row. The pure parsing and the
// threshold rules live in ../routine.ts.

const DEFAULT_DAYS = 30;
const MIN_DAYS = 7;
const MAX_DAYS = 120;
const DEFAULT_FILE = "Meta/Routine Log.csv";


/** The card's CSV path, normalised to end in ".csv". Null when unset. */
function resolvedFile(card: DashboardCard): string | null {
	const raw = card.routine?.file?.trim();
	if (!raw) return null;
	return raw.toLowerCase().endsWith(".csv") ? raw : `${raw}.csv`;
}


/** Visible day count, clamped the same way in the editor and the renderer. */
function visibleDays(card: DashboardCard): number {
	const n = card.routine?.days;
	return n && n > 0 ? Math.min(Math.max(n, MIN_DAYS), MAX_DAYS) : DEFAULT_DAYS;
}


/** The `YYYY-MM-DD` keys for the last `days` days, oldest first, ending today. */
function dayKeys(days: number): string[] {
	const today = moment().startOf("day");
	const out: string[] = [];
	for (let i = days - 1; i >= 0; i--) out.push(today.clone().subtract(i, "days").format("YYYY-MM-DD"));
	return out;
}


/** Create the log file (and its folder) with just the `date` header. */
async function createRoutineFile(view: HomeView, path: string, content?: string): Promise<void> {
	const slash = path.lastIndexOf("/");
	if (slash > 0) {
		const folder = path.slice(0, slash);
		if (!view.app.vault.getAbstractFileByPath(folder)) {
			try {
				await view.app.vault.createFolder(folder);
			} catch {
				// Already there, or a concurrent create — either way, carry on.
			}
		}
	}
	await view.app.vault.create(
		path,
		content ?? serializeRoutineCsv({ columns: [ROUTINE_DATE_COLUMN], rows: [] }),
	);
}


/** Write the log back, creating the file if it isn't there yet. */
async function writeData(view: HomeView, path: string, data: RoutineData): Promise<void> {
	const file = view.app.vault.getAbstractFileByPath(path);
	const text = serializeRoutineCsv(data);
	if (file instanceof TFile) await view.app.vault.modify(file, text);
	else await createRoutineFile(view, path, text);
}


/** Read the log fresh from disk (empty string when the file is missing). */
async function readData(view: HomeView, path: string): Promise<RoutineData> {
	const file = view.app.vault.getAbstractFileByPath(path);
	const text = file instanceof TFile ? await view.app.vault.cachedRead(file) : "";
	return parseRoutineCsv(text);
}


/**
 * Reconcile a session's TaskNotes note with the log: mark the day complete when
 * the ticked count meets the threshold, un-complete it when it drops below.
 * Best-effort — a note that can't be written leaves a notice and nothing else.
 */
async function syncSession(
	view: HomeView,
	data: RoutineData,
	session: RoutineSession,
	date: string,
): Promise<void> {
	const notePath = session.taskNote?.trim();
	if (!notePath) return;
	const file = view.app.vault.getAbstractFileByPath(notePath);
	if (!(file instanceof TFile)) return;

	const subtasks = deriveSessionColumns(data.columns).find((g) => g.key === session.key)?.subtasks ?? [];
	if (subtasks.length === 0) return;

	const threshold = resolveThreshold(subtasks.length, session.thresholdMode, session.thresholdValue);
	const done = meetsThreshold(tickedCount(data, date, subtasks), subtasks.length, threshold);
	const field = readTaskNotesSetup(view.app).fields.completeInstances;

	try {
		await view.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			const raw = fm[field];
			const toKey = (v: unknown): string =>
				typeof v === "string" || typeof v === "number" ? String(v) : "";
			const current = (Array.isArray(raw) ? raw.map(toKey) : [toKey(raw)]).filter(
				(d) => d.length > 0,
			);
			const next = completeInstancesFor(current, date, done);
			if (next.length) fm[field] = next;
			else delete fm[field];
		});
	} catch {
		new Notice(t().notices.couldNotUpdateRoutine);
	}
}


/** Toggle one cell: rewrite the row, then reconcile that session's note. */
async function toggleCell(
	view: HomeView,
	path: string,
	session: RoutineSession,
	column: string,
	date: string,
	value: boolean,
	redraw: () => void,
): Promise<void> {
	// Re-read before writing so a hand edit made since the last render isn't lost.
	const next = setTick(await readData(view, path), date, column, value);
	await writeData(view, path, next);
	await syncSession(view, next, session, date);
	redraw();
}


/** Prompt for a label and append a subtask column for one session. */
async function addSubtask(
	view: HomeView,
	path: string,
	sessionKey: string,
	redraw: () => void,
): Promise<void> {
	const answer = (
		await promptForText(view.app, {
			title: t().cards.routine.addItemTitle,
			label: t().cards.routine.addItemLabel,
			placeholder: t().cards.routine.addItemPlaceholder,
		})
	)?.trim();
	if (!answer) return;
	if (answer.includes(":")) {
		new Notice(t().cards.routine.addItemNoColon);
		return;
	}
	const next = addSubtaskColumn(await readData(view, path), makeColumnName(sessionKey, answer));
	await writeData(view, path, next);
	redraw();
}


export function renderRoutine(view: HomeView, card: DashboardCard, body: HTMLElement): void {
	const path = resolvedFile(card);
	if (!path) {
		emptyState(body, "list-checks", t().cards.empty.routineNoFile);
		return;
	}
	const sessions = card.routine?.sessions ?? [];
	// Preserved across redraws so ticking a box while scrolled into history
	// doesn't snap the grid back to today.
	const scrollState = { left: null as number | null };

	const draw = (): void => {
		void readData(view, path).then((data) => {
			body.empty();
			const file = view.app.vault.getAbstractFileByPath(path);

			if (!(file instanceof TFile)) {
				const empty = body.createDiv("hearth-card-empty");
				setIcon(empty.createDiv("hearth-card-empty-icon"), "list-checks");
				empty.createDiv({ cls: "hearth-card-empty-text", text: t().cards.empty.routineMissing });
				const create = empty.createEl("button", {
					cls: "hearth-daily-create",
					text: t().cards.routine.createFile,
				});
				create.addEventListener("click", () => {
					void createRoutineFile(view, path)
						.then(() => draw())
						.catch(() => new Notice(t().notices.couldNotCreateNote));
				});
				return;
			}

			if (sessions.length === 0) {
				emptyState(body, "list-checks", t().cards.empty.routineNoSessions);
				return;
			}

			paintGrid(view, card, body, data, sessions, path, draw, scrollState);
		});
	};

	draw();
}


function paintGrid(
	view: HomeView,
	card: DashboardCard,
	body: HTMLElement,
	data: RoutineData,
	sessions: RoutineSession[],
	path: string,
	redraw: () => void,
	scrollState: { left: number | null },
): void {
	const keys = dayKeys(visibleDays(card));
	const todayKey = localDayKey(Date.now());
	const groups = deriveSessionColumns(data.columns);

	const scroll = body.createDiv("hearth-routine-scroll");
	const grid = scroll.createDiv("hearth-routine-grid");
	grid.style.setProperty("--routine-days", String(keys.length));

	// Header row: an empty corner over the label column, then one cell per day.
	grid.createDiv("hearth-routine-cell hearth-routine-corner");
	for (const key of keys) {
		const m = moment(key, "YYYY-MM-DD");
		const cell = grid.createDiv("hearth-routine-cell hearth-routine-dayhead");
		if (key === todayKey) cell.addClass("is-today");
		cell.createDiv({ cls: "hearth-routine-dow", text: m.format("dd") });
		cell.createDiv({ cls: "hearth-routine-dom", text: m.format("D") });
		cell.setAttribute("aria-label", m.format("dddd, MMMM D"));
	}

	for (const session of sessions) {
		const subtasks = groups.find((g) => g.key === session.key)?.subtasks ?? [];
		const label = session.label?.trim() || session.key || t().cards.routine.untitledSession;
		const threshold = resolveThreshold(subtasks.length, session.thresholdMode, session.thresholdValue);

		// Session header row: the name plus an "add item" button, then a per-day
		// "ticked / total" progress cell that lights up once the day is complete.
		const head = grid.createDiv("hearth-routine-cell hearth-routine-label hearth-routine-sessionhead");
		head.createSpan({ cls: "hearth-routine-session-name", text: label });
		const add = head.createEl("button", {
			cls: "hearth-routine-add",
			attr: { "aria-label": t().cards.routine.addItem, title: t().cards.routine.addItem },
		});
		setIcon(add, "plus");
		add.addEventListener("click", () => {
			void addSubtask(view, path, session.key, redraw);
		});

		for (const key of keys) {
			const cell = grid.createDiv("hearth-routine-cell hearth-routine-progress");
			if (key === todayKey) cell.addClass("is-today");
			if (subtasks.length === 0) {
				cell.setText("–");
				continue;
			}
			const done = tickedCount(data, key, subtasks);
			if (meetsThreshold(done, subtasks.length, threshold)) cell.addClass("is-complete");
			cell.setText(`${done}/${subtasks.length}`);
			cell.setAttribute(
				"aria-label",
				t().cards.routine.progressLabel(label, moment(key, "YYYY-MM-DD").format("MMM D"), done, subtasks.length),
			);
		}

		// One row per subtask.
		for (const sub of subtasks) {
			grid.createDiv({
				cls: "hearth-routine-cell hearth-routine-label hearth-routine-subtask",
				text: sub.label,
			});
			for (const key of keys) {
				const on = tickValue(data, key, sub.column);
				const cell = grid.createDiv("hearth-routine-cell hearth-routine-check");
				if (key === todayKey) cell.addClass("is-today");
				const box = cell.createEl("button", {
					cls: "hearth-routine-box",
					attr: {
						role: "checkbox",
						"aria-checked": String(on),
						"aria-label": `${sub.label} · ${moment(key, "YYYY-MM-DD").format("MMM D")}`,
					},
				});
				if (on) {
					box.addClass("is-checked");
					setIcon(box, "check");
				}
				box.addEventListener("click", () => {
					void toggleCell(view, path, session, sub.column, key, !on, redraw);
				});
			}
		}
	}

	// Restore the reader's scroll position, or open with today (rightmost) in view.
	scroll.scrollLeft = scrollState.left ?? scroll.scrollWidth;
	scroll.addEventListener("scroll", () => {
		scrollState.left = scroll.scrollLeft;
	});
}


export function routineEditor(ctx: CardEditorContext, containerEl: HTMLElement): void {
	const cfg = (ctx.card.routine ??= {});

	new Setting(containerEl)
		.setName(t().editors.routine.file)
		.setDesc(t().editors.routine.fileDesc)
		.addText((txt) =>
			txt
				.setPlaceholder(DEFAULT_FILE)
				.setValue(cfg.file ?? "")
				.onChange((v) => {
					cfg.file = v.trim() || undefined;
					ctx.opts.save();
					ctx.requestRender();
				}),
		);

	const days = new Setting(containerEl)
		.setName(t().editors.routine.days)
		.setDesc(t().editors.routine.daysDesc);
	days.addSlider((s) =>
		s
			.setLimits(MIN_DAYS, MAX_DAYS, 1)
			.setValue(cfg.days ?? DEFAULT_DAYS)
			.onChange((v) => {
				cfg.days = v === DEFAULT_DAYS ? undefined : v;
				ctx.opts.save();
			}),
	);
	addResetButton(ctx, days, t().settings.resetSlider, () => {
		cfg.days = undefined;
	});

	new Setting(containerEl).setName(t().editors.routine.sessionsHeading).setHeading();

	const sessions = (cfg.sessions ??= []);
	sessions.forEach((session, index) => {
		const box = containerEl.createDiv("hearth-routine-session-editor");

		new Setting(box)
			.setName(t().editors.routine.sessionKey)
			.setDesc(t().editors.routine.sessionKeyDesc)
			.addText((txt) =>
				txt.setValue(session.key).onChange((v) => {
					session.key = v.trim();
					ctx.opts.save();
					ctx.requestRender();
				}),
			);

		new Setting(box).setName(t().editors.routine.sessionLabel).addText((txt) =>
			txt.setValue(session.label ?? "").onChange((v) => {
				session.label = v.trim() || undefined;
				ctx.opts.save();
			}),
		);

		const note = new Setting(box)
			.setName(t().editors.routine.sessionNote)
			.setDesc(t().editors.routine.sessionNoteDesc);
		note.addText((txt) =>
			txt
				.setPlaceholder("Tasks/Morning Routine.md")
				.setValue(session.taskNote ?? "")
				.onChange((v) => {
					session.taskNote = v.trim() || undefined;
					ctx.opts.save();
				}),
		);
		note.addExtraButton((b) =>
			b
				.setIcon("file-symlink")
				.setTooltip(t().editors.routine.pickNote)
				.onClick(() => {
					new FilePickerModal(ctx.app, (file) => {
						session.taskNote = file.path;
						ctx.opts.save();
						ctx.requestRender();
					}).open();
				}),
		);

		const threshold = new Setting(box)
			.setName(t().editors.routine.threshold)
			.setDesc(t().editors.routine.thresholdDesc);
		threshold.addDropdown((d) => {
			d.addOption("all", t().editors.routine.thresholdAll);
			d.addOption("count", t().editors.routine.thresholdCount);
			d.addOption("percent", t().editors.routine.thresholdPercent);
			d.setValue(session.thresholdMode ?? "all").onChange((v) => {
				session.thresholdMode = v === "count" || v === "percent" ? v : undefined;
				if (!session.thresholdMode) session.thresholdValue = undefined;
				ctx.opts.save();
				ctx.requestRender();
			});
		});
		if (session.thresholdMode) {
			threshold.addText((txt) =>
				txt
					.setPlaceholder(session.thresholdMode === "percent" ? "80" : "3")
					.setValue(session.thresholdValue != null ? String(session.thresholdValue) : "")
					.onChange((v) => {
						const n = Number(v.trim());
						session.thresholdValue = Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
						ctx.opts.save();
					}),
			);
		}

		const actions = new Setting(box);
		actions.addExtraButton((b) =>
			b
				.setIcon("chevron-up")
				.setTooltip(t().editors.links.moveUp)
				.setDisabled(index === 0)
				.onClick(() => moveItem(ctx, sessions, index, index - 1)),
		);
		actions.addExtraButton((b) =>
			b
				.setIcon("chevron-down")
				.setTooltip(t().editors.links.moveDown)
				.setDisabled(index === sessions.length - 1)
				.onClick(() => moveItem(ctx, sessions, index, index + 1)),
		);
		actions.addExtraButton((b) =>
			b
				.setIcon("trash-2")
				.setTooltip(t().editors.routine.removeSession)
				.onClick(() => {
					sessions.splice(index, 1);
					ctx.opts.save();
					ctx.requestRender();
				}),
		);
	});

	new Setting(containerEl).addButton((b) =>
		b.setButtonText(t().editors.routine.addSession).onClick(() => {
			sessions.push({ id: `routine-${Date.now().toString(36)}`, key: "" });
			ctx.opts.save();
			ctx.requestRender();
		}),
	);
}


/**
 * A daily checklist grid — subtask rows grouped by session, day columns
 * scrolling sideways — backed by a card-owned CSV, that marks each session's
 * recurring TaskNotes note complete once enough of its boxes are ticked.
 */
export const routineCard: CardDefinition<"routine"> = {
	kind: "routine",
	templates: [
		{
			id: "routine",
			name: "Routine checklist",
			icon: "list-checks",
			build: () => ({
				kind: "routine",
				title: "Daily routine",
				routine: {
					file: DEFAULT_FILE,
					sessions: [
						{ id: "routine-morning", key: "morning", label: "Morning" },
						{ id: "routine-closing", key: "closing", label: "Closing" },
					],
				},
				w: 8,
				h: 4,
			}),
		},
	],
	render: (view, card, body) => renderRoutine(view, card, body),
	renderEditor: (container, ctx) => routineEditor(ctx, container),
	cloneConfig: (source, copy) => {
		if (source.routine) {
			copy.routine = {
				...source.routine,
				sessions: source.routine.sessions?.map((s) => ({ ...s })),
			};
		}
	},
	// The card's own writes redraw immediately; watching the file also catches
	// the CSV being edited by hand (a new header column, a backfilled day) or
	// synced in from another device.
	liveness: {
		mode: "watch-file",
		watchedPath: (_view, card) => resolvedFile(card),
		editableInPlace: () => false,
	},
};
