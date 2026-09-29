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
 */
import {
	type Component,
	moment as createMoment,
	Modal,
	requestUrl,
	type RequestUrlParam,
	setIcon,
} from "obsidian";
import { t } from "./i18n";
import {
	type DashboardCard,
	effectiveAutoRefreshMinutes,
	type PeopleCadenceConfig,
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
}

/** moment's format-parse and `.fromNow()` aren't on the shared Moment shim
 * used elsewhere in this codebase (see rss.ts); assert them locally. */
interface CadenceMoment {
	isValid(): boolean;
	fromNow(): string;
}
interface MomentFn {
	(input: string, format: string, strict: boolean): CadenceMoment;
}
const moment = createMoment as unknown as MomentFn;

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
		});
	}
	return out;
}

/** A number formatted the way the compact card and detail list both show
 * depth: whole numbers bare, anything else to one decimal place. */
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

/** Build the feed's snapshot URL from the configured host, refusing anything
 * that could send the request somewhere other than that exact origin. */
export function buildSnapshotUrl(host: string): URL {
	const parsedHost = validatedHost(host);
	const hostPath = parsedHost.pathname.replace(/\/+$/, "");
	const url = new URL(parsedHost.origin);
	url.pathname = `${hostPath}/snapshot`;
	if (url.origin !== parsedHost.origin) throw new Error("cross-origin-request");
	return url;
}

interface CacheEntry {
	value: PersonCadenceEntry[];
	expiresAt: number;
}
const snapshotCache = new WeakMap<PeopleCadenceConfig, CacheEntry>();

function ttlMs(config: PeopleCadenceConfig): number {
	return Math.max(0, config.cacheMin ?? 1) * 60_000;
}

/** Drop the cached snapshot for this card's connection object — called when
 * the host or token changes, so a stale response can't outlive them. */
export function clearPeopleCadenceCache(config: PeopleCadenceConfig): void {
	snapshotCache.delete(config);
}

function authHeader(config: PeopleCadenceConfig): string {
	// SECURITY-REVIEW: the bearer token is read from per-card plugin data and
	// sent only to the validated https origin configured for this card. It is
	// never logged or included in errors.
	return `Bearer ${config.token ?? ""}`;
}

/** Fetch (and cache) the current snapshot. `force` bypasses the cache — used
 * by manual refresh and the auto-refresh timer. */
export async function requestSnapshot(
	config: PeopleCadenceConfig,
	force = false,
): Promise<PersonCadenceEntry[]> {
	if (!force) {
		const cached = snapshotCache.get(config);
		if (cached && cached.expiresAt > Date.now()) return cached.value;
	}
	const url = buildSnapshotUrl(config.host ?? "");
	const params: RequestUrlParam = {
		url: url.toString(),
		method: "GET",
		throw: false,
		headers: {
			Authorization: authHeader(config),
			Accept: "application/json",
		},
	};
	// SECURITY-REVIEW: request target is constructed by buildSnapshotUrl,
	// restricted to the configured HTTPS origin with a fixed relative path.
	const response = await requestUrl(params);
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`peoplecadence-http-${response.status}`);
	}
	const entries = parseSnapshot(response.json);
	const ttl = ttlMs(config);
	if (ttl > 0) snapshotCache.set(config, { value: entries, expiresAt: Date.now() + ttl });
	return entries;
}

/** Sort keys the detail modal offers. "depth" keeps the feed's own
 * lowest-first order (no recomputation); "recency" reorders by last-contact
 * date, oldest first — the other lens on the same drift question. */
type SortKey = "depth" | "recency";

function sortEntries(entries: PersonCadenceEntry[], key: SortKey): PersonCadenceEntry[] {
	if (key === "depth") return entries;
	return [...entries].sort((a, b) => a.lastContactAt.localeCompare(b.lastContactAt));
}

function paintPeopleRows(
	list: HTMLElement,
	entries: PersonCadenceEntry[],
	strings: ReturnType<typeof t>["cards"]["peopleCadence"],
): void {
	for (const person of entries) {
		const row = list.createDiv("hearth-peoplecadence-row");
		row.createDiv({ cls: "hearth-peoplecadence-name", text: person.displayName });
		row.createDiv({
			cls: "hearth-peoplecadence-depth",
			text: strings.depthLabel(formatDepth(person.depth)),
		});
		row.createDiv({ cls: "hearth-peoplecadence-meta", text: formatLastContact(person) });
	}
}

/** The full-list detail view, reached from the card's "View all" button.
 * Fetches (through the same cache) rather than reusing the card's in-memory
 * copy, so opening it always reflects what's actually cached/fresh. */
class PeopleCadenceDetailModal extends Modal {
	private people: PersonCadenceEntry[] = [];
	private loading = true;
	private error = false;
	private sortKey: SortKey = "depth";

	constructor(
		private readonly view: HomeView,
		private readonly config: PeopleCadenceConfig,
	) {
		super(view.app);
	}

	onOpen(): void {
		this.modalEl.addClass("hearth-peoplecadence-modal");
		this.titleEl.setText(t().cards.peopleCadence.detailTitle);
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
		const sortDepth = toolbar.createEl("button", {
			cls: "hearth-peoplecadence-sortbtn",
			text: strings.sortByDepth,
		});
		const sortRecency = toolbar.createEl("button", {
			cls: "hearth-peoplecadence-sortbtn",
			text: strings.sortByRecency,
		});
		sortDepth.toggleClass("is-active", this.sortKey === "depth");
		sortRecency.toggleClass("is-active", this.sortKey === "recency");
		sortDepth.addEventListener("click", () => {
			this.sortKey = "depth";
			this.paint();
		});
		sortRecency.addEventListener("click", () => {
			this.sortKey = "recency";
			this.paint();
		});
		const refresh = toolbar.createEl("button", {
			cls: "hearth-peoplecadence-refreshbtn",
			attr: { "aria-label": strings.refresh },
		});
		setIcon(refresh, "refresh-cw");
		refresh.toggleClass("is-loading", this.loading);
		refresh.addEventListener("click", () => void this.load(true));

		const list = this.contentEl.createDiv("hearth-peoplecadence-modal-list");
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
		paintPeopleRows(list, sortEntries(this.people, this.sortKey), strings);
	}
}

/** Render the compact card: the top N lowest-depth people, name / depth /
 * human recency, plus a button to the full sortable list. */
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

	const header = wrap.createDiv("hearth-peoplecadence-header");
	header.createSpan({ cls: "hearth-peoplecadence-title", text: strings.detailTitle });
	const viewAll = header.createEl("button", {
		cls: "hearth-peoplecadence-viewall",
		text: strings.viewAll,
	});
	viewAll.addEventListener("click", () => new PeopleCadenceDetailModal(view, config).open());

	const list = wrap.createDiv("hearth-peoplecadence-list");

	const paint = (): void => {
		if (destroyed) return;
		list.empty();
		if (loading && !people.length) {
			list.createDiv({ cls: "hearth-peoplecadence-state", text: strings.loading });
			return;
		}
		if (error && !people.length) {
			list.createDiv({ cls: "hearth-peoplecadence-state", text: strings.error });
			return;
		}
		if (!people.length) {
			list.createDiv({ cls: "hearth-peoplecadence-state", text: strings.empty });
			return;
		}
		const count = Math.max(1, Math.min(50, config.count ?? 5));
		paintPeopleRows(list, people.slice(0, count), strings);
	};

	const load = async (force: boolean): Promise<void> => {
		if (destroyed) return;
		loading = true;
		error = false;
		paint();
		try {
			const entries = await requestSnapshot(config, force);
			if (destroyed) return;
			people = entries;
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
	});

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
