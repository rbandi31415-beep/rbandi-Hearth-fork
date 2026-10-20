/**
 * "People cadence" — a read-only viewer for an external contact-cadence feed
 * (who you're drifting away from, based on real iMessage/group-chat/in-person
 * contact logged outside Hearth).
 *
 * This module does no computation of its own: depth, decay and half-life are
 * all calculated upstream by the feed. Everything here just parses, formats
 * and displays whatever the feed sends — matching the source's own guidance
 * that Hearth is a pure viewer over this data.
 *
 * The feed has no streaming-friendly shape Hearth can consume the way it
 * consumes other services: it is genuinely long-lived Server-Sent Events, and
 * Obsidian's `requestUrl` (used by every other network card, see jira.ts,
 * weather.ts, rss.ts) only resolves once a response completes, so it can't
 * hold a stream open. The feed's `/snapshot` endpoint exists specifically to
 * make this workable: a plain, non-streaming GET returning the same JSON this
 * card polls on an interval, exactly like Jira or the weather forecast.
 *
 * The card itself is a people × days heatmap (one row per person, one column
 * per day, cell color = that day's interaction score) — the same sticky-
 * label/scrolling-day-columns shape as the Routine card's grid
 * (src/cards/routine.ts), reused here for the same reason: a long history
 * belongs on one card, scrolled sideways, not squeezed to fit. A separate
 * "Filter" view (a plain sortable/filterable list, no chart) is reachable
 * from the card for narrowing down who you're looking at.
 */
import {
	type Component,
	moment as createMoment,
	Modal,
	requestUrl,
	type RequestUrlParam,
	setIcon,
} from "obsidian";
import { heatLevel } from "./cardbodies";
import { t } from "./i18n";
import {
	type DashboardCard,
	effectiveAutoRefreshMinutes,
	type PeopleCadenceConfig,
	type PeopleCadenceSort,
} from "./types";
import type { HomeView } from "./view";

/** How a person's most recent contact reached them. */
export type ContactMedium = "imessage" | "imessage_group" | "memory";

const CONTACT_MEDIA = new Set<ContactMedium>(["imessage", "imessage_group", "memory"]);

/** One person's entry from the feed, exactly as it sends it. */
export interface PersonCadenceEntry {
	personKey: string;
	displayName: string;
	depth: number;
	halfLifeDays: number;
	lastContactAt: string;
	lastMedium: ContactMedium;
	/** When decay was last applied to this person's depth. Optional/tolerant
	 * (not validation-gating) since it was added to the feed after the rest of
	 * this shape — see the note on parseSnapshot. */
	depthUpdatedAt: string | null;
}

/** moment's format-parse and the plain date arithmetic the heatmap's day
 * columns need aren't on the shared Moment shim used elsewhere in this
 * codebase (see rss.ts, dates.ts); assert them locally. */
interface CadenceMoment {
	clone(): CadenceMoment;
	subtract(amount: number, unit: string): CadenceMoment;
	startOf(unit: string): CadenceMoment;
	format(fmt?: string): string;
	isValid(): boolean;
	fromNow(): string;
}
interface MomentFn {
	(input?: string): CadenceMoment;
	(input: string, format: string, strict: boolean): CadenceMoment;
}
const moment = createMoment as unknown as MomentFn;

/** [r, g, b], 0–255 each — this module's own copy of the tiny color helpers
 * `src/cards/activityMetrics.ts` shares between the heatmap/trend cards. Not
 * imported from there deliberately: this module lives beside jira.ts/rss.ts
 * outside src/cards/, and those never reach into a cards/-only helper. */
type Rgb = [number, number, number];

/** Standard HSL → sRGB conversion (h in degrees, s/l in percent). */
function hslToRgb(h: number, s: number, l: number): Rgb {
	const sN = s / 100;
	const lN = l / 100;
	const k = (n: number) => (n + h / 30) % 12;
	const a = sN * Math.min(lN, 1 - lN);
	const f = (n: number) => lN - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}

function rgba([r, g, b]: Rgb, alpha: number): string {
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Fixed hue per medium — categorical, never cycled, so a color always means
 * the same medium everywhere in this card. Group chats read as a muted
 * version of iMessage's own hue (they're deliberately weak signal); memory
 * (a real-world moment logged in the vault) gets its own warm hue since it's
 * weighted far higher than either text channel. */
const MEDIUM_ORDER: ContactMedium[] = ["imessage", "imessage_group", "memory"];
function mediumRgb(medium: ContactMedium): Rgb {
	switch (medium) {
		case "imessage":
			return hslToRgb(205, 70, 55);
		case "imessage_group":
			return hslToRgb(205, 25, 65);
		case "memory":
			return hslToRgb(340, 62, 55);
	}
}

/** Fixed hue per direction — categorical, distinct from the medium hues above
 * so the corner mark never gets mistaken for the cell's own fill. "unknown"
 * has no color: a day the feed didn't say a direction for stays unmarked
 * rather than getting an invented fourth color. */
const DIRECTION_ORDER: Exclude<DayInitiator, "unknown">[] = ["me", "them", "mixed"];
function initiatorRgb(initiator: DayInitiator): Rgb | null {
	switch (initiator) {
		case "me":
			return hslToRgb(150, 55, 40);
		case "them":
			return hslToRgb(28, 80, 52);
		case "mixed":
			return hslToRgb(280, 50, 52);
		case "unknown":
			return null;
	}
}

/**
 * Parse the feed's JSON array defensively: an entry missing a required field,
 * carrying the wrong type, or naming an unrecognized medium is dropped rather
 * than shown half-broken or crashing the card. Order is preserved — the feed
 * already sends lowest-depth-first, and reordering it would be a (small) piece
 * of computation this module isn't meant to do.
 */
export function parseSnapshot(raw: unknown): PersonCadenceEntry[] {
	if (!Array.isArray(raw)) return [];
	const out: PersonCadenceEntry[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		const personKey = rec.person_key;
		const displayName = rec.display_name;
		const depth = rec.depth;
		const halfLifeDays = rec.half_life_days;
		const lastContactAt = rec.last_contact_at;
		const lastMedium = rec.last_medium;
		if (
			typeof personKey !== "string" ||
			!personKey ||
			typeof displayName !== "string" ||
			!displayName ||
			typeof depth !== "number" ||
			!Number.isFinite(depth) ||
			typeof halfLifeDays !== "number" ||
			!Number.isFinite(halfLifeDays) ||
			typeof lastContactAt !== "string" ||
			!lastContactAt ||
			typeof lastMedium !== "string" ||
			!CONTACT_MEDIA.has(lastMedium as ContactMedium)
		) {
			continue;
		}
		out.push({
			personKey,
			displayName,
			depth,
			halfLifeDays,
			lastContactAt,
			lastMedium: lastMedium as ContactMedium,
			depthUpdatedAt: typeof rec.depth_updated_at === "string" && rec.depth_updated_at ? rec.depth_updated_at : null,
		});
	}
	return out;
}

/** A single scored (or provisional) contact event, from `/interactions`. */
export type InteractionStatus = "pending_quality" | "scored";

export interface InteractionRow {
	id: string;
	personKey: string;
	displayName: string;
	medium: ContactMedium;
	occurredOn: string;
	deterministicScore: number;
	/** Null until the external quality pass (Grok Bot) fills it in. */
	qualityScore: number | null;
	status: InteractionStatus;
	folded: boolean;
	/** Who reached out. Null when the feed doesn't say (older rows, or a
	 * medium where direction isn't tracked). */
	initiatedByMe: boolean | null;
	/** How many messages made up this interaction. Null when not tracked for
	 * this row (e.g. a logged in-person memory isn't a message count). */
	messageCount: number | null;
	/** When the row itself was created, separate from `occurredOn` (the date
	 * the contact happened). Null if the feed doesn't send it. */
	createdAt: string | null;
}

/** A boolean that may have crossed the wire as a real JSON boolean or as the
 * 0/1 (or "true"/"false") a SQLite-backed API often serializes one as.
 * Anything else is genuinely unknown, not a guess. */
function normalizeBoolean(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (value === 1 || value === "1" || value === "true") return true;
	if (value === 0 || value === "0" || value === "false") return false;
	return null;
}

/** Parse `/interactions`' rows defensively, same drop-if-malformed rule as
 * `parseSnapshot`. Everything except the identity/scoring fields that define
 * what a row *is* (id, person, medium, date, status, deterministic score) is
 * optional/nullable on the wire and normalized rather than treated as a
 * reason to drop an otherwise-valid row — `initiated_by_me`/`message_count`/
 * `created_at` were added to the feed after the rest of this shape, and a
 * strict `typeof` gate on a newly-added field is exactly what silently
 * dropped every row here once already (see the `id`-as-number regression). */
export function parseInteractions(raw: unknown): InteractionRow[] {
	if (!Array.isArray(raw)) return [];
	const out: InteractionRow[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		// The feed sends id as a number; normalize it to a string since nothing
		// here does arithmetic on it, only identity comparisons.
		const id = typeof rec.id === "number" ? String(rec.id) : rec.id;
		const personKey = rec.person_key;
		const displayName = rec.display_name;
		const medium = rec.medium;
		const occurredOn = rec.occurred_on;
		const deterministicScore = rec.deterministic_score;
		const status = rec.status;
		if (
			typeof id !== "string" ||
			!id ||
			typeof personKey !== "string" ||
			!personKey ||
			typeof displayName !== "string" ||
			!displayName ||
			typeof medium !== "string" ||
			!CONTACT_MEDIA.has(medium as ContactMedium) ||
			typeof occurredOn !== "string" ||
			!occurredOn ||
			typeof deterministicScore !== "number" ||
			!Number.isFinite(deterministicScore) ||
			(status !== "pending_quality" && status !== "scored")
		) {
			continue;
		}
		const qualityScore = typeof rec.quality_score === "number" && Number.isFinite(rec.quality_score)
			? rec.quality_score
			: null;
		out.push({
			id,
			personKey,
			displayName,
			medium: medium as ContactMedium,
			occurredOn,
			deterministicScore,
			qualityScore,
			status,
			folded: typeof rec.folded_at === "string" && rec.folded_at.length > 0,
			initiatedByMe: normalizeBoolean(rec.initiated_by_me),
			messageCount:
				typeof rec.message_count === "number" && Number.isFinite(rec.message_count)
					? rec.message_count
					: null,
			createdAt: typeof rec.created_at === "string" && rec.created_at ? rec.created_at : null,
		});
	}
	return out;
}

/** The score this row actually contributes: the real quality score once it's
 * in, the provisional deterministic one until then. Never invents a number
 * the feed didn't send. */
export function interactionEffectiveScore(row: InteractionRow): number {
	return row.status === "scored" && row.qualityScore !== null ? row.qualityScore : row.deterministicScore;
}

/** Who reached out on a day that may have several interactions: "me"/"them"
 * when every row agrees, "mixed" when it went both ways, "unknown" when the
 * feed didn't say for any row that day (older data, or a medium that doesn't
 * track it). */
export type DayInitiator = "me" | "them" | "mixed" | "unknown";

function summarizeInitiator(rows: InteractionRow[]): DayInitiator {
	let sawMe = false;
	let sawThem = false;
	for (const row of rows) {
		if (row.initiatedByMe === true) sawMe = true;
		else if (row.initiatedByMe === false) sawThem = true;
	}
	if (sawMe && sawThem) return "mixed";
	if (sawMe) return "me";
	if (sawThem) return "them";
	return "unknown";
}

/** One day's worth of one person's contact, folded down to what the heatmap
 * cell needs: each medium's share of that day's total (for the color blend),
 * whether any of it is still awaiting a quality score (shown, but visually
 * marked provisional), who reached out, and how many messages it was. Pure
 * and independent of how it's painted, so it's unit-testable without
 * touching the DOM. */
export interface DayContactSummary {
	total: number;
	shareByMedium: Partial<Record<ContactMedium, number>>;
	pending: boolean;
	initiator: DayInitiator;
	/** Sum of every row's messageCount that day; rows with no count (e.g. a
	 * logged in-person memory) don't contribute. */
	totalMessages: number;
}

export function summarizeInteractionsByDay(rows: InteractionRow[]): Map<string, DayContactSummary> {
	const byDay = new Map<string, InteractionRow[]>();
	for (const row of rows) {
		const list = byDay.get(row.occurredOn);
		if (list) list.push(row);
		else byDay.set(row.occurredOn, [row]);
	}
	const out = new Map<string, DayContactSummary>();
	for (const [day, dayRows] of byDay) {
		const scoreByMedium = new Map<ContactMedium, number>();
		let total = 0;
		let pending = false;
		let totalMessages = 0;
		for (const row of dayRows) {
			const score = Math.max(0, interactionEffectiveScore(row));
			scoreByMedium.set(row.medium, (scoreByMedium.get(row.medium) ?? 0) + score);
			total += score;
			if (row.status === "pending_quality") pending = true;
			if (row.messageCount !== null) totalMessages += row.messageCount;
		}
		const shareByMedium: Partial<Record<ContactMedium, number>> = {};
		for (const [medium, score] of scoreByMedium) {
			shareByMedium[medium] = total > 0 ? score / total : 0;
		}
		out.set(day, { total, shareByMedium, pending, initiator: summarizeInitiator(dayRows), totalMessages });
	}
	return out;
}

/** `summarizeInteractionsByDay`, grouped by person first — what the card's
 * multi-person grid needs from one `/interactions` (whole-feed) response. */
export function summarizeInteractionsByPersonDay(
	rows: InteractionRow[],
): Map<string, Map<string, DayContactSummary>> {
	const byPerson = new Map<string, InteractionRow[]>();
	for (const row of rows) {
		const list = byPerson.get(row.personKey);
		if (list) list.push(row);
		else byPerson.set(row.personKey, [row]);
	}
	const out = new Map<string, Map<string, DayContactSummary>>();
	for (const [personKey, personRows] of byPerson) {
		out.set(personKey, summarizeInteractionsByDay(personRows));
	}
	return out;
}

/** Each person's total interaction score summed over exactly the day keys
 * given — the "activity" sort's ranking number. Days with no data for a
 * person simply don't add anything. */
export function activityTotals(
	byPersonDay: Map<string, Map<string, DayContactSummary>>,
	dayKeys: string[],
): Map<string, number> {
	const out = new Map<string, number>();
	for (const [personKey, dayMap] of byPersonDay) {
		let total = 0;
		for (const key of dayKeys) total += dayMap.get(key)?.total ?? 0;
		out.set(personKey, total);
	}
	return out;
}

/** A number formatted the way the card and filter list both show depth:
 * whole numbers bare, anything else to one decimal place. */
export function formatDepth(depth: number): string {
	if (!Number.isFinite(depth)) return "0";
	return Number.isInteger(depth) ? String(depth) : depth.toFixed(1);
}

/** "5 days ago via iMessage" — recency and medium, exactly as the feed sent
 * them, with no reweighting against depth or half-life. */
export function formatLastContact(entry: PersonCadenceEntry): string {
	const strings = t().cards.peopleCadence;
	const when = moment(entry.lastContactAt, "YYYY-MM-DD", true);
	const relative = when.isValid() ? when.fromNow() : entry.lastContactAt;
	const medium = strings.mediumLabels[entry.lastMedium] ?? entry.lastMedium;
	return strings.lastContactVia(relative, medium);
}

function validatedHost(host: string): URL {
	const parsed = new URL(host);
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) {
		throw new Error("invalid-host");
	}
	return parsed;
}

/** Build a feed URL under the configured host, refusing anything that could
 * send the request somewhere other than that exact origin. */
function buildFeedUrl(host: string, path: string, query?: Record<string, string>): URL {
	const parsedHost = validatedHost(host);
	const hostPath = parsedHost.pathname.replace(/\/+$/, "");
	const url = new URL(parsedHost.origin);
	url.pathname = `${hostPath}${path}`;
	for (const [key, value] of Object.entries(query ?? {})) {
		url.searchParams.set(key, value);
	}
	if (url.origin !== parsedHost.origin) throw new Error("cross-origin-request");
	return url;
}

/** The feed's snapshot URL — one row per person, lowest depth first. */
export function buildSnapshotUrl(host: string): URL {
	return buildFeedUrl(host, "/snapshot");
}

/** The feed's raw-interactions URL. `personKey` scopes it to one person's
 * rows; omitted (the card's own use), it's every person's — one request for
 * the whole grid instead of one per row. */
export function buildInteractionsUrl(host: string, personKey?: string): URL {
	const trimmed = personKey?.trim();
	return buildFeedUrl(host, "/interactions", trimmed ? { person_key: trimmed } : undefined);
}

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}
/** One cache per card connection, keyed by the exact request URL — so
 * `/snapshot` and `/interactions` both get independent entries without
 * needing separate maps. */
const cadenceCache = new WeakMap<PeopleCadenceConfig, Map<string, CacheEntry<unknown>>>();

function cacheGet<T>(config: PeopleCadenceConfig, key: string): T | null {
	const cache = cadenceCache.get(config);
	const entry = cache?.get(key) as CacheEntry<T> | undefined;
	if (!entry || entry.expiresAt <= Date.now()) {
		if (entry) cache?.delete(key);
		return null;
	}
	return entry.value;
}

function cacheSet<T>(config: PeopleCadenceConfig, key: string, value: T, ttl: number): void {
	if (ttl <= 0) return;
	let cache = cadenceCache.get(config);
	if (!cache) {
		cache = new Map<string, CacheEntry<unknown>>();
		cadenceCache.set(config, cache);
	}
	cache.set(key, { value, expiresAt: Date.now() + ttl });
}

function ttlMs(config: PeopleCadenceConfig): number {
	return Math.max(0, config.cacheMin ?? 1) * 60_000;
}

/** Drop every cached response for this card's connection object — called when
 * the host or token changes, so a stale response can't outlive them. */
export function clearPeopleCadenceCache(config: PeopleCadenceConfig): void {
	cadenceCache.delete(config);
}

function authHeader(config: PeopleCadenceConfig): string {
	// SECURITY-REVIEW: the bearer token is read from per-card plugin data and
	// sent only to the validated https origin configured for this card. It is
	// never logged or included in errors.
	return `Bearer ${config.token ?? ""}`;
}

async function getJson(config: PeopleCadenceConfig, url: URL): Promise<unknown> {
	const params: RequestUrlParam = {
		url: url.toString(),
		method: "GET",
		throw: false,
		headers: {
			Authorization: authHeader(config),
			Accept: "application/json",
		},
	};
	// SECURITY-REVIEW: request target is constructed by buildFeedUrl, restricted
	// to the configured HTTPS origin with a fixed relative path.
	const response = await requestUrl(params);
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`peoplecadence-http-${response.status}`);
	}
	return response.json;
}

/** Fetch (and cache) the current snapshot. `force` bypasses the cache — used
 * by manual refresh and the auto-refresh timer. */
export async function requestSnapshot(
	config: PeopleCadenceConfig,
	force = false,
): Promise<PersonCadenceEntry[]> {
	const url = buildSnapshotUrl(config.host ?? "");
	const key = url.toString();
	if (!force) {
		const cached = cacheGet<PersonCadenceEntry[]>(config, key);
		if (cached !== null) return cached;
	}
	const entries = parseSnapshot(await getJson(config, url));
	cacheSet(config, key, entries, ttlMs(config));
	return entries;
}

/** Fetch (and cache) raw interaction rows. Omitting `personKey` (the card's
 * own use) gets everyone's rows in one request. */
export async function requestInteractions(
	config: PeopleCadenceConfig,
	personKey?: string,
	force = false,
): Promise<InteractionRow[]> {
	const url = buildInteractionsUrl(config.host ?? "", personKey);
	const key = url.toString();
	if (!force) {
		const cached = cacheGet<InteractionRow[]>(config, key);
		if (cached !== null) return cached;
	}
	const raw = await getJson(config, url);
	const rows = parseInteractions(raw);
	// TEMP DIAGNOSTIC — remove once initiated_by_me's actual wire shape is
	// confirmed against normalizeBoolean's guesses (boolean, 0/1, "true"/"false").
	if (Array.isArray(raw) && raw.length) {
		const sample = raw.slice(0, 3).map((r) => (r as Record<string, unknown>)?.initiated_by_me);
		console.warn(
			"[peoplecadence] initiated_by_me sample " +
				JSON.stringify({ values: sample, types: sample.map((v) => typeof v) }),
		);
	}
	cacheSet(config, key, rows, ttlMs(config));
	return rows;
}

const DEFAULT_DAYS = 60;
const MAX_DAYS = 180;
const MIN_DAYS = 7;
const DEFAULT_COUNT = 10;
const MAX_COUNT = 50;
const DEFAULT_SORT: PeopleCadenceSort = "depth";

export function resolveDays(cfg: PeopleCadenceConfig): number {
	const raw = cfg.days ?? DEFAULT_DAYS;
	return Math.max(MIN_DAYS, Math.min(MAX_DAYS, raw));
}

export function resolveCount(cfg: PeopleCadenceConfig): number {
	const raw = cfg.count ?? DEFAULT_COUNT;
	return Math.max(1, Math.min(MAX_COUNT, raw));
}

/** The last `days` calendar days, oldest first, ending today. */
function lastDays(days: number): CadenceMoment[] {
	const today = moment().startOf("day");
	const out: CadenceMoment[] = [];
	for (let i = days - 1; i >= 0; i--) out.push(today.clone().subtract(i, "days"));
	return out;
}

/** Row order for the card's grid and the filter view's list.
 * - "depth": the feed's own lowest-first order — no recomputation.
 * - "name": alphabetical by display name.
 * - "activity": highest total interaction score (over the given window)
 *   first — a different signal than depth (recent volume, not decayed
 *   substance), which is exactly why it's offered as a separate lens.
 */
export function sortPeople(
	entries: PersonCadenceEntry[],
	sortBy: PeopleCadenceSort,
	activityByPerson?: Map<string, number>,
): PersonCadenceEntry[] {
	if (sortBy === "depth") return entries;
	if (sortBy === "name") return [...entries].sort((a, b) => a.displayName.localeCompare(b.displayName));
	return [...entries].sort(
		(a, b) => (activityByPerson?.get(b.personKey) ?? 0) - (activityByPerson?.get(a.personKey) ?? 0),
	);
}

/** Whole calendar days between `dateStr` (YYYY-MM-DD) and `nowMs`, or null if
 * it can't be parsed. Plain `Date` math rather than the module's own
 * `CadenceMoment`, so this (and the filter it backs) stays trivially testable
 * without touching a moment shim. */
function daysSince(dateStr: string, nowMs: number): number | null {
	const then = Date.parse(`${dateStr}T00:00:00Z`);
	if (Number.isNaN(then)) return null;
	const DAY_MS = 86_400_000;
	return Math.floor(nowMs / DAY_MS) - Math.floor(then / DAY_MS);
}

/** The filter view's narrowing criteria. Every field is optional/empty =
 * unfiltered; several combine with AND. */
export interface PeopleFilter {
	/** Case-insensitive substring match against display name. */
	search?: string;
	/** Keep a person only if their *last* contact medium is one of these
	 * (checked against /snapshot's own last_medium, not a full interaction
	 * history scan — see the card's design notes on why). Empty/undefined
	 * means no medium filter. */
	mediums?: Set<ContactMedium>;
	minDepth?: number;
	maxDepth?: number;
	/** Keep a person only if their last contact is at least this many days
	 * ago (0 or undefined = no recency filter). */
	minDaysSinceContact?: number;
}

export function filterPeople(
	entries: PersonCadenceEntry[],
	filter: PeopleFilter,
	nowMs: number = Date.now(),
): PersonCadenceEntry[] {
	const search = filter.search?.trim().toLocaleLowerCase();
	return entries.filter((person) => {
		if (search && !person.displayName.toLocaleLowerCase().includes(search)) return false;
		if (filter.mediums?.size && !filter.mediums.has(person.lastMedium)) return false;
		if (filter.minDepth !== undefined && person.depth < filter.minDepth) return false;
		if (filter.maxDepth !== undefined && person.depth > filter.maxDepth) return false;
		if (filter.minDaysSinceContact) {
			const since = daysSince(person.lastContactAt, nowMs);
			if (since === null || since < filter.minDaysSinceContact) return false;
		}
		return true;
	});
}

type CadenceStrings = ReturnType<typeof t>["cards"]["peopleCadence"];

/** A share-weighted RGB blend of every medium present on a day, each in its
 * own fixed hue — so a day led by an in-person moment reads warmer even when
 * a routine text also landed that day. */
function blendMediumColor(shareByMedium: Partial<Record<ContactMedium, number>>): Rgb {
	let r = 0;
	let g = 0;
	let b = 0;
	let shareTotal = 0;
	for (const medium of MEDIUM_ORDER) {
		const share = shareByMedium[medium] ?? 0;
		if (share <= 0) continue;
		const [mr, mg, mb] = mediumRgb(medium);
		r += mr * share;
		g += mg * share;
		b += mb * share;
		shareTotal += share;
	}
	if (shareTotal <= 0) return [128, 128, 128];
	return [Math.round(r / shareTotal), Math.round(g / shareTotal), Math.round(b / shareTotal)];
}

/**
 * The card's grid: one sticky-labeled row per person, one fixed-width column
 * per day, cell color a share-weighted blend of that day's medium(s) at an
 * alpha driven by that day's total effective score against the whole grid's
 * peak (one shared scale, so cells are comparable across people and days —
 * not just within one person's own row). A day still awaiting its quality
 * score is shown, using its provisional deterministic score, but dashed, so
 * "who's drifting" never reads as artificially quiet just because Grok Bot
 * hasn't caught up yet. Columns don't stretch to fit the card — width is
 * fixed and the grid scrolls sideways, the same shape as the Routine card's
 * grid (src/cards/routine.ts).
 */
function paintPeopleGrid(
	container: HTMLElement,
	people: PersonCadenceEntry[],
	byPersonDay: Map<string, Map<string, DayContactSummary>>,
	days: CadenceMoment[],
	strings: CadenceStrings,
): void {
	container.empty();
	const dayKeys = days.map((d) => d.format("YYYY-MM-DD"));
	const todayKey = dayKeys[dayKeys.length - 1];

	let peak = 1;
	for (const dayMap of byPersonDay.values()) {
		for (const key of dayKeys) peak = Math.max(peak, dayMap.get(key)?.total ?? 0);
	}

	const scroll = container.createDiv("hearth-peoplecadence-scroll");
	const grid = scroll.createDiv("hearth-peoplecadence-grid");
	grid.style.setProperty("--pc-days", String(dayKeys.length));

	grid.createDiv("hearth-peoplecadence-cell hearth-peoplecadence-corner");
	for (const day of days) {
		const key = day.format("YYYY-MM-DD");
		const head = grid.createDiv("hearth-peoplecadence-cell hearth-peoplecadence-dayhead");
		if (key === todayKey) head.addClass("is-today");
		head.setAttribute("aria-label", day.format("dddd, MMMM D"));
		head.setAttribute("title", day.format("MMM D, YYYY"));
	}

	for (const person of people) {
		const label = grid.createDiv("hearth-peoplecadence-cell hearth-peoplecadence-label");
		label.createSpan({ cls: "hearth-peoplecadence-label-name", text: person.displayName });
		label.createSpan({
			cls: "hearth-peoplecadence-label-depth",
			text: strings.depthLabel(formatDepth(person.depth)),
		});
		const updated = person.depthUpdatedAt ? moment(person.depthUpdatedAt) : null;
		const updatedSuffix = updated?.isValid() ? ` · ${strings.depthUpdated(updated.fromNow())}` : "";
		label.setAttribute("title", `${person.displayName} · ${formatLastContact(person)}${updatedSuffix}`);

		const dayMap = byPersonDay.get(person.personKey);
		for (const key of dayKeys) {
			const cell = grid.createDiv("hearth-peoplecadence-cell hearth-peoplecadence-daycell");
			if (key === todayKey) cell.addClass("is-today");
			const info = dayMap?.get(key);
			if (info && info.total > 0) {
				const rgb = blendMediumColor(info.shareByMedium);
				cell.style.backgroundColor = rgba(rgb, 0.15 + heatLevel(info.total, peak) * 0.2125);
				if (info.pending) cell.addClass("is-pending");
				const mediumNames = (Object.keys(info.shareByMedium) as ContactMedium[])
					.filter((m) => (info.shareByMedium[m] ?? 0) > 0)
					.map((m) => strings.mediumNames[m]);
				const dateLabel = moment(key, "YYYY-MM-DD", true).format("MMM D, YYYY");
				const parts = [
					person.displayName,
					dateLabel,
					`${mediumNames.join(", ")}${info.pending ? ` (${strings.pending})` : ""}`,
					strings.initiatorLabel[info.initiator],
				];
				if (info.totalMessages > 0) parts.push(strings.messageCount(info.totalMessages));
				const tooltip = parts.join(" · ");
				cell.setAttribute("title", tooltip);
				cell.setAttribute("aria-label", tooltip);
				const dirRgb = initiatorRgb(info.initiator);
				if (dirRgb) {
					const corner = cell.createDiv("hearth-peoplecadence-daycell-corner");
					corner.style.backgroundColor = rgba(dirRgb, 1);
				}
			}
		}
	}

	const legend = container.createDiv("hearth-peoplecadence-legend");
	for (const medium of MEDIUM_ORDER) {
		const entry = legend.createDiv("hearth-peoplecadence-legend-entry");
		const swatch = entry.createDiv("hearth-peoplecadence-legend-swatch");
		swatch.style.backgroundColor = rgba(mediumRgb(medium), 1);
		entry.createSpan({ text: strings.mediumNames[medium] });
	}

	const directionLegend = container.createDiv("hearth-peoplecadence-legend");
	for (const initiator of DIRECTION_ORDER) {
		const entry = directionLegend.createDiv("hearth-peoplecadence-legend-entry");
		const swatch = entry.createDiv("hearth-peoplecadence-legend-swatch hearth-peoplecadence-legend-swatch-corner");
		const rgb = initiatorRgb(initiator);
		if (rgb) swatch.style.backgroundColor = rgba(rgb, 1);
		entry.createSpan({ text: strings.initiatorNames[initiator] });
	}
}

const SORT_KEYS: PeopleCadenceSort[] = ["depth", "name", "activity"];

function sortLabel(strings: CadenceStrings, key: PeopleCadenceSort): string {
	switch (key) {
		case "depth":
			return strings.sortByDepth;
		case "name":
			return strings.sortByName;
		case "activity":
			return strings.sortByActivity;
	}
}

/** The filter view, reached from the card's "Filter" button: a plain
 * sortable list narrowed by name/medium/depth/recency. No chart here — the
 * card itself is the visualization; this is purely for cutting the list down
 * to the people you're actually looking for. */
class PeopleCadenceFilterModal extends Modal {
	private people: PersonCadenceEntry[] = [];
	private loading = true;
	private error = false;
	private sortBy: PeopleCadenceSort;

	private search = "";
	private mediums = new Set<ContactMedium>();
	private minDepth = "";
	private maxDepth = "";
	private minDaysSinceContact = "";

	constructor(
		private readonly view: HomeView,
		private readonly config: PeopleCadenceConfig,
	) {
		super(view.app);
		this.sortBy = config.sortBy ?? DEFAULT_SORT;
	}

	onOpen(): void {
		this.modalEl.addClass("hearth-peoplecadence-modal");
		this.titleEl.setText(t().cards.peopleCadence.filterTitle);
		this.paint();
		void this.load(false);
	}

	private async load(force: boolean): Promise<void> {
		this.loading = true;
		this.error = false;
		this.paint();
		try {
			this.people = await requestSnapshot(this.config, force);
		} catch {
			this.error = true;
		} finally {
			this.loading = false;
			this.paint();
		}
	}

	private paint(): void {
		const strings = t().cards.peopleCadence;
		this.contentEl.empty();

		const toolbar = this.contentEl.createDiv("hearth-peoplecadence-modal-toolbar");
		const search = toolbar.createEl("input", {
			cls: "hearth-peoplecadence-search",
			attr: { type: "search", placeholder: strings.searchPlaceholder, "aria-label": strings.searchPlaceholder },
		});
		search.value = this.search;
		search.addEventListener("input", () => {
			this.search = search.value;
			this.paintList(strings);
		});
		const refresh = toolbar.createEl("button", {
			cls: "hearth-peoplecadence-refreshbtn",
			attr: { "aria-label": strings.refresh },
		});
		setIcon(refresh, "refresh-cw");
		refresh.toggleClass("is-loading", this.loading);
		refresh.addEventListener("click", () => void this.load(true));

		const sortRow = this.contentEl.createDiv("hearth-peoplecadence-modal-toolbar");
		for (const key of SORT_KEYS) {
			const btn = sortRow.createEl("button", {
				cls: "hearth-peoplecadence-sortbtn",
				text: sortLabel(strings, key),
			});
			btn.toggleClass("is-active", this.sortBy === key);
			btn.addEventListener("click", () => {
				this.sortBy = key;
				this.paintList(strings);
			});
		}

		const filters = this.contentEl.createDiv("hearth-peoplecadence-filters");
		const mediumRow = filters.createDiv("hearth-peoplecadence-filter-mediums");
		for (const medium of MEDIUM_ORDER) {
			const chip = mediumRow.createEl("label", { cls: "hearth-peoplecadence-filter-chip" });
			const box = chip.createEl("input", { attr: { type: "checkbox" } });
			box.checked = this.mediums.has(medium);
			box.addEventListener("change", () => {
				if (box.checked) this.mediums.add(medium);
				else this.mediums.delete(medium);
				this.paintList(strings);
			});
			chip.createSpan({ text: strings.mediumNames[medium] });
		}

		const rangeRow = filters.createDiv("hearth-peoplecadence-filter-range");
		const minDepth = rangeRow.createEl("input", {
			cls: "hearth-count-input",
			attr: { type: "number", placeholder: strings.minDepth, "aria-label": strings.minDepth },
		});
		minDepth.value = this.minDepth;
		minDepth.addEventListener("input", () => {
			this.minDepth = minDepth.value;
			this.paintList(strings);
		});
		const maxDepth = rangeRow.createEl("input", {
			cls: "hearth-count-input",
			attr: { type: "number", placeholder: strings.maxDepth, "aria-label": strings.maxDepth },
		});
		maxDepth.value = this.maxDepth;
		maxDepth.addEventListener("input", () => {
			this.maxDepth = maxDepth.value;
			this.paintList(strings);
		});
		const recency = rangeRow.createEl("input", {
			cls: "hearth-count-input",
			attr: {
				type: "number",
				min: "0",
				placeholder: strings.minDaysSinceContact,
				"aria-label": strings.minDaysSinceContact,
			},
		});
		recency.value = this.minDaysSinceContact;
		recency.addEventListener("input", () => {
			this.minDaysSinceContact = recency.value;
			this.paintList(strings);
		});

		this.contentEl.createDiv({ cls: "hearth-peoplecadence-modal-list" });
		this.paintList(strings);
	}

	private currentFilter(): PeopleFilter {
		const minDepth = parseFloat(this.minDepth);
		const maxDepth = parseFloat(this.maxDepth);
		const minDays = parseInt(this.minDaysSinceContact, 10);
		return {
			search: this.search,
			mediums: this.mediums,
			minDepth: Number.isFinite(minDepth) ? minDepth : undefined,
			maxDepth: Number.isFinite(maxDepth) ? maxDepth : undefined,
			minDaysSinceContact: Number.isFinite(minDays) && minDays > 0 ? minDays : undefined,
		};
	}

	private paintList(strings: CadenceStrings): void {
		const list = this.contentEl.querySelector<HTMLElement>(".hearth-peoplecadence-modal-list");
		if (!list) return;
		list.empty();
		if (this.loading && !this.people.length) {
			list.createDiv({ cls: "hearth-peoplecadence-state", text: strings.loading });
			return;
		}
		if (this.error && !this.people.length) {
			list.createDiv({ cls: "hearth-peoplecadence-state", text: strings.error });
			return;
		}
		if (!this.people.length) {
			list.createDiv({ cls: "hearth-peoplecadence-state", text: strings.empty });
			return;
		}
		const filtered = filterPeople(this.people, this.currentFilter());
		if (!filtered.length) {
			list.createDiv({ cls: "hearth-peoplecadence-state", text: strings.noMatches });
			return;
		}
		for (const person of sortPeople(filtered, this.sortBy)) {
			const row = list.createDiv("hearth-peoplecadence-row");
			row.createDiv({ cls: "hearth-peoplecadence-name", text: person.displayName });
			row.createDiv({
				cls: "hearth-peoplecadence-depth",
				text: strings.depthLabel(formatDepth(person.depth)),
			});
			row.createDiv({ cls: "hearth-peoplecadence-meta", text: formatLastContact(person) });
		}
	}
}

/** Persist a config change (the card's own sort toggle) without a full
 * dashboard rebuild — same debounced-save shape as the Jira card's live
 * toolbar filters (src/jira.ts's persistSelections). */
function debouncedSave(view: HomeView, timerRef: { id: number }): void {
	window.clearTimeout(timerRef.id);
	timerRef.id = window.setTimeout(() => void view.plugin.saveData(view.plugin.settings), 300);
}

/** Render the card: a people × days heatmap grid with a sort toggle and a
 * button to the filter view. */
export function renderPeopleCadenceCard(
	view: HomeView,
	card: DashboardCard,
	body: HTMLElement,
	component: Component,
): void {
	const config = card.peopleCadence ?? {};
	const strings = t().cards.peopleCadence;
	const wrap = body.createDiv("hearth-peoplecadence");
	if (view.plugin.settings.disableExternalCalls) {
		wrap.createDiv({ cls: "hearth-peoplecadence-state", text: strings.disabled });
		return;
	}
	if (!config.host?.trim() || !config.token?.trim()) {
		wrap.createDiv({ cls: "hearth-peoplecadence-state", text: strings.notConfigured });
		return;
	}

	let destroyed = false;
	let loading = false;
	let error = false;
	let people: PersonCadenceEntry[] = [];
	let interactions: InteractionRow[] = [];
	const saveTimer = { id: 0 };

	const header = wrap.createDiv("hearth-peoplecadence-header");
	header.createSpan({ cls: "hearth-peoplecadence-title", text: strings.detailTitle });
	const sortRow = header.createDiv("hearth-peoplecadence-sortrow");
	const filterBtn = header.createEl("button", {
		cls: "hearth-peoplecadence-viewall",
		text: strings.filterButton,
	});
	filterBtn.addEventListener("click", () => new PeopleCadenceFilterModal(view, config).open());

	const grid = wrap.createDiv("hearth-peoplecadence-gridwrap");

	const paintSortRow = (): void => {
		sortRow.empty();
		const current = config.sortBy ?? DEFAULT_SORT;
		for (const key of SORT_KEYS) {
			const btn = sortRow.createEl("button", {
				cls: "hearth-peoplecadence-sortbtn",
				text: sortLabel(strings, key),
			});
			btn.toggleClass("is-active", current === key);
			btn.addEventListener("click", () => {
				if (config.sortBy === key) return;
				config.sortBy = key;
				paintSortRow();
				paint();
				debouncedSave(view, saveTimer);
			});
		}
	};

	const paint = (): void => {
		if (destroyed) return;
		grid.empty();
		if (loading && !people.length) {
			grid.createDiv({ cls: "hearth-peoplecadence-state", text: strings.loading });
			return;
		}
		if (error && !people.length) {
			grid.createDiv({ cls: "hearth-peoplecadence-state", text: strings.error });
			return;
		}
		if (!people.length) {
			grid.createDiv({ cls: "hearth-peoplecadence-state", text: strings.empty });
			return;
		}
		const days = lastDays(resolveDays(config));
		const dayKeys = days.map((d) => d.format("YYYY-MM-DD"));
		const byPersonDay = summarizeInteractionsByPersonDay(interactions);
		const sortBy = config.sortBy ?? DEFAULT_SORT;
		const ordered =
			sortBy === "activity"
				? sortPeople(people, sortBy, activityTotals(byPersonDay, dayKeys))
				: sortPeople(people, sortBy);
		paintPeopleGrid(grid, ordered.slice(0, resolveCount(config)), byPersonDay, days, strings);
	};

	const load = async (force: boolean): Promise<void> => {
		if (destroyed) return;
		loading = true;
		error = false;
		paint();
		try {
			const [snapshot, rows] = await Promise.all([
				requestSnapshot(config, force),
				requestInteractions(config, undefined, force),
			]);
			if (destroyed) return;
			people = snapshot;
			interactions = rows;
		} catch {
			if (destroyed) return;
			error = true;
		} finally {
			if (!destroyed) {
				loading = false;
				paint();
			}
		}
	};

	component.register(() => {
		destroyed = true;
		window.clearTimeout(saveTimer.id);
	});

	paintSortRow();
	paint();
	void load(false);

	const refreshMin = effectiveAutoRefreshMinutes(
		view.plugin.settings,
		Math.max(0, config.refreshMin ?? 0),
	);
	if (refreshMin > 0) {
		component.registerInterval(
			window.setInterval(() => void load(true), refreshMin * 60_000),
		);
	}
}
