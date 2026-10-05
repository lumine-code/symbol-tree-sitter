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

- `symbol.document-provider@1.0.0`: describes the current buffer's Tree-sitter source through `getDocumentSymbolSources(editor, { signal })` and retrieves it through `getDocumentSymbols(editor, { sourceId, signal, timeoutMs })`. The source has the stable ID `symbol-tree-sitter`, label `TS` and score `0.999`. `onDidInvalidateDocumentSymbols(callback)` reports changes to availability or results.

Automatic selection allows an available language server to answer first. Choosing Tree-sitter explicitly keeps this buffer on that source; requesting any other source ID returns no answer. A valid empty result stays empty.

Tree-sitter stays available for every supported text buffer, including plain text and grammars without symbol queries. Such buffers return an empty symbol list. Injected languages can add symbols after parsing settles, at which point the provider invalidates the buffer's results.

Symbols come from the editor's public grammar-query API, including injected languages. Buffer changes cancel stale work, and grammar or configuration changes invalidate cached document results. This provider performs no project scan and offers no workspace search or definition lookup.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
