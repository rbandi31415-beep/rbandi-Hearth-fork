/**
 * Pure folder-bucketing for the folder-distribution card.
 *
 * No Obsidian imports — the card passes in a flat list of file paths and this
 * groups them by folder, so the drill-down logic is unit-tested directly
 * (`test/folderchart.test.ts`). Turning the buckets into a chart is the card's
 * job (via `chartbars.ts`).
 */

/** One slice of a folder-distribution chart. */
export interface FolderBucket {
	/** What the slice is called: a child folder's name, or `rootFilesLabel`
	 * for files sitting directly in the folder being viewed. */
	label: string;
	/** Full vault path of the folder this slice represents, or null for the
	 * "files directly here" slice. A non-null path is what you drill into. */
	path: string | null;
	/** Notes (or files) anywhere at or below this slice. */
	count: number;
	/** Whether drilling in would reveal further subfolders. */
	hasChildren: boolean;
}

/** Strip a trailing slash and a leading "./"; "" and "/" both mean the vault
 * root. */
export function normalizeFolder(folder: string): string {
	const trimmed = folder
		.trim()
		.replace(/^\.?\//, "")
		.replace(/\/+$/, "");
	return trimmed === "." ? "" : trimmed;
}

/** The path segments of `filePath` that sit below `root` ("" = vault root), or
 * null when the file isn't under `root` at all. */
function segmentsUnder(filePath: string, root: string): string[] | null {
	if (root === "") return filePath.split("/");
	if (!filePath.startsWith(root + "/")) return null;
	return filePath.slice(root.length + 1).split("/");
}

/**
 * Group `paths` into the immediate children of `root`: one bucket per direct
 * subfolder (counting everything beneath it), plus one bucket for files that
 * live directly in `root`. Buckets come out in first-seen order; the card
 * sorts them. A subfolder with no matching files never appears.
 */
export function bucketByFolder(paths: string[], root: string, rootFilesLabel: string): FolderBucket[] {
	const norm = normalizeFolder(root);
	const order: string[] = [];
	const counts = new Map<string, number>();
	const deeper = new Map<string, boolean>();
	let rootFiles = 0;

	for (const path of paths) {
		const segs = segmentsUnder(path, norm);
		if (!segs) continue;
		if (segs.length === 1) {
			rootFiles += 1;
			continue;
		}
		const child = segs[0];
		if (!counts.has(child)) {
			order.push(child);
			counts.set(child, 0);
			deeper.set(child, false);
		}
		counts.set(child, (counts.get(child) ?? 0) + 1);
		if (segs.length > 2) deeper.set(child, true);
	}

	const buckets: FolderBucket[] = order.map((child) => ({
		label: child,
		path: norm === "" ? child : `${norm}/${child}`,
		count: counts.get(child) ?? 0,
		hasChildren: deeper.get(child) ?? false,
	}));
	if (rootFiles > 0) {
		buckets.push({ label: rootFilesLabel, path: null, count: rootFiles, hasChildren: false });
	}
	return buckets;
}

/**
 * One bucket per configured root, each counting every file at or below it —
 * the top-level view when the card is pointed at several subtrees at once.
 * A root with no files is dropped.
 */
export function bucketRoots(paths: string[], roots: string[], vaultLabel: string): FolderBucket[] {
	return roots
		.map((root) => {
			const norm = normalizeFolder(root);
			let count = 0;
			let hasChildren = false;
			for (const path of paths) {
				const segs = segmentsUnder(path, norm);
				if (!segs) continue;
				count += 1;
				if (segs.length > 1) hasChildren = true;
			}
			return {
				label: norm === "" ? vaultLabel : (norm.split("/").pop() ?? norm),
				path: norm,
				count,
				hasChildren,
			};
		})
		.filter((bucket) => bucket.count > 0);
}

/** A breadcrumb step: `target` is the drill path to jump to, or null for the
 * card's initial view. */
export interface Crumb {
	label: string;
	target: string | null;
}

/**
 * The breadcrumb trail for a drill path. `homePath` is the single configured
 * root the drill is relative to, or null when the card started from a
 * several-roots view. The first crumb always jumps back to the initial view.
 */
export function drillCrumbs(homeLabel: string, homePath: string | null, drill: string | null): Crumb[] {
	const home: Crumb = { label: homeLabel, target: null };
	if (!drill) return [home];

	const base = homePath ? `${homePath}/` : "";
	let rel = drill;
	if (homePath) {
		if (drill === homePath) return [home];
		if (drill.startsWith(base)) rel = drill.slice(base.length);
	}

	const crumbs: Crumb[] = [home];
	let acc = homePath ?? "";
	for (const seg of rel.split("/").filter(Boolean)) {
		acc = acc ? `${acc}/${seg}` : seg;
		crumbs.push({ label: seg, target: acc });
	}
	return crumbs;
}
