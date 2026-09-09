/**
 * Pure geometry and bucketing for the bar-style stat charts (issue: folder
 * distribution card, and the polar/weekday charts that will share it).
 *
 * No Obsidian imports and no DOM — every function here is a plain data
 * transform, so the maths is unit-tested directly (`test/chartbars.test.ts`).
 * The card module turns these numbers into SVG.
 *
 * Two layouts are supported from one `{ label, value }[]` input:
 *   - `barLayout`   — a horizontal bar list (label + bar), value → bar width;
 *   - `radialLayout` — bars fanned around a centre, value → bar length, drawn
 *     as annular sectors whose `d` attribute this file builds as a string.
 */

/** One datum going into a chart. */
export interface ChartDatum {
	label: string;
	value: number;
}

/** A datum after roll-up, carrying how many original entries it stands for
 * (`rolledFrom` > 1 only on the synthesised "Other" slice). */
export interface RolledDatum extends ChartDatum {
	rolledFrom: number;
}

/** Sort a copy of `items` by descending value (ties broken by label) or by
 * label. Never mutates the input. */
export function sortData(items: ChartDatum[], by: "count" | "name"): ChartDatum[] {
	const copy = items.slice();
	if (by === "name") {
		copy.sort((a, b) => a.label.localeCompare(b.label));
	} else {
		copy.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
	}
	return copy;
}

/**
 * Cap a series at `maxSlices` entries by keeping the largest `maxSlices - 1`
 * and summing the remainder into one trailing slice labelled `otherLabel`.
 * Input order is preserved for the kept slices; the roll-up slice is appended.
 * A non-positive or large-enough `maxSlices` returns every item untouched
 * (each with `rolledFrom: 1`).
 */
export function rollUp(items: ChartDatum[], maxSlices: number, otherLabel: string): RolledDatum[] {
	const tagged: RolledDatum[] = items.map((it) => ({ ...it, rolledFrom: 1 }));
	if (maxSlices <= 0 || tagged.length <= maxSlices) return tagged;

	// Rank by value to decide which slices survive, but emit the survivors in
	// their original order so a name-sorted chart stays name-sorted.
	const rankedIndices = tagged
		.map((it, i) => ({ i, value: it.value }))
		.sort((a, b) => b.value - a.value)
		.slice(0, maxSlices - 1)
		.map((r) => r.i);
	const keep = new Set(rankedIndices);

	const kept: RolledDatum[] = [];
	let otherValue = 0;
	let otherCount = 0;
	tagged.forEach((it, i) => {
		if (keep.has(i)) {
			kept.push(it);
		} else {
			otherValue += it.value;
			otherCount += 1;
		}
	});
	kept.push({ label: otherLabel, value: otherValue, rolledFrom: otherCount });
	return kept;
}

/**
 * The value a chart axis should top out at: `raw` rounded up to a 1/2/5·10ⁿ
 * step so bar lengths read against round numbers. Always ≥ 1. (Same rule as
 * the trend card's y-axis; kept local so this module stays dependency-free.)
 */
export function niceMax(raw: number): number {
	if (raw <= 5) return Math.max(1, Math.ceil(raw));
	const mag = 10 ** Math.floor(Math.log10(raw));
	const norm = raw / mag;
	const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
	return step * mag;
}


// ---- Horizontal bars ----------------------------------------------------

export interface BarRow {
	label: string;
	value: number;
	/** Bar length as a 0–1 fraction of the plot width. */
	fraction: number;
}

/** One row per datum: its value as a fraction of the axis max (`niceMax` of
 * the largest value unless `max` is given). Zero-value rows get a 0 fraction
 * rather than NaN. */
export function barLayout(items: ChartDatum[], max?: number): BarRow[] {
	const top = max && max > 0 ? max : niceMax(Math.max(1, ...items.map((it) => it.value)));
	return items.map((it) => ({
		label: it.label,
		value: it.value,
		fraction: Math.max(0, Math.min(1, it.value / top)),
	}));
}


// ---- Sparkline --------------------------------------------------------

/**
 * `points` for a `<polyline>` spanning `width`×`height`: `values` mapped so the
 * first sits at x=0 and the last at x=width, y flipped so the largest value is
 * at the top (`pad` px inset top and bottom). A flat series draws along the
 * middle. Fewer than two values yields "".
 */
export function sparklinePoints(values: number[], width: number, height: number, pad = 1): string {
	if (values.length < 2) return "";
	const max = Math.max(...values);
	const min = Math.min(...values);
	const range = max - min;
	const usable = height - pad * 2;
	const step = width / (values.length - 1);
	return values
		.map((v, i) => {
			const x = i * step;
			// A flat series has no range to map — sit it on the middle line.
			const y = range === 0 ? pad + usable / 2 : pad + usable * (1 - (v - min) / range);
			return `${x.toFixed(2)},${y.toFixed(2)}`;
		})
		.join(" ");
}


// ---- Radial (polar) bars ----------------------------------------------

/** A point on a circle. Angles are degrees clockwise from 12 o'clock, matching
 * how the chart reads. */
export function polarPoint(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
	const rad = ((angleDeg - 90) * Math.PI) / 180;
	return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/**
 * SVG path `d` for an annular sector (a "fat arc") between two radii and two
 * angles. Used for each radial bar: `rInner` is the hub, `rOuter` the bar's
 * scaled tip. Angles in degrees clockwise from top.
 */
export function annularSectorPath(
	cx: number,
	cy: number,
	rInner: number,
	rOuter: number,
	startAngle: number,
	endAngle: number,
): string {
	const large = Math.abs(endAngle - startAngle) > 180 ? 1 : 0;
	const oStart = polarPoint(cx, cy, rOuter, startAngle);
	const oEnd = polarPoint(cx, cy, rOuter, endAngle);
	const iEnd = polarPoint(cx, cy, rInner, endAngle);
	const iStart = polarPoint(cx, cy, rInner, startAngle);
	return [
		`M ${oStart.x.toFixed(3)} ${oStart.y.toFixed(3)}`,
		`A ${rOuter} ${rOuter} 0 ${large} 1 ${oEnd.x.toFixed(3)} ${oEnd.y.toFixed(3)}`,
		`L ${iEnd.x.toFixed(3)} ${iEnd.y.toFixed(3)}`,
		`A ${rInner} ${rInner} 0 ${large} 0 ${iStart.x.toFixed(3)} ${iStart.y.toFixed(3)}`,
		"Z",
	].join(" ");
}

export interface RadialBar {
	label: string;
	value: number;
	startAngle: number;
	endAngle: number;
	/** Bar tip radius, between `rInner` and `rInner + track`. */
	outerRadius: number;
	/** Path for the filled bar. */
	barPath: string;
	/** Path for the full-length track behind the bar (same wedge, max radius). */
	trackPath: string;
	/** Mid-angle, for placing a label. */
	midAngle: number;
}

export interface RadialOptions {
	cx: number;
	cy: number;
	rInner: number;
	/** Radial length available to a full-value bar. */
	track: number;
	/** Total angular span to distribute across the bars (default 360). */
	sweep?: number;
	/** Gap between adjacent wedges, in degrees (default 2). */
	padAngle?: number;
	/** Axis max; defaults to `niceMax` of the largest value. */
	max?: number;
}

/**
 * Lay every datum out as a radial bar of equal angular width around the
 * centre. `value` scales the bar's length from `rInner` to `rInner + track`;
 * everything else (paths, mid-angles) is derived so the card only has to set
 * attributes.
 */
export function radialLayout(items: ChartDatum[], opts: RadialOptions): RadialBar[] {
	const sweep = opts.sweep ?? 360;
	const pad = opts.padAngle ?? 2;
	const max = opts.max && opts.max > 0 ? opts.max : niceMax(Math.max(1, ...items.map((it) => it.value)));
	const n = items.length;
	const slice = n > 0 ? sweep / n : 0;

	return items.map((it, i) => {
		const start = i * slice + pad / 2;
		const end = (i + 1) * slice - pad / 2;
		const frac = Math.max(0, Math.min(1, it.value / max));
		const outerRadius = opts.rInner + frac * opts.track;
		return {
			label: it.label,
			value: it.value,
			startAngle: start,
			endAngle: end,
			outerRadius,
			midAngle: (start + end) / 2,
			barPath: annularSectorPath(opts.cx, opts.cy, opts.rInner, outerRadius, start, end),
			trackPath: annularSectorPath(opts.cx, opts.cy, opts.rInner, opts.rInner + opts.track, start, end),
		};
	});
}
