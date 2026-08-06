# symbol-tree-sitter

Provides symbols via Tree-sitter tags queries.

## Features

- **Buffer-based symbols**: reads symbols from the live buffer, so they work in new and unsaved files.
- **Tags queries**: derives symbols from a grammar's `tags.scm` query file.
- **Rich symbol shaping**: predicates can prepend, append, strip, and set the context and tag of each symbol.
- **Optional references**: can include references such as function calls in addition to definitions.

## Installation

To install `symbol-tree-sitter` search for _symbol-tree-sitter_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/symbol-tree-sitter`.

## Services

- **symbol.provider** (`1.0.0`): provided to supply symbols for a given file.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
