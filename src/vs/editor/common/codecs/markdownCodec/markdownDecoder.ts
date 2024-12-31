/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MarkdownLink } from './tokens/markdownLink.js';
import { NewLine } from '../linesCodec/tokens/newLine.js';
import { FormFeed } from '../simpleCodec/tokens/formFeed.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { VerticalTab } from '../simpleCodec/tokens/verticalTab.js';
import { ReadableStream } from '../../../../base/common/stream.js';
import { assert } from '../../../../base/common/assert.js';
import { CarriageReturn } from '../linesCodec/tokens/carriageReturn.js';
import { BaseDecoder } from '../../../../base/common/codecs/baseDecoder.js';
import { LeftBracket, RightBracket } from '../simpleCodec/tokens/brackets.js';
import { SimpleDecoder, TSimpleToken } from '../simpleCodec/simpleDecoder.js';
import { ParserBase, TAcceptTokenResult } from '../simpleCodec/parserBase.js';
import { LeftParenthesis, RightParenthesis } from '../simpleCodec/tokens/parentheses.js';

/**
 * Tokens handled by this decoder.
 */
export type TMarkdownToken = MarkdownLink | TSimpleToken;

/**
 * List of characters that stop a markdown link sequence.
 */
const MARKDOWN_LINK_STOP_CHARACTERS: readonly string[] = [CarriageReturn, NewLine, VerticalTab, FormFeed]
	.map((token) => { return token.symbol; });

/**
 * Parser that is responsible for parsing a `markdown link caption`,
 * e.g., the `[caption text]` part of the `[caption text](./some-link)` markdown link.
 */
class PartialMarkdownLinkCaption extends ParserBase<TSimpleToken, PartialMarkdownLinkCaption | MarkdownLinkCaption> {
	constructor(token: LeftBracket) {
		super([token]);
	}

	public accept(token: TSimpleToken): TAcceptTokenResult<PartialMarkdownLinkCaption | MarkdownLinkCaption> {
		// any of stop characters is are breaking a markdown link caption sequence
		if (MARKDOWN_LINK_STOP_CHARACTERS.includes(token.text)) {
			return {
				result: 'failure',
				wasTokenConsumed: false,
			};
		}

		// the `]` character ends the caption of a markdown link
		if (token instanceof RightBracket) {
			return {
				result: 'success',
				nextParser: new MarkdownLinkCaption([...this.tokens, token]),
				wasTokenConsumed: true,
			};
		}

		// otherwise, include the token in the sequence
		// and keep the current parser object instance
		this.currentTokens.push(token);
		return {
			result: 'success',
			nextParser: this,
			wasTokenConsumed: true,
		};
	}
}

/**
 * Parser that is responsible for transitioning from a `markdown link caption` to
 * a partial `markdown link`, e.g., from the `[caption text]` to `[caption text](some-link`.
 */
class MarkdownLinkCaption extends ParserBase<TSimpleToken, MarkdownLinkCaption | PartialMarkdownLink> {
	public accept(token: TSimpleToken): TAcceptTokenResult<MarkdownLinkCaption | PartialMarkdownLink> {
		// the `(` character starts the link part of a markdown link
		// that is the only character that can follow the caption
		if (token instanceof LeftParenthesis) {
			return {
				result: 'success',
				wasTokenConsumed: true,
				nextParser: new PartialMarkdownLink([...this.tokens], token),
			};
		}

		return {
			result: 'failure',
			wasTokenConsumed: false,
		};
	}
}

/**
 * Parser that is responsible for finishing to parse a `markdown link`,
 * e.g., from the `[caption text](some-partial-link..` tothe complete `[caption text](some-partial-link-reference)`.
 */
class PartialMarkdownLink extends ParserBase<TSimpleToken, PartialMarkdownLink | MarkdownLink> {
	/**
	 * Number of open parenthesis in the sequence.
	 * See comment in the {@linkcode accept} method for more details.
	 */
	private openParensCount: number = 1;

	constructor(
		protected readonly captionTokens: TSimpleToken[],
		token: LeftParenthesis,
	) {
		super([token]);
	}

	public override get tokens(): readonly TSimpleToken[] {
		return [...this.captionTokens, ...this.currentTokens];
	}

	public accept(token: TSimpleToken): TAcceptTokenResult<PartialMarkdownLink | MarkdownLink> {
		// markdown links allow for nested parenthesis inside the link reference part, but
		// the number of open parenthesis must match the number of closing parenthesis, e.g.:
		// 	- `[caption](/some/p()th/file.md)` is a valid markdown link
		// 	- `[caption](/some/p(th/file.md)` is an invalid markdown link
		// hence we use the `openParensCount` variable to keep track of the number of open
		// parenthesis encountered so far; then upon encountering a closing parenthesis we
		// decrement the `openParensCount` and if it reaches 0 - we consider the link reference
		// to be complete

		if (token instanceof LeftParenthesis) {
			this.openParensCount += 1;
		}

		if (token instanceof RightParenthesis) {
			this.openParensCount -= 1;

			// sanity check! this must alway hold true because we return a complete markdown
			// link as soon as we encounter matching number of closing parenthesis, hence
			// we must never have `openParensCount` that is less than 0
			assert(
				this.openParensCount >= 0,
				`Unexpected right parenthesis token encountered: '${token}'.`,
			);

			// the markdown link is complete as soon as we get the same number of closing parenthesis
			if (this.openParensCount === 0) {
				const { startLineNumber, startColumn } = this.captionTokens[0].range;

				// create link caption string
				const caption = this.captionTokens
					.map((token) => { return token.text; })
					.join('');

				// create link reference string
				this.currentTokens.push(token);
				const reference = this.currentTokens
					.map((token) => { return token.text; }).join('');

				// return complete markdown link object
				return {
					result: 'success',
					wasTokenConsumed: true,
					nextParser: new MarkdownLink(
						startLineNumber,
						startColumn,
						caption,
						reference,
					),
				};
			}
		}

		// any of stop characters is are breaking a markdown link reference sequence
		if (MARKDOWN_LINK_STOP_CHARACTERS.includes(token.text)) {
			return {
				result: 'failure',
				wasTokenConsumed: false,
			};
		}

		// the rest of the tokens can be included in the sequence
		this.currentTokens.push(token);
		return {
			result: 'success',
			nextParser: this,
			wasTokenConsumed: true,
		};
	}
}

/**
 * Decoder capable of parsing markdown entities (e.g., links) from a sequence of simple tokens.
 */
export class MarkdownDecoder extends BaseDecoder<TMarkdownToken, TSimpleToken> {
	/**
	 * Current parser object that is responsible for parsing a sequence of tokens
	 * into some markdown entity.
	 */
	private current?: PartialMarkdownLinkCaption | MarkdownLinkCaption | PartialMarkdownLink;

	constructor(
		stream: ReadableStream<VSBuffer>,
	) {
		super(new SimpleDecoder(stream));
	}

	protected override onStreamData(token: TSimpleToken): void {
		// markdown links start with `[` character, so here we can
		// initiate the process of parsing a markdown link
		if (token instanceof LeftBracket && !this.current) {
			this.current = new PartialMarkdownLinkCaption(token);

			return;
		}

		// if current parser was not initiated before, - we are in the general
		// "text" mode, therefore re-emit the token immediatelly and continue
		if (!this.current) {
			this._onData.fire(token);
			return;
		}

		// if there is a current parser object, submit the token to it
		// so it can progress with parsing the tokens sequence
		const parseResult = this.current.accept(token);
		if (parseResult.result === 'success') {
			// if got a parsed out `MarkdownLink` back, emit it
			// then reset the current parser object
			if (parseResult.nextParser instanceof MarkdownLink) {
				this._onData.fire(parseResult.nextParser);
				delete this.current;
			} else {
				// otherwise, update the current parser object
				this.current = parseResult.nextParser;
			}
		} else {
			// if failed to parse a sequence of a tokens as a single markdown
			// entity (e.g., a link), re-emit the tokens accumulated so far
			// then reset the current parser object
			for (const token of this.current.tokens) {
				this._onData.fire(token);
				delete this.current;
			}
		}

		// if token was not consumed by the parser, call `onStreamData` again
		// so the token is properly handled by the decoder in the case when a
		// new sequence starts with this token
		if (!parseResult.wasTokenConsumed) {
			this.onStreamData(token);
		}
	}

	protected override onStreamEnd(): void {
		// if the stream has ended and there is a current incomplete parser
		// object present, then re-emit its tokens as standalone entities
		if (this.current) {
			const { tokens } = this.current;
			delete this.current;

			for (const token of [...tokens]) {
				this._onData.fire(token);
			}
		}

		super.onStreamEnd();
	}
}
