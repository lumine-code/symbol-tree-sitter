const CaptureOrganizer = require("./capture-organizer");
const WorkBudget = require("./work-budget");
const sortSymbols = require("./sort-symbols");
const { CompositeDisposable, Emitter } = require("lumine");

const ASYNC_CAPTURE_THRESHOLD = 4096;

class TreeSitterProvider {
  constructor() {
    this.packageName = "symbol-tree-sitter";
    this.name = "Tree-sitter";
    this.isExclusive = true;
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
        this.emitter.emit("should-clear-cache", { provider: this });
      }),
    );

    const invalidateGrammarCache = () => {
      if (this.destroyed) return;
      for (const { controller } of this.pendingGrammarSettlements.values()) {
        controller.abort();
      }
      this.pendingGrammarSettlements.clear();
      this.cancelSymbolRequests();
      this.emitter.emit("should-clear-cache", { provider: this });
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
  }

  cancelSymbolRequests() {
    for (const controller of this.pendingSymbolRequests) controller.abort();
  }

  onShouldClearCache(callback) {
    return this.emitter.on("should-clear-cache", callback);
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
          this.emitter.emit("should-clear-cache", { editor });
        }
      },
      () => {
        if (this.pendingGrammarSettlements.get(editor) === pending) {
          this.pendingGrammarSettlements.delete(editor);
        }
      },
    );
  }

  canProvideSymbols(meta) {
    let { editor, type } = meta;
    if (this.destroyed) return false;

    // This provider can't crawl the whole project.
    if (type === "project" || type === "project-find") return false;

    // This provider works only for editors that expose grammar query captures.
    if (
      !editor?.hasGrammarQuery ||
      !editor?.getGrammarQueryCaptureGroups ||
      !editor?.whenGrammarSettled ||
      !editor?.getGrammar
    ) {
      return false;
    }

    // This provider needs at least one layer to have a tags query.
    if (!editor.hasGrammarQuery("tagsQuery")) {
      const grammar = editor.getGrammar();
      if (grammar !== lumine.grammars.nullGrammar) {
        // An injection with a tags query may appear only after the root
        // grammar's first parse. Decline for now, then ask the hub to retry once
        // the editor's complete grammar topology has settled.
        this.watchGrammarSettled(editor, grammar);
      }
      return false;
    }

    const pending = this.pendingGrammarSettlements.get(editor);
    if (pending) {
      this.pendingGrammarSettlements.delete(editor);
      pending.controller.abort();
    }

    // Return a value that will beat the built-in `ctags` provider, but which
    // will (by default) lose to any provider from a community package.
    return 0.999;
  }

  async getSymbols(meta) {
    let { editor, signal } = meta;
    if (
      this.destroyed ||
      signal?.aborted ||
      editor?.isDestroyed?.() ||
      !editor?.getGrammarQueryCaptureGroups
    ) {
      return null;
    }

    const controller = new AbortController();
    const cancel = () => controller.abort();
    const invalidate = () => {
      if (controller.signal.aborted) return;
      // The hub cancels its outer request synchronously on invalidation. Tell
      // it before returning null, so a withdrawn generation is not mistaken
      // for a provider that failed to answer or cached as an empty list.
      this.emitter.emit("should-clear-cache", { editor });
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
      if (controller.signal.aborted || groups.length === 0) return null;

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
      signal?.removeEventListener("abort", cancel);
      this.pendingSymbolRequests.delete(controller);
      if (organizer && organizer !== this.captureOrganizer) organizer.clear();
    }
  }
}

module.exports = TreeSitterProvider;
