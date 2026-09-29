import { Setting } from "obsidian";
import { t } from "../i18n";
import { clearPeopleCadenceCache, renderPeopleCadenceCard } from "../peoplecadence";
import { type CardDefinition, type CardEditorContext } from "./definition";

export function peopleCadenceEditor(ctx: CardEditorContext, containerEl: HTMLElement): void {
	const cfg = (ctx.card.peopleCadence ??= {});
	const strings = t().editors.peopleCadence;

	new Setting(containerEl)
		.setName(strings.host)
		.setDesc(strings.hostDesc)
		.addText((txt) =>
			txt
				.setPlaceholder(strings.hostPlaceholder)
				.setValue(cfg.host ?? "")
				.onChange((value) => {
					const next = value.trim() || undefined;
					if (next !== cfg.host) clearPeopleCadenceCache(cfg);
					cfg.host = next;
					ctx.opts.save();
				}),
		);

	new Setting(containerEl)
		.setName(strings.token)
		.setDesc(strings.tokenDesc)
		.addText((txt) => {
			txt.setValue(cfg.token ?? "").onChange((value) => {
				// SECURITY-REVIEW: token remains in the password control and per-card
				// plugin data; it is never displayed elsewhere or logged.
				const next = value || undefined;
				if (next !== cfg.token) clearPeopleCadenceCache(cfg);
				cfg.token = next;
				ctx.opts.save();
			});
			txt.inputEl.type = "password";
			txt.inputEl.autocomplete = "off";
		});

	new Setting(containerEl)
		.setName(strings.count)
		.setDesc(strings.countDesc)
		.addText((txt) => {
			txt.setValue(String(cfg.count ?? 5)).onChange((value) => {
				const parsed = parseInt(value, 10);
				cfg.count = Number.isNaN(parsed) || parsed <= 0 ? undefined : Math.min(50, parsed);
				ctx.opts.save();
			});
			txt.inputEl.type = "number";
			txt.inputEl.min = "1";
			txt.inputEl.max = "50";
			txt.inputEl.addClass("hearth-count-input");
		});

	const numberSetting = (
		name: string,
		description: string,
		value: number,
		update: (next: number | undefined) => void,
	): void => {
		new Setting(containerEl)
			.setName(name)
			.setDesc(description)
			.addText((txt) => {
				txt.setValue(String(value)).onChange((raw) => {
					const parsed = parseInt(raw, 10);
					update(Number.isNaN(parsed) || parsed < 0 ? undefined : parsed);
					ctx.opts.save();
				});
				txt.inputEl.type = "number";
				txt.inputEl.min = "0";
				txt.inputEl.addClass("hearth-count-input");
			});
	};
	numberSetting(strings.refresh, strings.refreshDesc, cfg.refreshMin ?? 2, (value) => {
		cfg.refreshMin = value;
	});
	numberSetting(strings.cache, strings.cacheDesc, cfg.cacheMin ?? 1, (value) => {
		cfg.cacheMin = value;
	});
}

/** A read-only viewer for an external contact-cadence feed: who you're
 * drifting away from, by real logged contact. No decay/depth math happens
 * here — see src/peoplecadence.ts for why, and for the render/detail-modal
 * implementation this definition wraps. */
export const peopleCadenceCard: CardDefinition<"peopleCadence"> = {
	kind: "peopleCadence",
	templates: [
		{
			id: "peopleCadence",
			name: "People cadence",
			icon: "users",
			build: () => ({
				kind: "peopleCadence",
				title: "People cadence",
				peopleCadence: {
					count: 5,
					refreshMin: 2,
					cacheMin: 1,
				},
				w: 4,
				h: 4,
			}),
		},
	],
	render: (view, card, body, component) => renderPeopleCadenceCard(view, card, body, component),
	renderEditor: (container, ctx) => peopleCadenceEditor(ctx, container),
	cloneConfig: (source, copy) => {
		if (source.peopleCadence) copy.peopleCadence = { ...source.peopleCadence };
	},
	liveness: { mode: "static" },
};
