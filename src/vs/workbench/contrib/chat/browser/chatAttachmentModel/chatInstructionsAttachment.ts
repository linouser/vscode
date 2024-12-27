/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { Emitter } from '../../../../../base/common/event.js';
import { basename } from '../../../../../base/common/resources.js';
import { assertDefined } from '../../../../../base/common/types.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { PromptFileReference, TErrorCondition } from '../../common/promptFileReference.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { FileOpenFailed, NonPromptSnippetFile, RecursiveReference } from '../../common/promptFileReferenceErrors.js';

/**
 * Object that represents an error that may occur during
 * the process of resolving prompt instructions reference.
 */
interface IIssue {
	/**
	 * Type of the failure. Currently all errors that occur on
	 * the "main" root reference directly attached to the chat
	 * are considered to be `error`s, while all failures on nested
	 * child references are considered to be `warning`s.
	 */
	type: 'error' | 'warning';

	/**
	 * Error or warning message.
	 */
	message: string;
}

/**
 * Model for a single chat prompt instructions attachment.
 */
export class ChatInstructionsAttachmentModel extends Disposable {
	/**
	 * Private reference of the underlying prompt instructions
	 * reference instance.
	 */
	private readonly _reference: PromptFileReference;
	/**
	 * Get the prompt instructions reference instance.
	 */
	public get reference(): PromptFileReference {
		return this._reference;
	}


	/**
	 * Get `URI` for the main reference and `URI`s of all valid
	 * child references it may contain.
	 */
	public get references(): readonly URI[] {
		const { reference, enabled, resolveIssue } = this;

		// return no references if the attachment is disabled
		if (!enabled) {
			return [];
		}

		// if the model has an error, return no references
		if (resolveIssue && !(resolveIssue instanceof NonPromptSnippetFile)) {
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
	 * If the prompt instructions reference (or any of its child references) has
	 * failed to resolve, this field contains the failure details, otherwise `undefined`.
	 *
	 * See {@linkcode IIssue}.
	 */
	public get resolveIssue(): IIssue | undefined {
		const { errorCondition } = this._reference;

		const errorConditions = this.collectErrorConditions();
		if (errorConditions.length === 0) {
			return undefined;
		}

		const [firstError, ...restErrors] = errorConditions;

		// if the first error is the error of the root reference,
		// then return it as an `error` otherwise use `warning`
		const isRootError = (firstError === errorCondition);
		const type = (isRootError)
			? 'error'
			: 'warning';

		const moreSuffix = restErrors.length > 0
			? `\n-\n +${restErrors.length} more error${restErrors.length > 1 ? 's' : ''}`
			: '';

		const errorMessage = this.getMessage(firstError, isRootError);
		return {
			type,
			message: `${errorMessage}${moreSuffix}`,
		};
	}

	/**
	 * Get message for the provided error condition object.
	 *
	 * @param error Error object.
	 * @param isRootError If the error happened on the the "main" root reference.
	 * @returns Error message.
	 */
	private getMessage(
		error: TErrorCondition,
		isRootError: boolean,
	): string {
		const { uri } = error;

		const prefix = (!isRootError)
			? 'Contains a broken nested reference that will be ignored: '
			: '';

		if (error instanceof FileOpenFailed) {
			return `${prefix}Failed to open file '${uri.path}'.`;
		}

		if (error instanceof RecursiveReference) {
			const { recursivePath } = error;

			const recursivePathString = recursivePath
				.map((path) => {
					return basename(URI.file(path));
				})
				.join(' -> ');

			return `${prefix}Recursive reference found:\n${recursivePathString}`;
		}

		return `${prefix}${error.message}`;
	}

	/**
	 * Collect all failures that may have occurred during the process
	 * of resolving references in the entire references tree.
	 *
	 * @returns List of errors in the references tree.
	 */
	private collectErrorConditions(): TErrorCondition[] {
		return this.reference
			// get all references (including the root) as a flat array
			.flatten()
			// filter out children without error conditions or
			// the ones that are non-prompt snippet files
			.filter((childReference) => {
				const { errorCondition } = childReference;

				return errorCondition && !(errorCondition instanceof NonPromptSnippetFile);
			})
			// map to error condition objects
			.map((childReference): TErrorCondition => {
				const { errorCondition } = childReference;

				// `must` always be `true` because of the `filter` call above
				assertDefined(
					errorCondition,
					`Error condition must be present for '${childReference.uri.path}'.`,
				);

				return errorCondition;
			});
	}

	/**
	 * Event that fires when the error condition of the prompt
	 * reference changes.
	 *
	 * See {@linkcode onUpdate}.
	 */
	protected _onUpdate = this._register(new Emitter<void>());
	/**
	 * Subscribe to the `onUpdate` event.
	 * @param callback Function to invoke on update.
	 */
	public onUpdate(callback: () => unknown): this {
		this._register(this._onUpdate.event(callback));

		return this;
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
	 * Private property to track the `enabled` state of the prompt
	 * instructions attachment.
	 */
	private _enabled: boolean = true;
	/**
	 * Get the `enabled` state of the prompt instructions attachment.
	 */
	public get enabled(): boolean {
		return this._enabled;
	}

	constructor(
		uri: URI,
		@IInstantiationService private readonly initService: IInstantiationService,
	) {
		super();

		this._onUpdate.fire = this._onUpdate.fire.bind(this._onUpdate);
		this._reference = this._register(this.initService.createInstance(PromptFileReference, uri))
			.onUpdate(this._onUpdate.fire);
	}

	/**
	 * Start resolving the prompt instructions reference and child references
	 * that it may contain.
	 */
	public resolve(): this {
		this._reference.resolve();

		return this;
	}

	/**
	 * Toggle the `enabled` state of the prompt instructions attachment.
	 */
	public toggle(): this {
		this._enabled = !this._enabled;
		this._onUpdate.fire();

		return this;
	}

	public override dispose(): void {
		this._onDispose.fire();

		super.dispose();
	}
}
