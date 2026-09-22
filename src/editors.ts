import { Notice, Setting, type App } from "obsidian";
import { CARD_KINDS, cardDefinition } from "./cards";
import { type CardEditorContext } from "./cards/definition";
import { t } from "./i18n";
import { FolderPickerModal } from "./pickers";
import { HearthTabbedModal, type HearthModalTab } from "./tabbedmodal";
import {
	CARD_BORDER_WIDTH_MAX,
	effectiveCardBorderWidth,
	type CardKind,
	type DashboardCard,
	type HomeSettings,
} from "./types";
import { confirmAction } from "./ui";


export interface CardSettingsOptions {
	/** The plugin's global settings. Read-only as far as the editors are
	 * concerned: a couple of kind editors need the global field-name mappings
	 * (which frontmatter keys the TaskNotes source reads) to offer sensible
	 * choices, rather than guessing the defaults. */
	settings: HomeSettings;
	/** The global favorites list (shared by all favorites cards). */
	favorites: string[];
	/** Whether this card is currently pinned to all dashboards. */
	isPinned: boolean;
	/** Whether the global privacy setting blocks outbound requests. */
	externalCallsDisabled: boolean;
	/** Pin/unpin this card across all dashboards. */
	setPinned: (pinned: boolean) => void;
	/** Persist the current settings (no view rebuild). */
	save: () => void;
	/** Rebuild the dashboard view to reflect content/layout changes. */
	rerender: () => void;
	/** Remove this card from the dashboard. */
	remove: () => void;
	/** Other dashboards this card can be copied to (id + name). */
	otherDashboards: { id: string; name: string }[];
	/** Copy this card onto the end of another dashboard. */
	copyToDashboard: (targetId: string) => void;
}


/**
 * The single place to configure a card — opened from the card itself in arrange
 * mode. Covers kind, title, kind-specific content, colors and size so nothing
 * has to be hunted for in the plugin settings tab.
 *
 * Laid out as a tabbed modal (Content / Style / Layout) with a persistent
 * Remove/Done footer, so a card with a dense editor (tasks, RSS) stays as
 * navigable as a plain one.
 */
export class CardSettingsModal extends HearthTabbedModal {
	private card: DashboardCard;
	private opts: CardSettingsOptions;

	/** Per-open scratch space for kind editors (the RSS "add from GitHub" fields,
	 * the Jira load-cancellation counter). Survives the in-place rerenders that
	 * editors trigger, but is fresh for each modal open. */
	private session: Record<string, unknown> = {};

	constructor(app: App, card: DashboardCard, opts: CardSettingsOptions) {
		super(app);
		this.card = card;
		this.opts = opts;
	}

	/** Bundle the modal state a kind editor needs into a CardEditorContext. */
	private editorContext(): CardEditorContext {
		return {
			app: this.app,
			card: this.card,
			opts: this.opts,
			requestRender: () => this.render(),
			session: this.session,
		};
	}

	onOpen(): void {
		this.titleEl.setText(t().editors.title);
		this.hearthRenderShell();
	}

	/** Rebuild the modal in place, keeping the active tab. Kind-specific editors
	 * call this after a change that swaps which controls are shown. */
	private render(): void {
		this.hearthRenderShell();
	}

	protected hearthTabStorageKey(): string {
		return "hearth-card-settings-tab";
	}

	protected hearthTabs(): HearthModalTab[] {
		const tabs = t().editors.tabs;
		return [
			{ id: "content", label: tabs.content, icon: "square-pen" },
			{ id: "style", label: tabs.style, icon: "palette" },
			{ id: "layout", label: tabs.layout, icon: "layout-dashboard" },
		];
	}

	protected hearthRenderBody(body: HTMLElement, tabId: string): void {
		switch (tabId) {
			case "content":
				this.identitySection(body);
				this.contentSection(body);
				break;
			case "style":
				this.colorsSection(body);
				break;
			case "layout":
				this.sizeSection(body);
				this.pinSection(body);
				this.copySection(body);
				break;
		}
	}

	/** Type and title — what the card is, shown at the top of the Content tab. */
	private identitySection(containerEl: HTMLElement): void {
		const card = this.card;

		new Setting(containerEl)
			.setName(t().editors.type)
			.setDesc(t().editors.typeDesc)
			.addDropdown((d) => {
				CARD_KINDS.forEach((k) => {
					d.addOption(k, t().editors.kinds[k]);
				});
				d.setValue(card.kind).onChange((v) => {
					card.kind = v as CardKind;
					this.opts.save();
					this.render();
				});
			});

		// A note under the type dropdown, when the kind wants one (e.g. the leaf
		// card's "this runs a live view, it costs more" performance hint).
		cardDefinition(card).editorTypeNote?.(containerEl, this.opts.settings);

		new Setting(containerEl)
			.setName(t().editors.cardTitle)
			.setDesc(t().editors.cardTitleDesc)
			.addText((txt) =>
				txt
					.setPlaceholder(t().editors.cardTitlePlaceholder)
					.setValue(card.title ?? "")
					.onChange((v) => {
						card.title = v;
						this.opts.save();
					}),
			);
	}

	/** Persistent footer shared by every tab: remove the card, or close. */
	protected hearthRenderFooter(footer: HTMLElement): void {
		new Setting(footer)
			.addButton((b) => {
				b.setButtonText(t().editors.removeCard).onClick(() => {
					confirmAction(this.app, {
						title: t().editors.removeCardTitle,
						message: t().editors.removeCardMessage(
							this.card.title?.trim() || t().editors.thisCard,
						),
						confirmText: t().editors.removeCardConfirm,
						onConfirm: () => {
							this.opts.remove();
							this.close();
						},
					});
				});
				b.buttonEl.addClass("hearth-danger-btn");
			})
			.addButton((b) =>
				b
					.setButtonText(t().editors.done)
					.setCta()
					.onClick(() => this.close()),
			);
	}

	/** Kind-specific content controls — delegated to the card's own module. */
	private contentSection(containerEl: HTMLElement): void {
		cardDefinition(this.card).renderEditor?.(containerEl, this.editorContext());
	}

	private colorsSection(containerEl: HTMLElement): void {
		const card = this.card;
		const row = new Setting(containerEl)
			.setName(t().editors.colors.heading)
			.setDesc(t().editors.colors.headingDesc);

		row.addColorPicker((c) =>
			c.setValue(card.accent ?? "#7c5cff").onChange((v) => {
				card.accent = v;
				this.opts.save();
			}),
		);
		row.addExtraButton((b) =>
			b
				.setIcon("rotate-ccw")
				.setTooltip(t().editors.colors.clearAccent)
				.onClick(() => {
					card.accent = undefined;
					this.opts.save();
					this.render();
				}),
		);
		row.addColorPicker((c) =>
			c.setValue(card.background ?? "#000000").onChange((v) => {
				card.background = v;
				this.opts.save();
			}),
		);
		row.addExtraButton((b) =>
			b
				.setIcon("rotate-ccw")
				.setTooltip(t().editors.colors.clearBackground)
				.onClick(() => {
					card.background = undefined;
					this.opts.save();
					this.render();
				}),
		);

		const opacityRow = new Setting(containerEl)
			.setName(t().editors.colors.cardOpacity)
			.setDesc(t().editors.colors.cardOpacityDesc);
		opacityRow.addSlider((sl) =>
			sl
				.setLimits(0, 1, 0.05)
				.setValue(card.cardOpacity ?? 1)
				.setDynamicTooltip()
				.onChange((v) => {
					card.cardOpacity = v;
					this.opts.save();
					this.opts.rerender();
				}),
		);
		opacityRow.addExtraButton((b) =>
			b
				.setIcon("rotate-ccw")
				.setTooltip(t().editors.colors.useDashboardDefault)
				.onClick(() => {
					card.cardOpacity = undefined;
					this.opts.save();
					this.opts.rerender();
					this.render();
				}),
		);

		const blurRow = new Setting(containerEl)
			.setName(t().editors.colors.cardBlur)
			.setDesc(t().editors.colors.cardBlurDesc);
		blurRow.addSlider((sl) =>
			sl
				.setLimits(0, 24, 1)
				.setValue(card.cardBlur ?? 0)
				.setDynamicTooltip()
				.onChange((v) => {
					card.cardBlur = v;
					this.opts.save();
					this.opts.rerender();
				}),
		);
		blurRow.addExtraButton((b) =>
			b
				.setIcon("rotate-ccw")
				.setTooltip(t().editors.colors.useDashboardDefault)
				.onClick(() => {
					card.cardBlur = undefined;
					this.opts.save();
					this.opts.rerender();
					this.render();
				}),
		);

		const borderRow = new Setting(containerEl)
			.setName(t().editors.colors.cardBorderWidth)
			.setDesc(t().editors.colors.cardBorderWidthDesc);
		borderRow.addSlider((sl) =>
			sl
				.setLimits(0, CARD_BORDER_WIDTH_MAX, 1)
				.setValue(card.cardBorderWidth ?? effectiveCardBorderWidth(this.opts.settings))
				.setDynamicTooltip()
				.onChange((v) => {
					card.cardBorderWidth = v;
					this.opts.save();
					this.opts.rerender();
				}),
		);
		borderRow.addExtraButton((b) =>
			b
				.setIcon("rotate-ccw")
				.setTooltip(t().editors.colors.useDashboardDefault)
				.onClick(() => {
					card.cardBorderWidth = undefined;
					this.opts.save();
					this.opts.rerender();
					this.render();
				}),
		);
	}

	private sizeSection(containerEl: HTMLElement): void {
		const card = this.card;
		const row = new Setting(containerEl)
			.setName(t().editors.size.heading)
			.setDesc(t().editors.size.headingDesc);

		row.addText((txt) => {
			txt
				.setValue(String(Math.round((card.fw ?? 0.25) * 100)))
				.onChange((v) => {
					const n = parseInt(v, 10);
					if (Number.isNaN(n)) return;
					const fw = Math.max(2, Math.min(n, 100)) / 100;
					card.fw = fw;
					// Keep the card inside the board when it grows past the right edge.
					card.fx = Math.max(0, Math.min(card.fx ?? 0, 1 - fw));
					this.opts.save();
				});
			txt.inputEl.type = "number";
			txt.inputEl.addClass("hearth-count-input");
			txt.inputEl.setAttribute("aria-label", t().editors.size.widthAria);
		});
		row.addText((txt) => {
			txt.setValue(String(Math.round(card.fh ?? 184))).onChange((v) => {
				const n = parseInt(v, 10);
				if (Number.isNaN(n)) return;
				card.fh = Math.max(56, n);
				this.opts.save();
			});
			txt.inputEl.type = "number";
			txt.inputEl.addClass("hearth-count-input");
			txt.inputEl.setAttribute("aria-label", t().editors.size.heightAria);
		});
		addResetButton(this.editorContext(), row, t().editors.resetSize, () => {
			card.fw = undefined;
			card.fh = undefined;
		});
	}

	/** Pin/unpin this card so it appears on every dashboard. */
	private pinSection(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t().editors.pin.heading)
			.setDesc(t().editors.pin.headingDesc)
			.addToggle((t) =>
				t.setValue(this.opts.isPinned).onChange((v) => {
					this.opts.setPinned(v);
					this.opts.isPinned = v;
					this.opts.save();
				}),
			);
	}

	/** Copy this card (with its current content and settings) onto the end of
	 * another dashboard. The original stays in place. */
	private copySection(containerEl: HTMLElement): void {
		const targets = this.opts.otherDashboards;
		if (targets.length === 0) return;
		const row = new Setting(containerEl)
			.setName(t().editors.copy.heading)
			.setDesc(t().editors.copy.headingDesc);
		let dropdown: { getValue(): string } | null = null;
		row.addDropdown((d) => {
			for (const t of targets) d.addOption(t.id, t.name);
			dropdown = d;
		});
		row.addButton((b) =>
			b
				.setButtonText(t().editors.copy.copy)
				.setTooltip(t().editors.copy.copyTooltip)
				.onClick(() => {
					const id = dropdown?.getValue();
					if (!id) return;
					this.opts.copyToDashboard(id);
					new Notice(t().notices.cardCopied);
				}),
		);
	}

	onClose(): void {
		// Invalidate any in-flight Jira filter load so its result is dropped.
		this.session.jiraLoadVersion = ((this.session.jiraLoadVersion as number) ?? 0) + 1;
		this.contentEl.empty();
		this.opts.rerender();
	}
}


/** Add a reset (rotate-ccw) extra button that clears a field back to its
 * default, then saves and redraws so the input reflects the restored value. */
export function addResetButton(ctx: CardEditorContext, 
	setting: Setting,
	tooltip: string,
	onReset: () => void,
): void {
	setting.addExtraButton((b) =>
		b
			.setIcon("rotate-ccw")
			.setTooltip(tooltip)
			.onClick(() => {
				onReset();
				ctx.opts.save();
				ctx.requestRender();
			}),
	);
}


/**
 * A whole-number text field with the same ergonomics as an `addSlider` + reset
 * pair — for values you want to type exactly rather than drag to. `set`
 * receives the clamped integer on every valid edit; `clear` restores the
 * default (the reset button, and clearing the field then blurring). The field
 * re-normalises its displayed value on blur, so an out-of-range or non-integer
 * entry is corrected in place.
 */
export function addNumberField(
	ctx: CardEditorContext,
	setting: Setting,
	opts: {
		value: number;
		min: number;
		max: number;
		default: number;
		placeholder?: string;
		set: (n: number) => void;
		clear: () => void;
		/** Also redraw the card on every change (a live preview), the way a few
		 * sliders do. Off by default — most number fields apply on modal close. */
		rerender?: boolean;
	},
): void {
	const clamp = (n: number): number => Math.max(opts.min, Math.min(opts.max, Math.round(n)));
	const applied = (): void => {
		ctx.opts.save();
		if (opts.rerender) ctx.opts.rerender();
	};

	setting.addText((txt) => {
		txt.setValue(String(opts.value));
		if (opts.placeholder) txt.setPlaceholder(opts.placeholder);
		txt.onChange((raw) => {
			const trimmed = raw.trim();
			if (trimmed === "") return; // settled on blur
			const n = Number(trimmed);
			if (!Number.isFinite(n)) return;
			opts.set(clamp(n));
			applied();
		});

		const input = txt.inputEl;
		input.type = "number";
		input.inputMode = "numeric";
		input.min = String(opts.min);
		input.max = String(opts.max);
		input.addClass("hearth-count-input");
		input.addEventListener("blur", () => {
			const trimmed = input.value.trim();
			if (trimmed === "") {
				opts.clear();
				applied();
				ctx.requestRender();
				return;
			}
			const n = clamp(Number(trimmed) || opts.default);
			input.value = String(n);
			opts.set(n);
			applied();
		});
	});

	setting.addExtraButton((b) =>
		b
			.setIcon("rotate-ccw")
			.setTooltip(t().settings.resetSlider)
			.onClick(() => {
				opts.clear();
				applied();
				ctx.requestRender();
			}),
	);
}


/** Move an item within a list, then persist and re-render the editor. */
export function moveItem<T>(ctx: CardEditorContext, arr: T[], from: number, to: number): void {
	if (to < 0 || to >= arr.length) return;
	const [item] = arr.splice(from, 1);
	arr.splice(to, 0, item);
	ctx.opts.save();
	ctx.requestRender();
}


/**
 * A reorderable list of vault folders — "restrict to these folders" scoping
 * shared by any card whose pool can be narrowed to more than one place
 * (recent files, random note). One row per folder (path text + picker +
 * remove), plus an "Add folder" button. An empty/undefined list means no
 * restriction — the card's own render code decides what that means.
 */
export function folderListEditor(
	ctx: CardEditorContext,
	containerEl: HTMLElement,
	get: () => string[],
	set: (folders: string[] | undefined) => void,
): void {
	const commit = (folders: string[]): void => {
		const cleaned = folders.map((f) => f.trim()).filter((f) => f.length > 0);
		set(cleaned.length > 0 ? cleaned : undefined);
	};

	const folders = get();
	folders.forEach((folder, index) => {
		const row = new Setting(containerEl).setClass("hearth-link-setting");
		row.addText((txt) =>
			txt
				.setPlaceholder(t().editors.folderList.placeholder)
				.setValue(folder)
				.onChange((v) => {
					folders[index] = v;
					commit(folders);
					ctx.opts.save();
				}),
		);
		row.addExtraButton((b) =>
			b
				.setIcon("folder-symlink")
				.setTooltip(t().editors.folderList.pick)
				.onClick(() => {
					new FolderPickerModal(ctx.app, (f) => {
						folders[index] = f.path === "/" ? "" : f.path;
						commit(folders);
						ctx.opts.save();
						ctx.requestRender();
					}).open();
				}),
		);
		row.addExtraButton((b) =>
			b
				.setIcon("trash-2")
				.setTooltip(t().editors.folderList.remove)
				.onClick(() => {
					folders.splice(index, 1);
					commit(folders);
					ctx.opts.save();
					ctx.requestRender();
				}),
		);
	});

	new Setting(containerEl).addButton((b) =>
		b.setButtonText(t().editors.folderList.add).onClick(() => {
			new FolderPickerModal(ctx.app, (f) => {
				commit([...folders, f.path === "/" ? "" : f.path]);
				ctx.opts.save();
				ctx.requestRender();
			}).open();
		}),
	);
}
