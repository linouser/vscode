/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatEditorOverlay.css';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable, IReader, ISettableObservable, ITransaction, observableFromEvent, observableSignal, observableValue, transaction } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { ICodeEditor, IOverlayWidget, IOverlayWidgetPosition, OverlayWidgetPositionPreference } from '../../../../editor/browser/editorBrowser.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar, WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ChatEditingSessionState, ICellDiffInfo, IChatEditingService, IChatEditingSession, IModifiedFileEntry, isTextFileEntry, WorkingSetEntryState } from '../common/chatEditingService.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IActionRunner } from '../../../../base/common/actions.js';
import { EventLike, getWindow, reset, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { assertType } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { AcceptAction, openChatEntry, RejectAction } from './chatEditorActions.js';
import { getChatEditorController } from './chatEditorControllerHelper.js';
import { Position } from '../../../../editor/common/core/position.js';
import { ChatEditorController } from './chatEditorController.js';

export class ChatEditorOverlayWidget implements IOverlayWidget {

	readonly allowEditorOverflow = false;

	private readonly _domNode: HTMLElement;
	private readonly _progressNode: HTMLElement;
	private readonly _toolbar: WorkbenchToolBar;

	private _isAdded: boolean = false;
	private readonly _showStore = new DisposableStore();

	private readonly _entry = observableValue<{ entry: IModifiedFileEntry; next: IModifiedFileEntry } | undefined>(this, undefined);

	private readonly _navigationBearings = observableValue<{ changeCount: number; activeIdx: number; entriesCount: number }>(this, { changeCount: -1, activeIdx: -1, entriesCount: -1 });

	constructor(
		private readonly currentChange: IObservable<{ diffInfo: ICellDiffInfo; cellPosition: Position | undefined } | Position | undefined, unknown>,
		focusEditor: () => void,
		unlockScroll: () => void,
		@IEditorService editorService: IEditorService,
		@IInstantiationService instaService: IInstantiationService,
	) {
		this._domNode = document.createElement('div');
		this._domNode.classList.add('chat-editor-overlay-widget');

		this._progressNode = document.createElement('div');
		this._progressNode.classList.add('chat-editor-overlay-progress');
		this._domNode.appendChild(this._progressNode);

		const toolbarNode = document.createElement('div');
		toolbarNode.classList.add('chat-editor-overlay-toolbar');
		this._domNode.appendChild(toolbarNode);

		this._toolbar = instaService.createInstance(MenuWorkbenchToolBar, toolbarNode, MenuId.ChatEditingEditorContent, {
			telemetrySource: 'chatEditor.overlayToolbar',
			hiddenItemStrategy: HiddenItemStrategy.Ignore,
			toolbarOptions: {
				primaryGroup: () => true,
				useSeparatorsInPrimaryActions: true
			},
			menuOptions: { renderShortTitle: true },
			actionViewItemProvider: (action, options) => {
				const that = this;

				if (action.id === navigationBearingFakeActionId) {
					return new class extends ActionViewItem {

						constructor() {
							super(undefined, action, { ...options, icon: false, label: true, keybindingNotRenderedWithLabel: true });
						}

						override render(container: HTMLElement) {
							super.render(container);

							container.classList.add('label-item');

							this._store.add(autorun(r => {
								assertType(this.label);

								const { changeCount, activeIdx } = that._navigationBearings.read(r);
								const n = activeIdx === -1 ? '?' : `${activeIdx + 1}`;
								const m = changeCount === -1 ? '?' : `${changeCount}`;
								this.label.innerText = localize('nOfM', "{0} of {1}", n, m);

								this.updateTooltip();
							}));
						}

						protected override getTooltip(): string | undefined {
							const { changeCount, entriesCount } = that._navigationBearings.get();
							if (changeCount === -1 || entriesCount === -1) {
								return undefined;
							} else if (changeCount === 1 && entriesCount === 1) {
								return localize('tooltip_11', "1 change in 1 file");
							} else if (changeCount === 1) {
								return localize('tooltip_1n', "1 change in {0} files", entriesCount);
							} else if (entriesCount === 1) {
								return localize('tooltip_n1', "{0} changes in 1 file", changeCount);
							} else {
								return localize('tooltip_nm', "{0} changes in {1} files", changeCount, entriesCount);
							}
						}

						override onClick(event: EventLike, preserveFocus?: boolean): void {
							unlockScroll();
						}
					};
				}

				if (action.id === AcceptAction.ID || action.id === RejectAction.ID) {
					return new class extends ActionViewItem {

						private readonly _reveal = this._store.add(new MutableDisposable());

						constructor() {
							super(undefined, action, { ...options, icon: false, label: true, keybindingNotRenderedWithLabel: true });
						}
						override set actionRunner(actionRunner: IActionRunner) {
							super.actionRunner = actionRunner;

							const store = new DisposableStore();

							store.add(actionRunner.onWillRun(_e => {
								focusEditor();
							}));

							store.add(actionRunner.onDidRun(e => {
								if (e.action !== this.action) {
									return;
								}
								const d = that._entry.get();
								if (!d || d.entry === d.next) {
									return;
								}
								return openChatEntry(d.next, true, editorService);
							}));

							this._reveal.value = store;
						}
						override get actionRunner(): IActionRunner {
							return super.actionRunner;
						}
					};
				}
				return undefined;
			}
		});
	}

	dispose() {
		this.hide();
		this._showStore.dispose();
		this._toolbar.dispose();
	}

	getId(): string {
		return 'chatEditorOverlayWidget';
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	getPosition(): IOverlayWidgetPosition | null {
		return { preference: OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER };
	}

	show(session: IChatEditingSession, activeEntry: IModifiedFileEntry, next: IModifiedFileEntry) {

		this._showStore.clear();

		this._entry.set({ entry: activeEntry, next }, undefined);

		this._showStore.add(autorun(r => {
			const busy = activeEntry.isCurrentlyBeingModified.read(r);
			this._domNode.classList.toggle('busy', busy);
		}));

		const slickRatio = ObservableAnimatedValue.const(0);
		let t = Date.now();
		this._showStore.add(autorun(r => {
			const value = activeEntry.rewriteRatio.read(r);

			slickRatio.changeAnimation(prev => {
				const result = new AnimatedValue(prev.getValue(), value, Date.now() - t);
				t = Date.now();
				return result;
			}, undefined);

			const value2 = slickRatio.getValue(r);
			reset(this._progressNode, value === 0
				? renderIcon(ThemeIcon.modify(Codicon.loading, 'spin'))
				: `${Math.round(value2 * 100)}%`
			);
		}));

		this._showStore.add(autorun(r => {

			const position = this.currentChange.read(r);
			const entries = session.entries.read(r);

			let changes = 0;
			let activeIdx = -1;
			for (const entry of entries) {
				if (activeIdx !== -1 || entry !== activeEntry) {
					if (isTextFileEntry(entry)) {
						// just add up
						changes += entry.diffInfo.read(r).changes.length;
					}
					else {
						for (const diff of entry.cellDiffInfo.read(r)) {
							if (diff.type !== 'unchanged') {
								// just add up
								changes += diff.diff.changes.length;
							}
						}
					}

				} else {
					// Check if we have a notebook position.
					if (isTextFileEntry(entry)) {
						for (const change of entry.diffInfo.read(r).changes) {
							if (position && !('diffInfo' in position) && change.modified.includes(position.lineNumber)) {
								activeIdx = changes;
							}
							changes += 1;
						}
					} else {
						for (const diff of entry.cellDiffInfo.read(r)) {
							if (diff.type === 'modified' && position && 'diffInfo' in position && position.cellPosition) {
								const cellLineNumber = position.cellPosition.lineNumber;
								for (const change of diff.diff.changes) {
									// For deleted lines, the diff will be empty line.
									if (change.modified.includes(cellLineNumber) || (change.modified.isEmpty && change.modified.startLineNumber === cellLineNumber)) {
										activeIdx = changes;
									}
									changes += 1;
								}
							} else if (diff.type !== 'unchanged') {
								changes += diff.diff.changes.length;
							}
						}
					}
				}
			}

			this._navigationBearings.set({ changeCount: changes, activeIdx, entriesCount: entries.length }, undefined);
		}));

		if (!this._isAdded) {
			this._isAdded = true;
		}
	}

	hide() {

		transaction(tx => {
			this._entry.set(undefined, tx);
			this._navigationBearings.set({ changeCount: -1, activeIdx: -1, entriesCount: -1 }, tx);
		});

		if (this._isAdded) {
			this._isAdded = false;
			this._showStore.clear();
		}
	}
}

export const navigationBearingFakeActionId = 'chatEditor.navigation.bearings';

MenuRegistry.appendMenuItem(MenuId.ChatEditingEditorContent, {
	command: {
		id: navigationBearingFakeActionId,
		title: localize('label', "Navigation Status"),
		precondition: ContextKeyExpr.false(),
	},
	group: 'navigate',
	order: -1
});


export class ObservableAnimatedValue {
	public static const(value: number): ObservableAnimatedValue {
		return new ObservableAnimatedValue(AnimatedValue.const(value));
	}

	private readonly _value: ISettableObservable<AnimatedValue>;

	constructor(
		initialValue: AnimatedValue,
	) {
		this._value = observableValue(this, initialValue);
	}

	setAnimation(value: AnimatedValue, tx: ITransaction | undefined): void {
		this._value.set(value, tx);
	}

	changeAnimation(fn: (prev: AnimatedValue) => AnimatedValue, tx: ITransaction | undefined): void {
		const value = fn(this._value.get());
		this._value.set(value, tx);
	}

	getValue(reader: IReader | undefined): number {
		const value = this._value.read(reader);
		if (!value.isFinished()) {
			Scheduler.instance.invalidateOnNextAnimationFrame(reader);
		}
		return value.getValue();
	}
}

class Scheduler {
	static instance = new Scheduler();

	private readonly _signal = observableSignal(this);

	private _isScheduled = false;

	invalidateOnNextAnimationFrame(reader: IReader | undefined): void {
		this._signal.read(reader);
		if (!this._isScheduled) {
			this._isScheduled = true;
			scheduleAtNextAnimationFrame(getWindow(undefined), () => {
				this._isScheduled = false;
				this._signal.trigger(undefined);
			});
		}
	}
}

export class AnimatedValue {

	static const(value: number): AnimatedValue {
		return new AnimatedValue(value, value, 0);
	}

	readonly startTimeMs = Date.now();

	constructor(
		readonly startValue: number,
		readonly endValue: number,
		readonly durationMs: number,
	) {
		if (startValue === endValue) {
			this.durationMs = 0;
		}
	}

	isFinished(): boolean {
		return Date.now() >= this.startTimeMs + this.durationMs;
	}

	getValue(): number {
		const timePassed = Date.now() - this.startTimeMs;
		if (timePassed >= this.durationMs) {
			return this.endValue;
		}
		const value = easeOutExpo(timePassed, this.startValue, this.endValue - this.startValue, this.durationMs);
		return value;
	}
}

function easeOutExpo(passedTime: number, start: number, length: number, totalDuration: number): number {
	return passedTime === totalDuration
		? start + length
		: length * (-Math.pow(2, -10 * passedTime / totalDuration) + 1) + start;
}


export class ChatEditorOverlayController implements IEditorContribution {

	static readonly ID = 'editor.contrib.chatOverlayController';

	private readonly _store = new DisposableStore();

	static get(editor: ICodeEditor) {
		return editor.getContribution<ChatEditorOverlayController>(ChatEditorOverlayController.ID);
	}
	private _isAdded: boolean = false;

	constructor(
		private readonly _editor: ICodeEditor,
		@IChatEditingService chatEditingService: IChatEditingService,
		@IInstantiationService instaService: IInstantiationService,
	) {
		const modelObs = observableFromEvent(this._editor.onDidChangeModel, () => this._editor.getModel());
		const currentChange = observableValue<Position | undefined>('currentChange', undefined);
		const widget = this._store.add(instaService.createInstance(ChatEditorOverlayWidget, currentChange, () => _editor.focus(), () => ChatEditorController.get(_editor)?.unlockScroll()));

		if (this._editor.getOption(EditorOption.inDiffEditor)) {
			return;
		}

		const controller = getChatEditorController(this._editor);
		if (controller instanceof ChatEditorController) {
			this._store.add(autorun(r => {
				currentChange.set(controller.currentChange.read(r), undefined);
			}));
		}

		this._store.add(autorun(r => {
			const model = modelObs.read(r);
			const session = chatEditingService.currentEditingSessionObs.read(r);
			if (!session || !model) {
				this.hide(widget);
				return;
			}

			const state = session.state.read(r);
			if (state === ChatEditingSessionState.Disposed) {
				this.hide(widget);
				return;
			}

			const entries = session.entries.read(r);
			const idx = entries.findIndex(e => isEqual(e.modifiedURI, model.uri));
			if (idx < 0) {
				this.hide(widget);
				return;
			}

			const isModifyingOrModified = entries.some(e => e.state.read(r) === WorkingSetEntryState.Modified || e.isCurrentlyBeingModified.read(r));
			if (!isModifyingOrModified) {
				this.hide(widget);
				return;
			}

			const entry = entries[idx];
			widget.show(session, entry, entries[(idx + 1) % entries.length]);
			if (!this._isAdded) {
				this._editor.addOverlayWidget(widget);
				this._isAdded = true;
			}
		}));
	}

	private hide(widget: ChatEditorOverlayWidget) {
		widget.hide();
		if (this._isAdded) {
			this._editor.removeOverlayWidget(widget);
			this._isAdded = false;
		}
	}

	dispose() {
		this._store.dispose();
	}
}
