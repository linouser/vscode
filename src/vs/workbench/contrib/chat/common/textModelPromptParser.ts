/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptParser } from './basePromptParser.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { TextModelContentsProvider } from './textModelContentsProvider.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * TODO: @legomushroom
 */
export class TextModelPromptParser extends BasePromptParser<TextModelContentsProvider> {
	constructor(
		model: ITextModel,
		seenReferences: string[] = [],
		@IInstantiationService initService: IInstantiationService,
		@IConfigurationService configService: IConfigurationService,
	) {
		const contentsProvider = initService.createInstance(TextModelContentsProvider, model);
		super(contentsProvider, seenReferences, initService, configService);
	}

	/**
	 * Returns a string representation of this object.
	 */
	public override toString() {
		return `text-model-prompt:${this.uri.path}`;
	}
}
