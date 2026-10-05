import type { Disposable, Point, Range, TextEditor } from "lumine";

export interface DocumentSymbol {
  name: string;
  shortName?: string;
  tag?: string;
  icon?: string | null;
  context?: string;
  position: Point;
  range: Range;
}

export interface DocumentSymbolProvider {
  name: "Tree-sitter";
  packageName: "symbol-tree-sitter";
  getDocumentSymbolSources(
    editor: TextEditor,
    options?: { signal?: AbortSignal },
  ): Array<{
    id: "symbol-tree-sitter";
    name: "Tree-sitter";
    shortLabel: "TS";
    score: 0.999;
    state: "ready";
    execution: "local";
  }>;
  getDocumentSymbols(
    editor: TextEditor,
    options: {
      sourceId: "symbol-tree-sitter";
      signal?: AbortSignal;
      /** Zero disables the request deadline; buffer changes and AbortSignal still cancel stale extraction. */
      timeoutMs?: number;
    },
  ): Promise<DocumentSymbol[] | null>;
  /** A null editor invalidates every document after grammar or configuration changes. */
  onDidInvalidateDocumentSymbols(
    callback: (event: { editor: TextEditor | null }) => void,
  ): Disposable;
}

export function activate(): void;
export function deactivate(): void;
export function provideDocumentSymbolProvider(): DocumentSymbolProvider;
