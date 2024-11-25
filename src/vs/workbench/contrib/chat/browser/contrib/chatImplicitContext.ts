/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICodeEditor, isCodeEditor, isDiffEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { Location } from '../../../../../editor/common/languages.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { EditorsOrder } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ChatAgentLocation } from '../../common/chatAgents.js';
import { IBaseChatRequestVariableEntry, IChatRequestImplicitVariableEntry } from '../../common/chatModel.js';
import { ILanguageModelIgnoredFilesService } from '../../common/ignoredFiles.js';
import { IChatWidget, IChatWidgetService } from '../chat.js';
import { PromptFileReference } from '../../common/promptFileReference.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';

export class ChatImplicitContextContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chat.implicitContext';

	private readonly _currentCancelTokenSource = this._register(new MutableDisposable<CancellationTokenSource>());

	constructor(
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IEditorService private readonly editorService: IEditorService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@ILanguageModelIgnoredFilesService private readonly ignoredFilesService: ILanguageModelIgnoredFilesService,
	) {
		super();

		const activeEditorDisposables = this._register(new DisposableStore());
		this._register(Event.runAndSubscribe(
			editorService.onDidVisibleEditorsChange,
			(() => {
				activeEditorDisposables.clear();
				const codeEditor = this.findActiveCodeEditor();
				if (codeEditor) {
					activeEditorDisposables.add(Event.debounce(
						Event.any(
							codeEditor.onDidChangeModel,
							codeEditor.onDidChangeCursorSelection,
							codeEditor.onDidScrollChange),
						() => undefined,
						500)(() => this.updateImplicitContext()));
				}

				this.updateImplicitContext();
			})));
		this._register(chatWidgetService.onDidAddWidget(widget => this.updateImplicitContext(widget)));
	}

	private findActiveCodeEditor(): ICodeEditor | undefined {
		const codeEditor = this.codeEditorService.getActiveCodeEditor();
		if (codeEditor) {
			const model = codeEditor.getModel();
			if (model) {
				return codeEditor;
			}
		}
		for (const codeOrDiffEditor of this.editorService.getVisibleTextEditorControls(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
			let codeEditor: ICodeEditor;
			if (isDiffEditor(codeOrDiffEditor)) {
				codeEditor = codeOrDiffEditor.getModifiedEditor();
			} else if (isCodeEditor(codeOrDiffEditor)) {
				codeEditor = codeOrDiffEditor;
			} else {
				continue;
			}

			const model = codeEditor.getModel();
			if (model) {
				return codeEditor;
			}
		}
		return undefined;
	}

	private async updateImplicitContext(updateWidget?: IChatWidget): Promise<void> {
		const cancelTokenSource = this._currentCancelTokenSource.value = new CancellationTokenSource();
		const codeEditor = this.findActiveCodeEditor();
		const model = codeEditor?.getModel();
		const selection = codeEditor?.getSelection();
		let newValue: Location | URI | undefined;
		let isSelection = false;
		if (model) {
			if (selection && !selection.isEmpty()) {
				newValue = { uri: model.uri, range: selection } satisfies Location;
				isSelection = true;
			} else {
				const visibleRanges = codeEditor?.getVisibleRanges();
				if (visibleRanges && visibleRanges.length > 0) {
					// Merge visible ranges. Maybe the reference value could actually be an array of Locations?
					// Something like a Location with an array of Ranges?
					let range = visibleRanges[0];
					visibleRanges.slice(1).forEach(r => {
						range = range.plusRange(r);
					});
					newValue = { uri: model.uri, range } satisfies Location;
				} else {
					newValue = model.uri;
				}
			}
		}

		const uri = newValue instanceof URI ? newValue : newValue?.uri;
		if (uri && await this.ignoredFilesService.fileIsIgnored(uri, cancelTokenSource.token)) {
			newValue = undefined;
		}

		if (cancelTokenSource.token.isCancellationRequested) {
			return;
		}

		const widgets = updateWidget ? [updateWidget] : [...this.chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Panel), ...this.chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Editor)];
		for (const widget of widgets) {
			if (widget.input.implicitContext) {
				widget.input.implicitContext.setValue(newValue, isSelection);
			}
		}
	}
}

export class ChatImplicitContext extends Disposable implements IChatRequestImplicitVariableEntry {
	/**
	 * Chat reference object for the current implicit context `URI`
	 * allows to resolve nested file references(aka `prompt snippets`).
	 */
	private promptFileReference?: PromptFileReference;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configService: IConfigurationService,
	) {
		super();
	}

	get id() {
		if (URI.isUri(this.value)) {
			return 'vscode.implicit.file';
		} else if (this.value) {
			if (this._isSelection) {
				return 'vscode.implicit.selection';
			} else {
				return 'vscode.implicit.viewport';
			}
		} else {
			return 'vscode.implicit';
		}
	}

	get name(): string {
		if (URI.isUri(this.value)) {
			return `file:${basename(this.value)}`;
		} else if (this.value) {
			return `file:${basename(this.value.uri)}`;
		} else {
			return 'implicit';
		}
	}

	readonly kind = 'implicit';

	get modelDescription(): string {
		if (URI.isUri(this.value)) {
			return `User's active file`;
		} else if (this._isSelection) {
			return `User's active selection`;
		} else {
			return `User's current visible code`;
		}
	}

	// TODO@roblourens
	readonly isDynamic = true;
	readonly isFile = true;

	private _isSelection = false;
	public get isSelection(): boolean {
		return this._isSelection;
	}

	private _onDidChangeValue = this._register(new Emitter<void>());
	readonly onDidChangeValue = this._onDidChangeValue.event;

	private _value: Location | URI | undefined;
	get value() {
		return this._value;
	}

	private _enabled = true;
	get enabled() {
		return this._enabled;
	}

	set enabled(value: boolean) {
		this._enabled = value;
		this._onDidChangeValue.fire();
	}

	/**
	 * Get nested file references list, if exists.
	 */
	public get validFileReferenceUris(): readonly URI[] {
		if (!this.promptFileReference) {
			return [];
		}

		return this.promptFileReference.validFileReferenceUris;
	}

	/**
	 * Set value of the implicit context or remove it if `undefined` is provided.
	 */
	public setValue(value: Location | URI | undefined, isSelection: boolean) {
		// if the `prompt-snippets` feature is enabled, add a chat reference object
		if (PromptFileReference.promptSnippetsEnabled(this.configService)) {
			this.addPromptFileReferenceFor(value);
		}

		this._value = value;
		this._isSelection = isSelection;
		this._onDidChangeValue.fire();
	}

	/**
	 * Add a prompt file reference object for the provided `URI` value.
	 */
	private addPromptFileReferenceFor(
		value: Location | URI | undefined,
	) {
		// new value is `undefined` so remove the existing file reference
		if (!value) {
			return this.removePromptFileReference();
		}

		// if the `URI` value didn't change and prompt file reference exists, nothing to do
		if (this.promptFileReference && this.promptFileReference.sameUri(value)) {
			return;
		}

		// got a new `URI` value, so remove the existing prompt file
		// reference object(if present) and create a new one
		this.removePromptFileReference();
		this.promptFileReference = this._register(
			this.instantiationService.createInstance(PromptFileReference, value),
		);

		// subscribe to updates of the prompt file reference
		this._register(
			this.promptFileReference.onUpdate(
				this._onDidChangeValue.fire.bind(this._onDidChangeValue),
			),
		);
		// start resolving the nested prompt file references immediately
		this.promptFileReference.resolve();
	}

	/**
	 * Remove current prompt file reference, if present.
	 */
	private removePromptFileReference() {
		if (!this.promptFileReference) {
			return;
		}

		this.promptFileReference.dispose();
		delete this.promptFileReference;
	}

	toBaseEntry(): IBaseChatRequestVariableEntry {
		return {
			id: this.id,
			name: this.name,
			value: this.value,
			isFile: true,
			isDynamic: true,
			modelDescription: this.modelDescription
		};
	}
}
