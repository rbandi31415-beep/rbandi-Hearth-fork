/**
 * Routine log — the pure half of the "routine" card.
 *
 * The card owns one CSV file, one row per day. The header's first column is
 * always `date`; every other column is named `<sessionKey>:<subtask label>` and
 * holds a boolean tick (`1`/`0`, also reading `true` / `yes` / `x`). The header
 * row is the source of truth for which subtasks exist — the card derives its
 * session groups straight from it, so adding a column adds a checklist item.
 *
 * Everything here is Obsidian-free so the CSV parsing, the session grouping and
 * the threshold / completion rules stay unit-tested; the vault I/O and the
 * write-back into TaskNotes' `complete_instances` live in `cards/routine.ts`.
 */

/** The fixed first column of every routine log. */
export const ROUTINE_DATE_COLUMN = "date";

/** Cell values (case-insensitive) read as a ticked box. Everything else — "0",
 * "", "false" — is unticked. */
const TRUE_TOKENS = new Set(["1", "true", "yes", "y", "x", "✓", "done"]);

/** A parsed routine log. */
export interface RoutineData {
	/** Column names in file order; `columns[0]` is always {@link ROUTINE_DATE_COLUMN}. */
	columns: string[];
	/** One entry per recognised data row. The card keeps them date-sorted. */
	rows: RoutineRow[];
}

/** One day's row. A column absent from `ticks` reads as unticked. */
export interface RoutineRow {
	/** `YYYY-MM-DD`. */
	date: string;
	ticks: Record<string, boolean>;
}

/** One subtask, as derived from a CSV column name. */
export interface RoutineSubtask {
	/** The full column name, e.g. `morning:Weigh in`. */
	column: string;
	/** The part after the first ":", trimmed — the row's visible label. */
	label: string;
}

/** A session and the subtask columns that belong to it, in header order. */
export interface RoutineSessionColumns {
	key: string;
	subtasks: RoutineSubtask[];
}

/** How a session decides its day is "done". `count` needs N ticked, `percent`
 * needs N% of its subtasks; an unset mode means all of them. */
export type RoutineThresholdMode = "count" | "percent";

export interface RoutineThreshold {
	mode: RoutineThresholdMode;
	value: number;
}


/** Split one CSV line into fields, honouring `"`-quoting and `""` escapes.
 * Embedded newlines are not supported (the writer never produces them). */
function splitCsvLine(line: string): string[] {
	const out: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quoted) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					quoted = false;
				}
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			quoted = true;
		} else if (ch === ",") {
			out.push(field);
			field = "";
		} else {
			field += ch;
		}
	}
	out.push(field);
	return out;
}


/** Quote a field only when it carries a comma, quote or newline. */
function quoteField(value: string): string {
	return /["\r\n,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}


/** Whether a raw cell value counts as a ticked box. */
export function parseTick(raw: string): boolean {
	return TRUE_TOKENS.has(raw.trim().toLowerCase());
}


/**
 * Parse a routine log. A missing, empty or unrecognised file (one whose first
 * column isn't `date`) yields an empty log rather than throwing — the card then
 * shows an empty grid instead of corrupting whatever the file actually holds.
 */
export function parseRoutineCsv(text: string): RoutineData {
	const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
	if (lines.length === 0) return { columns: [ROUTINE_DATE_COLUMN], rows: [] };

	const header = splitCsvLine(lines[0]).map((c) => c.trim());
	if (header[0]?.toLowerCase() !== ROUTINE_DATE_COLUMN) {
		return { columns: [ROUTINE_DATE_COLUMN], rows: [] };
	}

	const columns = [ROUTINE_DATE_COLUMN, ...header.slice(1).filter((c) => c.length > 0)];
	const rows: RoutineRow[] = [];
	for (const line of lines.slice(1)) {
		const cells = splitCsvLine(line);
		const date = (cells[0] ?? "").trim();
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
		const ticks: Record<string, boolean> = {};
		for (let i = 1; i < columns.length; i++) {
			if (parseTick(cells[i] ?? "")) ticks[columns[i]] = true;
		}
		rows.push({ date, ticks });
	}
	return { columns, rows };
}


/** Serialise a routine log. Rows come out date-sorted and ticks normalise to
 * `1`/`0`, so the file stays tidy however it was hand-edited. */
export function serializeRoutineCsv(data: RoutineData): string {
	const header = data.columns.map(quoteField).join(",");
	const rows = [...data.rows]
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
		.map((row) =>
			data.columns
				.map((col, i) => (i === 0 ? row.date : row.ticks[col] ? "1" : "0"))
				.map(quoteField)
				.join(","),
		);
	return [header, ...rows].join("\n") + "\n";
}


/**
 * Group the subtask columns by session key: split each non-date column on its
 * first ":", the left side is the session key and the right the subtask label.
 * Sessions come back in first-seen order; a column with no ":", an empty key or
 * an empty label is skipped (it isn't a subtask column).
 */
export function deriveSessionColumns(columns: string[]): RoutineSessionColumns[] {
	const groups = new Map<string, RoutineSubtask[]>();
	const order: string[] = [];
	for (const column of columns) {
		if (column === ROUTINE_DATE_COLUMN) continue;
		const sep = column.indexOf(":");
		if (sep < 1) continue;
		const key = column.slice(0, sep).trim();
		const label = column.slice(sep + 1).trim();
		if (!key || !label) continue;
		if (!groups.has(key)) {
			groups.set(key, []);
			order.push(key);
		}
		groups.get(key)!.push({ column, label });
	}
	return order.map((key) => ({ key, subtasks: groups.get(key)! }));
}


/** The subtask columns for one session key, in header order. */
export function sessionSubtasks(columns: string[], key: string): RoutineSubtask[] {
	return deriveSessionColumns(columns).find((g) => g.key === key)?.subtasks ?? [];
}


/** Build the column name a session key + subtask label live under. */
export function makeColumnName(key: string, label: string): string {
	return `${key.trim()}:${label.trim()}`;
}


/** The row for a day, if the log has one. */
export function rowFor(data: RoutineData, date: string): RoutineRow | undefined {
	return data.rows.find((r) => r.date === date);
}


/** Whether one cell is ticked. */
export function tickValue(data: RoutineData, date: string, column: string): boolean {
	return rowFor(data, date)?.ticks[column] ?? false;
}


/** How many of `subtasks` are ticked on `date`. */
export function tickedCount(data: RoutineData, date: string, subtasks: RoutineSubtask[]): number {
	const row = rowFor(data, date);
	if (!row) return 0;
	return subtasks.reduce((n, s) => n + (row.ticks[s.column] ? 1 : 0), 0);
}


/** A copy of `data` with one cell set, adding the day's row if it is missing. */
export function setTick(
	data: RoutineData,
	date: string,
	column: string,
	value: boolean,
): RoutineData {
	const rows = data.rows.map((r) => ({ date: r.date, ticks: { ...r.ticks } }));
	let row = rows.find((r) => r.date === date);
	if (!row) {
		row = { date, ticks: {} };
		rows.push(row);
	}
	if (value) row.ticks[column] = true;
	else delete row.ticks[column];
	rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	return { columns: data.columns, rows };
}


/** A copy of `data` with a new subtask column appended. Idempotent — a column
 * that already exists is returned unchanged. */
export function addSubtaskColumn(data: RoutineData, column: string): RoutineData {
	if (data.columns.includes(column)) return data;
	return { columns: [...data.columns, column], rows: data.rows };
}


/**
 * Resolve a session's configured threshold against how many subtasks it
 * currently has. An unset mode means "every subtask"; a `count` is clamped to
 * at least 1, a `percent` to 1–100.
 */
export function resolveThreshold(
	total: number,
	mode: RoutineThresholdMode | undefined,
	value: number | undefined,
): RoutineThreshold {
	if (mode === "count") {
		return { mode: "count", value: Math.max(1, Math.round(value ?? total)) };
	}
	if (mode === "percent") {
		return { mode: "percent", value: Math.min(100, Math.max(1, Math.round(value ?? 100))) };
	}
	return { mode: "count", value: Math.max(1, total) };
}


/** Whether `ticked` of `total` subtasks meets the threshold. A session with no
 * subtasks is never "done". */
export function meetsThreshold(ticked: number, total: number, threshold: RoutineThreshold): boolean {
	if (total <= 0) return false;
	if (threshold.mode === "percent") return (ticked / total) * 100 >= threshold.value;
	return ticked >= Math.min(threshold.value, total);
}


/**
 * `current` with `dayKey` added (when `include`) or removed — de-duplicated,
 * sliced to date-only and sorted, the shape TaskNotes keeps `complete_instances`
 * in. Mirrors the recurring branch of TaskNotes' own completion edit.
 */
export function completeInstancesFor(
	current: string[],
	dayKey: string,
	include: boolean,
): string[] {
	const days = new Set(current.map((d) => d.slice(0, 10)));
	if (include) days.add(dayKey);
	else days.delete(dayKey);
	return [...days].sort();
}
