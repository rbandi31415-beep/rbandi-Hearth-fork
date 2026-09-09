/**
 * Pure logic for the "New notes" card: given every note's creation time and
 * the fields needed to test a scope, work out how many landed in the last N
 * days, how that compares with the N days before, and the per-day series.
 *
 * No Obsidian imports — the card builds the `NoteRecord[]` from the metadata
 * cache and passes it in, so the windowing and scope matching are unit-tested
 * directly (`test/newnotes.test.ts`).
 */

/** Everything the scope test and the windowing need about one note. */
export interface NoteRecord {
	path: string;
	/** Folder path, "" for a note at the vault root. */
	folder: string;
	/** Creation time, epoch ms. */
	ctime: number;
	/** Tags (frontmatter + inline), lower-cased, without the leading "#". */
	tags: string[];
	/** Raw frontmatter, or an empty object. */
	frontmatter: Record<string, unknown>;
}

/** What makes a note count. One card, one scope. */
export type NewNotesScope =
	| { kind: "tag"; tag: string }
	| { kind: "folder"; folder: string }
	| { kind: "property"; key: string; value?: string };

const MS_PER_DAY = 86_400_000;

/** A frontmatter value as a list of comparable strings: a scalar becomes one
 * entry, a YAML list becomes its entries, everything else nothing. */
function fmStrings(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.filter((v) => v != null).map((v) => String(v).trim().toLowerCase());
	if (raw == null || typeof raw === "object") return [];
	return [String(raw).trim().toLowerCase()];
}

/** Whether a note falls in the card's scope. */
export function inScope(note: NoteRecord, scope: NewNotesScope): boolean {
	if (scope.kind === "tag") {
		const needle = scope.tag.trim().replace(/^#/, "").toLowerCase();
		if (!needle) return false;
		// A tag matches its own subtags too ("project" catches "project/work").
		return note.tags.some((t) => t === needle || t.startsWith(`${needle}/`));
	}
	if (scope.kind === "folder") {
		const folder = scope.folder.trim().replace(/^\.?\//, "").replace(/\/+$/, "");
		if (folder === "" || folder === ".") return true;
		return note.folder === folder || note.folder.startsWith(`${folder}/`);
	}
	const key = scope.key.trim();
	if (!key) return false;
	if (!(key in note.frontmatter)) return false;
	const wanted = scope.value?.trim().toLowerCase();
	if (!wanted) return true;
	return fmStrings(note.frontmatter[key]).includes(wanted);
}

export interface NewNotesResult {
	/** In-scope notes created in `[now - days, now]`. */
	count: number;
	/** In-scope notes created in the `days` before that window. */
	previous: number;
	/** `count - previous`. */
	delta: number;
	/** One entry per day of the current window, oldest first. */
	series: number[];
	/** The in-window notes, newest first. */
	recent: NoteRecord[];
}

/**
 * Summarise a note list against a scope and an N-day window ending at `now`.
 * Day boundaries are whole `now`-relative 24h steps, not calendar midnights —
 * "last 30 days" means the last 30×24h, matching how a dashboard reads.
 */
export function summarise(
	notes: NoteRecord[],
	scope: NewNotesScope,
	days: number,
	now: number,
): NewNotesResult {
	const span = Math.max(1, Math.floor(days));
	const windowStart = now - span * MS_PER_DAY;
	const prevStart = windowStart - span * MS_PER_DAY;

	const series = new Array<number>(span).fill(0);
	const recent: NoteRecord[] = [];
	let count = 0;
	let previous = 0;

	for (const note of notes) {
		if (!inScope(note, scope)) continue;
		const { ctime } = note;
		if (ctime > now) continue;
		if (ctime >= windowStart) {
			count += 1;
			recent.push(note);
			const dayIndex = Math.min(span - 1, Math.floor((ctime - windowStart) / MS_PER_DAY));
			series[dayIndex] += 1;
		} else if (ctime >= prevStart) {
			previous += 1;
		}
	}

	recent.sort((a, b) => b.ctime - a.ctime);
	return { count, previous, delta: count - previous, series, recent };
}
