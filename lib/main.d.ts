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
  canProvideDocumentSymbols(editor: TextEditor): 0.999 | false;
  getDocumentSymbols(
    editor: TextEditor,
    options?: {
      signal?: AbortSignal;
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
