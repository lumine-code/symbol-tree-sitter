const { CompositeDisposable, Emitter, Point, Range } = require("lumine");
const { decode } = require("./symbol-packets");
const coordinates = { Point, Range };

class TreeSitterProvider {
  constructor() {
    this.packageName = "symbol-tree-sitter";
    this.name = "Tree-sitter";
    this.emitter = new Emitter();
    this.pendingGrammarSettlements = new Map();
    this.pendingSymbolRequests = new Set();
    this.grammarQuerySubscriptions = new Map();
    this.destroyed = false;
    this.disposables = new CompositeDisposable();
    this.disposables.add(
      lumine.config.onDidChange("symbol-tree-sitter", () => {
        // Signal the consumer to clear its cache whenever we change the package
        // config.
        this.cancelSymbolRequests();
        this.emitter.emit("did-invalidate-document-symbols", { editor: null });
      }),
    );

    const invalidateGrammarCache = () => {
      if (this.destroyed) return;
      for (const { controller } of this.pendingGrammarSettlements.values()) {
        controller.abort();
      }
      this.pendingGrammarSettlements.clear();
      this.cancelSymbolRequests();
      this.emitter.emit("did-invalidate-document-symbols", { editor: null });
    };
    const watch = (grammar) => {
      if (!grammar?.onDidChangeQuery || this.grammarQuerySubscriptions.has(grammar)) return;
      const subscription = grammar.onDidChangeQuery(({ queryType }) => {
        if (queryType === "tagsQuery" || queryType === "injectionsQuery") invalidateGrammarCache();
      });
      this.grammarQuerySubscriptions.set(grammar, subscription);
      this.disposables.add(subscription);
    };
    for (const grammar of lumine.grammars.getGrammars()) watch(grammar);
    this.disposables.add(
      lumine.grammars.onDidAddGrammar((grammar) => {
        watch(grammar);
        invalidateGrammarCache();
      }),
      lumine.grammars.onDidUpdateGrammar(invalidateGrammarCache),
      lumine.grammars.onDidRemoveGrammar((grammar) => {
        const subscription = this.grammarQuerySubscriptions.get(grammar);
        if (subscription) {
          this.grammarQuerySubscriptions.delete(grammar);
          this.disposables.remove(subscription);
          subscription.dispose();
        }
        invalidateGrammarCache();
      }),
    );
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const { controller } of this.pendingGrammarSettlements.values()) {
      controller.abort();
    }
    this.pendingGrammarSettlements.clear();
    this.cancelSymbolRequests();
    this.disposables.dispose();
    this.grammarQuerySubscriptions.clear();
    this.emitter.dispose();
  }

  cancelSymbolRequests() {
    for (const controller of this.pendingSymbolRequests) controller.abort();
  }

  onDidInvalidateDocumentSymbols(callback) {
    return this.emitter.on("did-invalidate-document-symbols", callback);
  }

  watchGrammarSettled(editor, grammar) {
    if (this.destroyed || !editor?.whenGrammarSettled) return;

    const previous = this.pendingGrammarSettlements.get(editor);
    if (previous?.grammar === grammar) return;
    if (previous) {
      this.pendingGrammarSettlements.delete(editor);
      previous.controller.abort();
    }

    const controller = new AbortController();
    let promise;
    try {
      promise = Promise.resolve(editor.whenGrammarSettled({ signal: controller.signal }));
    } catch {
      return;
    }

    const pending = { controller, grammar, promise };
    this.pendingGrammarSettlements.set(editor, pending);
    promise.then(
      (settled) => {
        if (this.pendingGrammarSettlements.get(editor) !== pending) return;
        this.pendingGrammarSettlements.delete(editor);
        if (this.destroyed || !settled) return;
        if (editor.hasGrammarQuery?.("tagsQuery")) {
          this.emitter.emit("did-invalidate-document-symbols", { editor });
        }
      },
      () => {
        if (this.pendingGrammarSettlements.get(editor) === pending) {
          this.pendingGrammarSettlements.delete(editor);
        }
      },
    );
  }

  getDocumentSymbolSources(editor, { signal } = {}) {
    signal?.throwIfAborted();
    if (this.destroyed || !this.supportsEditor(editor)) return [];

    if (!editor.hasGrammarQuery("tagsQuery")) {
      const grammar = editor.getGrammar();
      if (grammar !== lumine.grammars.nullGrammar) {
        // An injection with a tags query may appear only after the root
        // grammar's first parse. Ask the hub to retry once
        // the editor's complete grammar topology has settled.
        this.watchGrammarSettled(editor, grammar);
      }
    } else {
      const pending = this.pendingGrammarSettlements.get(editor);
      if (pending) {
        this.pendingGrammarSettlements.delete(editor);
        pending.controller.abort();
      }
    }

    // Prefer a language server when it can serve this document.
    return [
      {
        id: "symbol-tree-sitter",
        name: "Tree-sitter",
        shortLabel: "TS",
        score: 0.999,
        state: "ready",
        execution: "local",
      },
    ];
  }

  supportsEditor(editor) {
    return (
      !editor?.isDestroyed?.() &&
      editor?.getGrammar?.() !== lumine.grammars.nullGrammar &&
      editor?.getSyntaxAvailability?.()?.available !== false &&
      ["hasGrammarQuery", "analyzeSyntax", "whenGrammarSettled", "getGrammar"].every(
        (method) => typeof editor?.[method] === "function",
      )
    );
  }

  async getDocumentSymbols(editor, { sourceId, signal, timeoutMs } = {}) {
    if (
      sourceId !== "symbol-tree-sitter" ||
      this.destroyed ||
      signal?.aborted ||
      !this.supportsEditor(editor)
    ) {
      return null;
    }

    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = timeoutMs > 0 ? setTimeout(cancel, timeoutMs) : null;
    const invalidate = () => {
      if (controller.signal.aborted) return;
      // The hub cancels its outer request synchronously on invalidation. Tell
      // it before returning null, so a withdrawn generation is not mistaken
      // for a provider that failed to answer or cached as an empty list.
      this.emitter.emit("did-invalidate-document-symbols", { editor });
      cancel();
    };
    const subscriptions = new CompositeDisposable();
    this.pendingSymbolRequests.add(controller);
    signal?.addEventListener("abort", cancel, { once: true });
    // Editor onDidChange also includes display resets such as soft wrapping.
    // Only source edits invalidate the captured syntax nodes.
    const buffer = editor.getBuffer?.();
    if (buffer?.onDidChangeText) subscriptions.add(buffer.onDidChangeText(invalidate));
    for (const event of ["onDidChangeGrammar", "onDidDestroy"]) {
      if (editor[event]) subscriptions.add(editor[event](invalidate));
    }

    try {
      const results = [];
      const dictionary = [];
      const summary = await editor.analyzeSyntax(
        require.resolve("./syntax-analysis"),
        "symbols",
        null,
        {
          signal: controller.signal,
          onChunk(packet) {
            controller.signal.throwIfAborted();
            for (const symbol of decode(packet, dictionary, coordinates)) results.push(symbol);
          },
        },
      );
      if (controller.signal.aborted || summary === null) return null;
      if (summary.count !== results.length) throw new Error("Incomplete syntax symbol stream");
      return results;
    } catch (error) {
      if (controller.signal.aborted) return null;
      throw error;
    } finally {
      subscriptions.dispose();
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      this.pendingSymbolRequests.delete(controller);
    }
  }
}

module.exports = TreeSitterProvider;
