# Raw word timestamp contract

The harness validates raw speech-recognition alignment times. A word may have a point timestamp: its start and end are equal. Validation preserves that observation without expanding, shifting, or dropping the word.

## Upstream evidence

The Transformers.js 3.8.1 implementation permits repeated alignment times:

- [src/utils/maths.js](https://github.com/huggingface/transformers.js/blob/3.8.1/src/utils/maths.js): dynamic_time_warping can advance the text position without advancing the audio position.
- [src/models.js](https://github.com/huggingface/transformers.js/blob/3.8.1/src/models.js): _extract_token_timestamps maps those audio positions to token times.
- [src/tokenizers.js](https://github.com/huggingface/transformers.js/blob/3.8.1/src/tokenizers.js): collateWordTimestamps takes the first token's start and the last token's end without adding a minimum word duration.

From these code paths, equal word boundaries are a valid possible alignment result. This describes the pinned implementation; it does not establish word-level timing accuracy.

## Validation rules

For a fixture of duration D seconds:

- Every word has finite numeric times satisfying 0 <= start <= end <= D + 1. Missing values, nulls, numeric strings, and reversed intervals fail.
- Word starts are nondecreasing. Ties and overlapping word intervals are allowed.
- At least one word has positive duration. A transcript made entirely of point timestamps fails even if its sentence or clip spans are positive.
- Sentence spans retain strictly positive duration. The existing speech-recognition, sentence identity, embedding coverage, clip validity, build identity, and optional-lane checks also apply.

The final sanitized model summary includes zeroDurationWordCount. It counts accepted point words while retaining no raw word text, sentence IDs, or individual timestamp samples. Progress-only checkpoints still cannot certify a passing model check.

Regression cases live beside coreResult() in scripts/harness.test.mjs. They cover point timestamps, tied starts and overlaps, malformed or decreasing times, an all-point transcript, zero-duration sentences, the inclusive D + 1 boundary, and preservation of the count through reporting.
