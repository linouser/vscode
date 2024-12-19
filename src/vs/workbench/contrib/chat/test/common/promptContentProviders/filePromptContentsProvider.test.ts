/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ReadableStream } from '../../../../../../base/common/stream.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { NullPolicyService } from '../../../../../../platform/policy/common/policy.js';
import { ILogService, NullLogService } from '../../../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ConfigurationService } from '../../../../../../platform/configuration/common/configurationService.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { randomInt } from '../../../../../../base/common/numbers.js';
import { FilePromptContentProvider } from '../../../common/promptContentProviders/filePromptContentsProvider.js';
import { Line } from '../../../../../../editor/common/codecs/linesCodec/tokens/line.js';
import { BaseDecoder } from '../../../../../../base/common/codecs/baseDecoder.js';
import { InMemoryFileSystemProvider } from '../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { Schemas } from '../../../../../../base/common/network.js';

suite('FilePromptContentsProvider', function () {
	const testDisposables = ensureNoDisposablesAreLeakedInTestSuite();

	let instantiationService: TestInstantiationService;
	setup(async () => {
		const nullPolicyService = new NullPolicyService();
		const nullLogService = testDisposables.add(new NullLogService());
		const nullFileService = testDisposables.add(new FileService(nullLogService));
		const nullConfigService = testDisposables.add(new ConfigurationService(
			URI.file('/config.json'),
			nullFileService,
			nullPolicyService,
			nullLogService,
		));
		instantiationService = testDisposables.add(new TestInstantiationService());

		const fileSystemProvider = testDisposables.add(new InMemoryFileSystemProvider());
		testDisposables.add(nullFileService.registerProvider(Schemas.file, fileSystemProvider));

		instantiationService.stub(IFileService, nullFileService);
		instantiationService.stub(ILogService, nullLogService);
		instantiationService.stub(IConfigurationService, nullConfigService);
	});

	test('provides contents of a file', async function () {
		const fileService = instantiationService.get(IFileService);

		const fileName = `file-${randomInt(10000)}.prompt.md`;
		const fileUri = URI.file(`/${fileName}`);

		if (await fileService.exists(fileUri)) {
			await fileService.del(fileUri);
		}
		await fileService.writeFile(fileUri, VSBuffer.fromString('Hello, world!'));
		await new Promise((resolve) => setTimeout(resolve, 5));

		const contentsProvider = testDisposables.add(instantiationService.createInstance(
			FilePromptContentProvider,
			fileUri,
		));

		let streamOrError: ReadableStream<Line> | Error | undefined;
		testDisposables.add(contentsProvider.onContentChanged((event) => {
			streamOrError = event;
		}));
		contentsProvider.start();

		await new Promise((resolve) => setTimeout(resolve, 25));

		assert(
			streamOrError instanceof BaseDecoder,
			`Provider must produce a stream of lines, got '${streamOrError}'.`,
		);

		const stream = testDisposables.add(streamOrError);

		const receivedLines = await stream.consumeAll();
		assert.strictEqual(
			receivedLines.length,
			1,
			'Must read the correct number of lines from the provider.',
		);

		const expectedLine = new Line(1, 'Hello, world!');
		const receivedLine = receivedLines[0];
		assert(
			receivedLine.equals(expectedLine),
			`Expected to receive '${expectedLine}', got '${receivedLine}'.`,
		);
	});
});
