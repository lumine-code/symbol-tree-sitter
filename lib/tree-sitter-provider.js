const CaptureOrganizer = require("./capture-organizer");
const { Emitter } = require("lumine");

class TreeSitterProvider {
  constructor() {
    this.packageName = "symbol-tree-sitter";
    this.name = "Tree-sitter";
    this.isExclusive = true;
    this.captureOrganizer = new CaptureOrganizer();
    this.emitter = new Emitter();
    this.pendingLanguageModes = new WeakSet();
    this.destroyed = false;
    this.disposable = lumine.config.onDidChange("symbol-tree-sitter", () => {
      // Signal the consumer to clear its cache whenever we change the package
      // config.
      this.emitter.emit("should-clear-cache", { provider: this });
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.captureOrganizer.destroy();
    this.disposable.dispose();
  }

  onShouldClearCache(callback) {
    return this.emitter.on("should-clear-cache", callback);
  }

  watchLanguageModeReady(editor, languageMode) {
    if (!languageMode?.ready?.then || this.pendingLanguageModes.has(languageMode)) return;
    this.pendingLanguageModes.add(languageMode);
    Promise.resolve(languageMode.ready).then(
      () => {
        this.pendingLanguageModes.delete(languageMode);
        if (this.destroyed) return;
        if (editor?.getBuffer()?.getLanguageMode() !== languageMode) return;
        this.emitter.emit("should-clear-cache", { editor });
      },
      () => this.pendingLanguageModes.delete(languageMode),
    );
  }

  canProvideSymbols(meta) {
    let { editor, type } = meta;

    // This provider can't crawl the whole project.
    if (type === "project" || type === "project-find") return false;

    // This provider works only for editors with Tree-sitter grammars.
    let languageMode = editor?.getBuffer()?.getLanguageMode();
    if (!languageMode?.getQueryCaptureGroups || !languageMode?.hasQuery) {
      return false;
    }

    // This provider needs at least one layer to have a tags query.
    if (!languageMode.hasQuery("tagsQuery")) {
      // Restored editors expose the language mode before its root layer and
      // queries finish loading. Decline for now, then ask the hub to retry the
      // same editor exactly once when that cold start completes.
      if (!languageMode.isTokenized?.()) {
        this.watchLanguageModeReady(editor, languageMode);
      }
      return false;
    }

    // Return a value that will beat the built-in `ctags` provider, but which
    // will (by default) lose to any provider from a community package.
    return 0.999;
  }

  async getSymbols(meta) {
    let { editor, signal } = meta;
    let languageMode = editor?.getBuffer()?.getLanguageMode();
    if (!languageMode) return null;

    const groups = await languageMode.getQueryCaptureGroups("tagsQuery", { signal });
    if (signal.aborted || editor?.getBuffer()?.getLanguageMode() !== languageMode) return null;
    if (groups.length === 0) return null;

    let results = [];
    for (const { captures } of groups) {
      results.push(...this.captureOrganizer.process(captures));
    }
    results.sort((a, b) => a.position.compare(b.position));
    return results;
  }
}

module.exports = TreeSitterProvider;
