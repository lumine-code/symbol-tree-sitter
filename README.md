# symbol-tree-sitter

Provides symbols via Tree-sitter tags queries.

## Features

- **Buffer-based symbols**: reads symbols from the live buffer, so they work in new and unsaved files.
- **Tags queries**: derives symbols from a grammar's `tags.scm` query file.
- **Rich symbol shaping**: predicates can prepend, append, strip, and set the context and tag of each symbol.
- **Optional references**: can include references such as function calls in addition to definitions.

## Installation

To install `symbol-tree-sitter` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/symbol-tree-sitter`.

## Services

- `symbol.document-provider@1.0.0`: provides symbols for the current buffer through `canProvideDocumentSymbols(editor)`, `getDocumentSymbols(editor, { signal, timeoutMs })` and `onDidInvalidateDocumentSymbols(callback)`. Its score of `0.999` allows a language server to answer first. A valid empty result stays empty; the consumer falls back when a provider is unavailable or fails.

Symbols come from the editor's public grammar-query API, including injected languages. Buffer changes cancel stale work, and grammar or configuration changes invalidate cached document results. This provider performs no project scan and offers no workspace search or definition lookup.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
