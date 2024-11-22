/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { PromptFileReference, TErrorCondition } from '../../common/promptFileReference.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { FileOpenFailed, RecursiveReference, NotPromptSnippetFile } from '../../common/promptFileReferenceErrors.js';

/**
 * Represents a file system node.
 */
interface IFilesystemNode {
	name: string;
}

/**
 * Represents a file node.
 */
interface IFile extends IFilesystemNode {
	contents: string;
}

/**
 * Represents a folder node.
 */
interface IFolder extends IFilesystemNode {
	children: (IFolder | IFile)[];
}

/**
 * Represents a file reference with an expected
 * error condition value for testing purposes.
 */
class ExpectedReference extends PromptFileReference {
	constructor(
		uri: URI,
		public readonly error: TErrorCondition | undefined,
	) {
		const dumbFileService = new FileService(new NullLogService());
		super(uri, dumbFileService);

		this._register(dumbFileService);
	}

	/**
	 * Override the error condition getter to
	 * return the provided expected error value.
	 */
	public override get errorCondition() {
		return this.error;
	}
}

/**
 * A reusable test utility to test the `PromptFileReference` class.
 */
class TestPromptFileReference extends Disposable {
	private readonly fileService = this._register(new FileService(new NullLogService()));

	constructor(
		private readonly fileStructure: IFolder,
		private readonly expectedReferences: ExpectedReference[],
	) {
		super();

		// ensure all the expected references are disposed
		for (const expectedReference of this.expectedReferences) {
			this._register(expectedReference);
		}

		// create in-memory file system
		const fileSystemProvider = this._register(new InMemoryFileSystemProvider());
		this._register(this.fileService.registerProvider(Schemas.file, fileSystemProvider));
	}

	/**
	 * Run the test.
	 */
	public async run() {
		// create the files structure on the disk
		await this.createFolder(
			this.fileService,
			this.fileStructure,
		);

		// start for the root file reference
		const rootReference = this._register(new PromptFileReference(
			URI.file(`/${this.fileStructure.name}/file2.prompt.md`),
			this.fileService,
		));

		// resolve the root file reference including all nested references
		const resolvedReferences = (await rootReference.resolve(true))
			.flatten();

		for (let i = 0; i < this.expectedReferences.length; i++) {
			const expectedReference = this.expectedReferences[i];
			const resolvedReference = resolvedReferences[i];

			assert(
				resolvedReference.equals(expectedReference),
				[
					`Expected ${i}th resolved reference to be ${expectedReference}`,
					`got ${resolvedReference}.`,
				].join(', '),
			);

			if (expectedReference.errorCondition === undefined) {
				assert(
					resolvedReference.errorCondition === undefined,
					[
						`Expected ${i}th error condition to be 'undefined'`,
						`got '${resolvedReference.errorCondition}'.`,
					].join(', '),
				);
				continue;
			}

			assert(
				expectedReference.errorCondition.equal(resolvedReference.errorCondition),
				[
					`Expected ${i}th error condition to be '${expectedReference.errorCondition}'`,
					`got '${resolvedReference.errorCondition}'.`,
				].join(', '),
			);
		}

		assert.strictEqual(
			resolvedReferences.length,
			this.expectedReferences.length,
			[
				`Expected to resolve ${this.expectedReferences.length} references`,
				`got ${resolvedReferences.length}.`,
			].join(', ')
		);
	}

	/**
	 * Create the provided filesystem folder structure.
	 */
	async createFolder(
		fileService: IFileService,
		folder: IFolder,
		parentFolder?: URI,
	): Promise<void> {
		const folderUri = parentFolder
			? URI.joinPath(parentFolder, folder.name)
			: URI.file(folder.name);

		if (await fileService.exists(folderUri)) {
			await fileService.del(folderUri);
		}
		await fileService.createFolder(folderUri);

		for (const child of folder.children) {
			const childUri = URI.joinPath(folderUri, child.name);
			// create child file
			if ('contents' in child) {
				await fileService.writeFile(childUri, VSBuffer.fromString(child.contents));
				continue;
			}

			// recursively create child filesystem structure
			await this.createFolder(fileService, child, folderUri);
		}
	}
}

suite('ChatbotPromptReference', function () {
	const testDisposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves nested file references', async function () {
		const rootFolder = URI.file('/resolves-nested-file-references');

		const test = testDisposables.add(new TestPromptFileReference(
			/**
			 * The file structure to be created on the disk for the test.
			 */
			{
				name: 'resolves-nested-file-references',
				children: [
					{
						name: 'file1.prompt.md',
						contents: '## Some Header\nsome contents\n ',
					},
					{
						name: 'file2.prompt.md',
						contents: '## Files\n\t- this file #file:folder1/file3.prompt.md \n\t- also this #file:./folder1/some-other-folder/file4.prompt.md please!\n ',
					},
					{
						name: 'folder1',
						children: [
							{
								name: 'file3.prompt.md',
								contents: '\n\n\t- some seemingly random #file:/resolves-nested-file-references/folder1/some-other-folder/yetAnotherFolder🤭/another-file.prompt.md contents\n some more\t content',
							},
							{
								name: 'some-other-folder',
								children: [
									{
										name: 'file4.prompt.md',
										contents: 'this file has a non-existing #file:./some-non-existing/file.prompt.md\t\treference\n\nand some non-prompt #file:./some-non-prompt-file.md',
									},
									{
										name: 'file.txt',
										contents: 'contents of a non-prompt-snippet file',
									},
									{
										name: 'yetAnotherFolder🤭',
										children: [
											{
												name: 'another-file.prompt.md',
												contents: 'another-file.prompt.md contents\t  #file:../file.txt',
											},
											{
												name: 'one_more_file_just_in_case.prompt.md',
												contents: 'one_more_file_just_in_case.prompt.md contents',
											},
										],
									},
								],
							},
						],
					},
				],
			},
			/**
			 * The expected references to be resolved.
			 */
			[
				testDisposables.add(new ExpectedReference(
					URI.joinPath(rootFolder, './file2.prompt.md'),
					undefined,
				)),
				testDisposables.add(new ExpectedReference(
					URI.joinPath(rootFolder, './folder1/file3.prompt.md'),
					undefined,
				)),
				testDisposables.add(new ExpectedReference(
					URI.joinPath(rootFolder, './folder1/some-other-folder/yetAnotherFolder🤭/another-file.prompt.md'),
					undefined,
				)),
				testDisposables.add(new ExpectedReference(
					URI.joinPath(rootFolder, './folder1/some-other-folder/file.txt'),
					new NotPromptSnippetFile(
						URI.joinPath(rootFolder, './folder1/some-other-folder/file.txt'),
						'Ughh oh!',
					),
				)),
				testDisposables.add(new ExpectedReference(
					URI.joinPath(rootFolder, './folder1/some-other-folder/file4.prompt.md'),
					undefined,
				)),
				testDisposables.add(new ExpectedReference(
					URI.joinPath(rootFolder, './folder1/some-other-folder/some-non-existing/file.prompt.md'),
					new FileOpenFailed(
						URI.joinPath(rootFolder, './folder1/some-other-folder/some-non-existing/file.prompt.md'),
						'Some error message.',
					),
				)),
				testDisposables.add(new ExpectedReference(
					URI.joinPath(rootFolder, './folder1/some-other-folder/some-non-prompt-file.md'),
					new NotPromptSnippetFile(
						URI.joinPath(rootFolder, './folder1/some-other-folder/some-non-prompt-file.md'),
						'Oh no!',
					),
				)),
			]
		));

		await test.run();
	});

	test('does not fall into infinite reference recursion', async function () {
		const rootFolder = URI.file('/infinite-recursion');

		const test = testDisposables.add(new TestPromptFileReference(
			/**
			 * The file structure to be created on the disk for the test.
			 */
			{
				name: 'infinite-recursion',
				children: [
					{
						name: 'file1.md',
						contents: '## Some Header\nsome contents\n ',
					},
					{
						name: 'file2.prompt.md',
						contents: '## Files\n\t- this file #file:folder1/file3.prompt.md \n\t- also this #file:./folder1/some-other-folder/file4.prompt.md\n\n#file:/infinite-recursion/folder1/some-other-folder/file5.prompt.md\t please!\n\t#file:./file1.md ',
					},
					{
						name: 'folder1',
						children: [
							{
								name: 'file3.prompt.md',
								contents: '\n\n\t- some seemingly random #file:/infinite-recursion/folder1/some-other-folder/yetAnotherFolder🤭/another-file.prompt.md contents\n some more\t content',
							},
							{
								name: 'some-other-folder',
								children: [
									{
										name: 'file4.prompt.md',
										contents: 'this file has a non-existing #file:../some-non-existing/file.prompt.md\t\treference',
									},
									{
										name: 'file5.prompt.md',
										contents: 'this file has a relative recursive #file:../../file2.prompt.md\nreference\n ',
									},
									{
										name: 'yetAnotherFolder🤭',
										children: [
											{
												name: 'another-file.prompt.md',
												// absolute path with recursion
												contents: 'some test goes\t\nhere #file:/infinite-recursion/file2.prompt.md',
											},
											{
												name: 'one_more_file_just_in_case.prompt.md',
												contents: 'one_more_file_just_in_case.prompt.md contents',
											},
										],
									},
								],
							},
						],
					},
				],
			},
			/**
			 * The expected references to be resolved.
			 */
			[
				testDisposables.add(new ExpectedReference(
					URI.joinPath(rootFolder, './file2.prompt.md'),
					undefined,
				)),
				testDisposables.add(new ExpectedReference(
					URI.joinPath(rootFolder, './folder1/file3.prompt.md'),
					undefined,
				)),
				testDisposables.add(new ExpectedReference(
					URI.joinPath(rootFolder, './folder1/some-other-folder/yetAnotherFolder🤭/another-file.prompt.md'),
					undefined,
				)),
				/**
				 * This reference should be resolved as
				 * a recursive reference error condition.
				 * (the absolute reference case)
				 */
				testDisposables.add(new ExpectedReference(
					URI.joinPath(rootFolder, './file2.prompt.md'),
					new RecursiveReference(
						URI.joinPath(rootFolder, './file2.prompt.md'),
						[
							'/infinite-recursion/file2.prompt.md',
							'/infinite-recursion/folder1/file3.prompt.md',
							'/infinite-recursion/folder1/some-other-folder/yetAnotherFolder🤭/another-file.prompt.md',
							'/infinite-recursion/file2.prompt.md',
						],
					),
				)),
				testDisposables.add(new ExpectedReference(
					URI.joinPath(rootFolder, './folder1/some-other-folder/file4.prompt.md'),
					undefined,
				)),
				testDisposables.add(new ExpectedReference(
					URI.joinPath(rootFolder, './folder1/some-non-existing/file.prompt.md'),
					new FileOpenFailed(
						URI.joinPath(rootFolder, './folder1/some-non-existing/file.prompt.md'),
						'Some error message.',
					),
				)),
				testDisposables.add(new ExpectedReference(
					URI.joinPath(rootFolder, './folder1/some-other-folder/file5.prompt.md'),
					undefined,
				)),
				/**
				 * This reference should be resolved as
				 * a recursive reference error condition.
				 * (the relative reference case)
				 */
				testDisposables.add(new ExpectedReference(
					URI.joinPath(rootFolder, './file2.prompt.md'),
					new RecursiveReference(
						URI.joinPath(rootFolder, './file2.prompt.md'),
						[
							'/infinite-recursion/file2.prompt.md',
							'/infinite-recursion/folder1/some-other-folder/file5.prompt.md',
							'/infinite-recursion/file2.prompt.md',
						],
					),
				)),
				testDisposables.add(new ExpectedReference(
					URI.joinPath(rootFolder, './file1.md'),
					new NotPromptSnippetFile(
						URI.joinPath(rootFolder, './file1.md'),
						'Uggh oh!',
					),
				)),
			]
		));

		await test.run();
	});
});
