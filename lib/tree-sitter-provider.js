const CaptureOrganizer = require("./capture-organizer");
const WorkBudget = require("./work-budget");
const sortSymbols = require("./sort-symbols");
const { CompositeDisposable, Emitter } = require("lumine");

const ASYNC_CAPTURE_THRESHOLD = 4096;

class TreeSitterProvider {
  constructor() {
    this.packageName = "symbol-tree-sitter";
    this.name = "Tree-sitter";
    this.captureOrganizer = new CaptureOrganizer();
    this.emitter = new Emitter();
    this.pendingGrammarSettlements = new Map();
    this.pendingSymbolRequests = new Set();
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
    this.disposables.add(
      lumine.grammars.onDidAddGrammar(invalidateGrammarCache),
      lumine.grammars.onDidUpdateGrammar(invalidateGrammarCache),
      lumine.grammars.onDidRemoveGrammar(invalidateGrammarCache),
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
    this.captureOrganizer.destroy();
    this.disposables.dispose();
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
      ["hasGrammarQuery", "getGrammarQueryCaptureGroups", "whenGrammarSettled", "getGrammar"].every(
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
    for (const event of ["onDidChange", "onDidChangeGrammar", "onDidDestroy"]) {
      if (editor[event]) subscriptions.add(editor[event](invalidate));
    }

    let organizer;
    try {
      const groups = await editor.getGrammarQueryCaptureGroups("tagsQuery", {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return null;
      if (groups.length === 0) return [];

      const captureCount = groups.reduce((count, group) => count + group.captures.length, 0);
      const asynchronous = captureCount >= ASYNC_CAPTURE_THRESHOLD;
      organizer = asynchronous ? new CaptureOrganizer() : this.captureOrganizer;
      const budget = new WorkBudget({ signal: controller.signal });
      let results = [];
      for (const { captures } of groups) {
        if (controller.signal.aborted) return null;
        const symbols = asynchronous
          ? await organizer.processAsync(captures, { budget })
          : organizer.process(captures);
        if (!symbols || controller.signal.aborted) return null;
        for (const symbol of symbols) {
          if (controller.signal.aborted) return null;
          results.push(symbol);
          if (budget.shouldYield() && !(await budget.yield())) return null;
        }
      }

      if (results.length >= ASYNC_CAPTURE_THRESHOLD) {
        results = await sortSymbols(results, budget);
      } else {
        results.sort((a, b) => a.position.compare(b.position));
      }
      return controller.signal.aborted ? null : results;
    } catch (error) {
      if (controller.signal.aborted) return null;
      throw error;
    } finally {
      subscriptions.dispose();
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      this.pendingSymbolRequests.delete(controller);
      if (organizer && organizer !== this.captureOrganizer) organizer.clear();
    }
  }
}

module.exports = TreeSitterProvider;
