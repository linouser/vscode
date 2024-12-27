/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../../nls.js';
import { URI } from '../../../../../../base/common/uri.js';
import * as dom from '../../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { ResourceLabels } from '../../../../../browser/labels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { ResourceContextKey } from '../../../../../common/contextkeys.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { basename, dirname } from '../../../../../../base/common/resources.js';
import { ILabelService } from '../../../../../../platform/label/common/label.js';
import { StandardMouseEvent } from '../../../../../../base/browser/mouseEvent.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { NonPromptSnippetFile } from '../../../common/promptFileReferenceErrors.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { FileKind, IFileService } from '../../../../../../platform/files/common/files.js';
import { IMenuService, MenuId } from '../../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { ChatInstructionsAttachment } from '../../chatAttachmentModel/chatInstructionsAttachment.js';
import { getDefaultHoverDelegate } from '../../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { getFlatContextMenuActions } from '../../../../../../platform/actions/browser/menuEntryActionViewItem.js';

/**
 * Widget for a single prompt instructions attachment.
 */
export class InstructionsAttachmentWidget extends Disposable {
	/**
	 * The root DOM node of the widget.
	 */
	public readonly domNode: HTMLElement;

	/**
	 * Get `URI` for the main reference and `URI`s of all valid
	 * child references it may contain.
	 */
	public get references(): readonly URI[] {
		const { reference, enabled, errorCondition } = this.model;

		// return no references if the attachment is disabled
		if (!enabled) {
			return [];
		}

		// if the model has an error, return no references
		if (errorCondition && !(errorCondition instanceof NonPromptSnippetFile)) {
			return [];
		}

		// otherwise return `URI` for the main reference and
		// all valid child `URI` references it may contain
		return [
			...reference.validFileReferenceUris,
			reference.uri,
		];
	}

	/**
	 * Get the `URI` associated with the model reference.
	 */
	public get uri(): URI {
		return this.model.reference.uri;
	}

	/**
	 * Event that fires when the object is disposed.
	 *
	 * See {@linkcode onDispose}.
	 */
	protected _onDispose = this._register(new Emitter<void>());
	/**
	 * Subscribe to the `onDispose` event.
	 * @param callback Function to invoke on dispose.
	 */
	public onDispose(callback: () => unknown): this {
		this._register(this._onDispose.event(callback));

		return this;
	}

	/**
	 * Temporary disposables used for rendering purposes.
	 */
	private readonly renderDisposables = this._register(new DisposableStore());

	constructor(
		private readonly model: ChatInstructionsAttachment,
		private readonly resourceLabels: ResourceLabels,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IHoverService private readonly hoverService: IHoverService,
		@ILabelService private readonly labelService: ILabelService,
		@IMenuService private readonly menuService: IMenuService,
		@IFileService private readonly fileService: IFileService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IModelService private readonly modelService: IModelService,
	) {
		super();

		this.domNode = dom.$('.chat-prompt-instructions-attachment.chat-attached-context-attachment.show-file-icons.implicit');

		this.render = this.render.bind(this);
		this.dispose = this.dispose.bind(this);

		this.model.onUpdate(this.render);
		this.model.onDispose(this.dispose);

		this.render();
	}

	/**
	 * Render this widget.
	 */
	private render() {
		dom.clearNode(this.domNode);
		this.renderDisposables.clear();
		this.domNode.classList.remove('warning', 'error', 'disabled');

		const { enabled, errorCondition } = this.model;
		if (!enabled) {
			this.domNode.classList.add('disabled');
		}

		const label = this.resourceLabels.create(this.domNode, { supportIcons: true });
		const file = this.model.reference.uri;

		const fileBasename = basename(file);
		const fileDirname = dirname(file);
		const friendlyName = `${fileBasename} ${fileDirname}`;
		const ariaLabel = localize('chat.instructionsAttachment', "Prompt instructions attachment, {0}", friendlyName);

		const uriLabel = this.labelService.getUriLabel(file, { relative: true });
		const currentFile = localize('openEditor', "Prompt instructions");
		const inactive = localize('enableHint', "disabled");
		const currentFileHint = currentFile + (enabled ? '' : ` (${inactive})`);

		const title = `${currentFileHint} ${uriLabel}`;
		label.setFile(file, {
			fileKind: FileKind.FILE,
			hidePath: true,
			range: undefined,
			title,
			icon: ThemeIcon.fromId(Codicon.lightbulbSparkle.id),
			extraClasses: [],
		});
		this.domNode.ariaLabel = ariaLabel;
		this.domNode.tabIndex = 0;

		let hoverTitle = title;
		// if there are some errors/warning during the process of resolving
		// attachment references (including all the nested child references),
		// add the issue details in the hover title for the attachment
		if (errorCondition) {
			const { type, message: details } = errorCondition;
			this.domNode.classList.add(type);

			const errorCaption = type === 'warning'
				? localize('warning', "[Warning]")
				: localize('error', "[Error]");

			hoverTitle += `\n-\n${errorCaption}: ${details}`;
		}

		const hintElement = dom.append(this.domNode, dom.$('span.chat-implicit-hint', undefined, 'Instructions'));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), hintElement, hoverTitle));

		// create `toggle` enabled state button
		const toggleButtonMsg = enabled ? localize('disable', "Disable") : localize('enable', "Enable");
		const toggleButton = this.renderDisposables.add(new Button(this.domNode, { supportIcons: true, title: toggleButtonMsg }));
		toggleButton.icon = enabled ? Codicon.eye : Codicon.eyeClosed;
		this.renderDisposables.add(toggleButton.onDidClick((e) => {
			e.stopPropagation();
			this.model.toggle();
		}));

		// create the `remove` button
		const removeButton = this.renderDisposables.add(new Button(this.domNode, { supportIcons: true, title: localize('remove', "Remove") }));
		removeButton.icon = Codicon.x;
		this.renderDisposables.add(removeButton.onDidClick((e) => {
			e.stopPropagation();
			this.model.dispose();
		}));

		// Context menu
		const scopedContextKeyService = this.renderDisposables.add(this.contextKeyService.createScoped(this.domNode));

		const resourceContextKey = this.renderDisposables.add(
			new ResourceContextKey(scopedContextKeyService, this.fileService, this.languageService, this.modelService),
		);
		resourceContextKey.set(file);

		this.renderDisposables.add(dom.addDisposableListener(this.domNode, dom.EventType.CONTEXT_MENU, async domEvent => {
			const event = new StandardMouseEvent(dom.getWindow(domEvent), domEvent);
			dom.EventHelper.stop(domEvent, true);

			this.contextMenuService.showContextMenu({
				contextKeyService: scopedContextKeyService,
				getAnchor: () => event,
				getActions: () => {
					const menu = this.menuService.getMenuActions(MenuId.ChatInputResourceAttachmentContext, scopedContextKeyService, { arg: file });
					return getFlatContextMenuActions(menu);
				},
			});
		}));
	}

	public override dispose(): void {
		this._onDispose.fire();

		super.dispose();
	}
}
