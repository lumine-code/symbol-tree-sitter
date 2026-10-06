const path = require("path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/fs-temp");
const TreeSitterProvider = require("../lib/tree-sitter-provider");

// Just for syntax highlighting.
function scm(strings) {
  return strings.join("");
}

function getEditor() {
  return lumine.workspace.getActiveTextEditor();
}

const queryEditor = (overrides = {}) => ({
  hasGrammarQuery: () => true,
  getGrammar: () => ({}),
  whenGrammarSettled: () => Promise.resolve(true),
  getGrammarQueryCaptureGroups: () => Promise.resolve([]),
  ...overrides,
});

const sourceScore = (provider, editor) => {
  const source = provider.getDocumentSymbolSources(editor)[0];
  return source?.state === "ready" ? source.score : false;
};

let provider;

async function readDocumentSymbols(editor) {
  let controller = new AbortController();
  let symbols = await provider.getDocumentSymbols(editor, {
    sourceId: "symbol-tree-sitter",
    signal: controller.signal,
  });

  return symbols;
}

describe("TreeSitterProvider", () => {
  let directory, editor;

  afterEach(() => {
    provider?.destroy();
    provider = null;
  });

  it("publishes only the document service and replaces its destroyed generation on reactivation", async () => {
    let pkg = await lumine.packages.activatePackage("symbol-tree-sitter");
    const first = pkg.mainModule.provideDocumentSymbolProvider();
    expect(pkg.mainModule.provideDocumentSymbolProvider()).toBe(first);
    expect(typeof first.getDocumentSymbols).toBe("function");
    expect(typeof first.onDidInvalidateDocumentSymbols).toBe("function");
    expect(pkg.metadata.providedServices["symbol.workspace-provider"]).toBeUndefined();
    expect(pkg.metadata.providedServices["symbol.definition-provider"]).toBeUndefined();
    await lumine.packages.deactivatePackage("symbol-tree-sitter");
    expect(first.destroyed).toBe(true);
    pkg = await lumine.packages.activatePackage("symbol-tree-sitter");
    expect(pkg.mainModule.provideDocumentSymbolProvider()).not.toBe(first);
    expect(pkg.mainModule.provideDocumentSymbolProvider().destroyed).toBe(false);
  });

  it("uses only the public editor grammar-query facade", () => {
    const grammar = {};
    const editor = queryEditor({
      getBuffer() {
        throw new Error("must not inspect the language mode");
      },
      hasGrammarQuery: () => true,
      getGrammar: () => grammar,
      getGrammarQueryCaptureGroups() {},
      whenGrammarSettled() {},
    });
    const provider = new TreeSitterProvider();
    expect(sourceScore(provider, editor)).toBe(0.999);
    provider.destroy();
  });

  it("describes its stable source and declines another source ID", async () => {
    const editor = queryEditor({
      hasGrammarQuery: () => true,
      getGrammar: () => ({}),
      whenGrammarSettled() {},
      getGrammarQueryCaptureGroups: jasmine.createSpy("captures").and.resolveTo([{ captures: [] }]),
    });
    const provider = new TreeSitterProvider();
    expect(provider.getDocumentSymbolSources(editor)).toEqual([
      {
        id: "symbol-tree-sitter",
        name: "Tree-sitter",
        shortLabel: "TS",
        score: 0.999,
        state: "ready",
        execution: "local",
      },
    ]);
    expect(await provider.getDocumentSymbols(editor, { sourceId: "ide:any" })).toBeNull();
    expect(await provider.getDocumentSymbols(editor)).toBeNull();
    expect(editor.getGrammarQueryCaptureGroups).not.toHaveBeenCalled();
    provider.destroy();
  });

  it("keeps Tree-sitter ready when this grammar has no tags query", () => {
    const editor = queryEditor({
      hasGrammarQuery: () => false,
      getGrammar: () => lumine.grammars.nullGrammar,
      whenGrammarSettled() {},
      getGrammarQueryCaptureGroups() {},
    });
    const provider = new TreeSitterProvider();
    const source = provider.getDocumentSymbolSources(editor)[0];
    expect(source.id).toBe("symbol-tree-sitter");
    expect(source.state).toBe("ready");
    expect(source.message).toBeUndefined();
    provider.destroy();
  });

  it("invalidates a cold editor once an injected tags query appears", async () => {
    let resolveSettlement;
    const settlement = new Promise((resolve) => (resolveSettlement = resolve));
    let hasTagsQuery = false;
    const grammar = {};
    const editor = queryEditor({
      hasGrammarQuery: () => hasTagsQuery,
      getGrammar: () => grammar,
      getGrammarQueryCaptureGroups() {},
      whenGrammarSettled: jasmine.createSpy("whenGrammarSettled").and.returnValue(settlement),
    });
    const provider = new TreeSitterProvider();
    const events = [];
    provider.onDidInvalidateDocumentSymbols((event) => events.push(event));

    expect(sourceScore(provider, editor)).toBe(0.999);
    expect(sourceScore(provider, editor)).toBe(0.999);
    expect(editor.whenGrammarSettled).toHaveBeenCalledTimes(1);
    hasTagsQuery = true;
    resolveSettlement(true);
    await settlement;
    await Promise.resolve();

    expect(events).toEqual([{ editor }]);
    expect(sourceScore(provider, editor)).toBe(0.999);
    expect(events.length).toBe(1);
    provider.destroy();
  });

  it("claims a root tags-query declaration before its grammar settles", () => {
    const grammar = {};
    const editor = queryEditor({
      hasGrammarQuery: () => true,
      getGrammar: () => grammar,
      getGrammarQueryCaptureGroups() {},
      whenGrammarSettled: jasmine.createSpy("whenGrammarSettled"),
    });
    const provider = new TreeSitterProvider();

    expect(sourceScore(provider, editor)).toBe(0.999);
    expect(editor.whenGrammarSettled).not.toHaveBeenCalled();
    provider.destroy();
  });

  it("deduplicates only an in-flight no-query wait and watches the same grammar again", async () => {
    let hasTagsQuery = false;
    const grammar = {};
    const waits = [];
    const whenGrammarSettled = jasmine.createSpy("whenGrammarSettled").and.callFake(
      ({ signal }) =>
        new Promise((resolve) => {
          waits.push({ resolve, signal });
          signal.addEventListener("abort", () => resolve(false), { once: true });
        }),
    );
    const editor = queryEditor({
      hasGrammarQuery: () => hasTagsQuery,
      getGrammar: () => grammar,
      getGrammarQueryCaptureGroups() {},
      whenGrammarSettled,
    });
    const provider = new TreeSitterProvider();
    const invalidate = jasmine.createSpy("invalidate");
    provider.onDidInvalidateDocumentSymbols(invalidate);

    expect(sourceScore(provider, editor)).toBe(0.999);
    expect(sourceScore(provider, editor)).toBe(0.999);
    expect(whenGrammarSettled).toHaveBeenCalledTimes(1);
    waits[0].resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(invalidate).not.toHaveBeenCalled();

    expect(sourceScore(provider, editor)).toBe(0.999);
    expect(whenGrammarSettled).toHaveBeenCalledTimes(2);
    hasTagsQuery = true;
    waits[1].resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(invalidate).toHaveBeenCalledOnceWith({ editor });
    expect(sourceScore(provider, editor)).toBe(0.999);
    provider.destroy();
  });

  it("does not watch a null grammar or restart after provider destruction", () => {
    const whenGrammarSettled = jasmine.createSpy("whenGrammarSettled");
    const editor = queryEditor({
      hasGrammarQuery: () => false,
      getGrammar: () => lumine.grammars.nullGrammar,
      getGrammarQueryCaptureGroups() {},
      whenGrammarSettled,
    });
    const provider = new TreeSitterProvider();

    expect(sourceScore(provider, editor)).toBe(0.999);
    expect(whenGrammarSettled).not.toHaveBeenCalled();
    provider.destroy();
    expect(sourceScore(provider, editor)).toBe(false);
    expect(whenGrammarSettled).not.toHaveBeenCalled();
  });

  it("watches again when the root grammar identity changes", async () => {
    let grammar = {};
    const whenGrammarSettled = jasmine.createSpy("whenGrammarSettled").and.resolveTo(true);
    const editor = queryEditor({
      hasGrammarQuery: () => false,
      getGrammar: () => grammar,
      getGrammarQueryCaptureGroups() {},
      whenGrammarSettled,
    });
    const provider = new TreeSitterProvider();

    expect(sourceScore(provider, editor)).toBe(0.999);
    await Promise.resolve();
    await Promise.resolve();
    expect(whenGrammarSettled).toHaveBeenCalledTimes(1);

    grammar = {};
    expect(sourceScore(provider, editor)).toBe(0.999);
    await Promise.resolve();
    await Promise.resolve();
    expect(whenGrammarSettled).toHaveBeenCalledTimes(2);
    provider.destroy();
  });

  it("replaces an in-flight waiter when the root grammar identity changes", async () => {
    const grammarA = {};
    const grammarB = {};
    let grammar = grammarA;
    let hasTagsQuery = false;
    const waits = [];
    const editor = queryEditor({
      hasGrammarQuery: () => hasTagsQuery,
      getGrammar: () => grammar,
      getGrammarQueryCaptureGroups() {},
      whenGrammarSettled({ signal }) {
        return new Promise((resolve) => {
          const wait = { grammar, resolve, signal };
          waits.push(wait);
          signal.addEventListener("abort", () => resolve(false), { once: true });
        });
      },
    });
    const provider = new TreeSitterProvider();
    const events = [];
    provider.onDidInvalidateDocumentSymbols((event) => events.push(event));

    expect(sourceScore(provider, editor)).toBe(0.999);
    expect(waits.length).toBe(1);
    expect(waits[0].grammar).toBe(grammarA);

    grammar = grammarB;
    expect(sourceScore(provider, editor)).toBe(0.999);
    expect(waits.length).toBe(2);
    expect(waits[0].signal.aborted).toBe(true);
    expect(waits[1].grammar).toBe(grammarB);

    hasTagsQuery = true;
    waits[1].resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual([{ editor }]);
    expect(provider.pendingGrammarSettlements.size).toBe(0);
    provider.destroy();
  });

  it("restarts an in-flight waiter when the grammar registry invalidates the same root", async () => {
    let grammarAdded;
    const grammarSubscription = { dispose: jasmine.createSpy("grammar subscription dispose") };
    spyOn(lumine.grammars, "onDidAddGrammar").and.callFake((callback) => {
      grammarAdded = callback;
      return grammarSubscription;
    });

    const grammar = {};
    let hasTagsQuery = false;
    const waits = [];
    const editor = queryEditor({
      hasGrammarQuery: () => hasTagsQuery,
      getGrammar: () => grammar,
      getGrammarQueryCaptureGroups() {},
      whenGrammarSettled({ signal }) {
        return new Promise((resolve) => {
          waits.push({ resolve, signal });
          signal.addEventListener("abort", () => resolve(false), { once: true });
        });
      },
    });
    const provider = new TreeSitterProvider();
    const events = [];
    provider.onDidInvalidateDocumentSymbols((event) => {
      events.push(event);
      if (event.editor === null) {
        sourceScore(provider, editor);
      }
    });

    expect(sourceScore(provider, editor)).toBe(0.999);
    expect(waits.length).toBe(1);

    grammarAdded();
    expect(waits[0].signal.aborted).toBe(true);
    expect(waits.length).toBe(2);

    hasTagsQuery = true;
    waits[1].resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual([{ editor: null }, { editor }]);
    expect(provider.pendingGrammarSettlements.size).toBe(0);
    provider.destroy();
    expect(grammarSubscription.dispose).toHaveBeenCalledTimes(1);
  });

  it("invalidates the provider for grammar add, update, and removal", async () => {
    const callbacks = {};
    const listenerDisposables = {};
    for (const [methodName, eventName] of [
      ["onDidAddGrammar", "add"],
      ["onDidUpdateGrammar", "update"],
      ["onDidRemoveGrammar", "remove"],
    ]) {
      listenerDisposables[eventName] = { dispose: jasmine.createSpy(`${eventName} dispose`) };
      spyOn(lumine.grammars, methodName).and.callFake((callback) => {
        callbacks[eventName] = callback;
        return listenerDisposables[eventName];
      });
    }

    const grammar = {};
    let hasTagsQuery = false;
    const editor = queryEditor({
      hasGrammarQuery: () => hasTagsQuery,
      getGrammar: () => grammar,
      getGrammarQueryCaptureGroups() {},
      whenGrammarSettled: () => Promise.resolve(true),
    });
    const provider = new TreeSitterProvider();
    const events = [];
    provider.onDidInvalidateDocumentSymbols((event) => events.push(event));

    expect(sourceScore(provider, editor)).toBe(0.999);
    await Promise.resolve();
    await Promise.resolve();
    expect(provider.pendingGrammarSettlements.size).toBe(0);

    hasTagsQuery = true;
    callbacks.add();
    expect(events).toEqual([{ editor: null }]);
    expect(sourceScore(provider, editor)).toBe(0.999);

    callbacks.update();
    callbacks.remove();
    expect(events).toEqual([{ editor: null }, { editor: null }, { editor: null }]);

    provider.destroy();
    for (const disposable of Object.values(listenerDisposables)) {
      expect(disposable.dispose).toHaveBeenCalledTimes(1);
    }
  });

  it("aborts a pending cold-start watch when destroyed", async () => {
    let watchedSignal;
    let settlementPromise;
    const grammar = {};
    const editor = queryEditor({
      hasGrammarQuery: () => false,
      getGrammar: () => grammar,
      getGrammarQueryCaptureGroups() {},
      whenGrammarSettled({ signal }) {
        watchedSignal = signal;
        settlementPromise = new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(false), { once: true });
        });
        return settlementPromise;
      },
    });
    const provider = new TreeSitterProvider();
    const invalidate = jasmine.createSpy("invalidate");
    provider.onDidInvalidateDocumentSymbols(invalidate);

    expect(sourceScore(provider, editor)).toBe(0.999);
    provider.destroy();
    await settlementPromise;
    await Promise.resolve();

    expect(watchedSignal.aborted).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
    expect(provider.pendingGrammarSettlements.size).toBe(0);
  });

  it("does not invalidate when the grammar changes during a cold-start watch", async () => {
    let resolveSettlement;
    let hasTagsQuery = false;
    let grammar = {};
    const editor = queryEditor({
      hasGrammarQuery: () => hasTagsQuery,
      getGrammar: () => grammar,
      getGrammarQueryCaptureGroups() {},
      whenGrammarSettled: () =>
        new Promise((resolve) => {
          resolveSettlement = resolve;
        }),
    });
    const provider = new TreeSitterProvider();
    const invalidate = jasmine.createSpy("invalidate");
    provider.onDidInvalidateDocumentSymbols(invalidate);

    expect(sourceScore(provider, editor)).toBe(0.999);
    hasTagsQuery = true;
    grammar = {};
    resolveSettlement(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(invalidate).not.toHaveBeenCalled();
    expect(provider.pendingGrammarSettlements.size).toBe(0);
    provider.destroy();
  });

  it("passes the abort signal to capture collection", async () => {
    const controller = new AbortController();
    const whenGrammarSettled = jasmine.createSpy("whenGrammarSettled").and.resolveTo(true);
    let finishCaptures;
    const getGrammarQueryCaptureGroups = jasmine
      .createSpy("getGrammarQueryCaptureGroups")
      .and.callFake(
        (_queryType, { signal }) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve([]), { once: true });
            finishCaptures = resolve;
          }),
      );
    const editor = queryEditor({
      hasGrammarQuery: () => true,
      getGrammarQueryCaptureGroups,
      whenGrammarSettled,
    });
    const provider = new TreeSitterProvider();

    const symbolsPromise = provider.getDocumentSymbols(editor, {
      sourceId: "symbol-tree-sitter",
      signal: controller.signal,
    });
    expect(finishCaptures).toBeDefined();
    controller.abort();

    await expectAsync(symbolsPromise).toBeResolvedTo(null);
    expect(whenGrammarSettled).not.toHaveBeenCalled();
    const [queryType, options] = getGrammarQueryCaptureGroups.calls.mostRecent().args;
    expect(queryType).toBe("tagsQuery");
    expect(options.signal.aborted).toBe(true);
    provider.destroy();
  });

  it("lets a local capture request finish beyond a remote deadline when timeoutMs is zero", async () => {
    const { Range } = require("lumine");
    const requests = [];
    const editor = queryEditor({
      getGrammarQueryCaptureGroups(_queryType, { signal }) {
        return new Promise((resolve) => requests.push({ signal, resolve }));
      },
    });
    let finished = false;
    const request = provider.getDocumentSymbols(editor, {
      sourceId: "symbol-tree-sitter",
      timeoutMs: 0,
    });
    request.then(() => (finished = true));
    const timed = provider.getDocumentSymbols(editor, {
      sourceId: "symbol-tree-sitter",
      timeoutMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(finished).toBe(false);
    expect(requests[0].signal.aborted).toBe(false);
    expect(requests[1].signal.aborted).toBe(true);
    requests[1].resolve([]);
    await expectAsync(timed).toBeResolvedTo(null);
    requests[0].resolve([
      {
        captures: [
          { name: "name", node: { id: 1, text: "slowLocal", range: new Range([0, 0], [0, 9]) } },
        ],
      },
    ]);
    expect((await request).map(({ name }) => name)).toEqual(["slowLocal"]);
    expect(provider.pendingSymbolRequests.size).toBe(0);
  });

  it("cancels a local capture request on edit even with its deadline disabled", async () => {
    let changed;
    let finishCaptures;
    let requestedSignal;
    const editor = queryEditor({
      onDidChange(callback) {
        changed = callback;
        return { dispose() {} };
      },
      getGrammarQueryCaptureGroups(_queryType, { signal }) {
        requestedSignal = signal;
        return new Promise((resolve) => (finishCaptures = resolve));
      },
    });
    const invalidated = jasmine.createSpy("invalidated");
    provider.onDidInvalidateDocumentSymbols(invalidated);
    const request = provider.getDocumentSymbols(editor, {
      sourceId: "symbol-tree-sitter",
      timeoutMs: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(requestedSignal.aborted).toBe(false);
    changed();
    expect(requestedSignal.aborted).toBe(true);
    finishCaptures([
      {
        captures: [
          {
            get node() {
              throw new Error("stale local capture");
            },
          },
        ],
      },
    ]);
    await expectAsync(request).toBeResolvedTo(null);
    expect(invalidated).toHaveBeenCalledWith({ editor });
    expect(provider.pendingSymbolRequests.size).toBe(0);
  });

  it("does not publish capture groups invalidated by a grammar change", async () => {
    let grammarGeneration = 0;
    let finishCaptureRequest;
    let grammarChanged;
    const editor = queryEditor({
      onDidChangeGrammar(callback) {
        grammarChanged = callback;
        return { dispose() {} };
      },
      hasGrammarQuery: () => true,
      whenGrammarSettled: () => Promise.resolve(true),
      getGrammarQueryCaptureGroups() {
        const requestedGeneration = grammarGeneration;
        return new Promise((resolve) => {
          finishCaptureRequest = () => {
            resolve(requestedGeneration === grammarGeneration ? [{ captures: [{}] }] : []);
          };
        });
      },
    });
    const provider = new TreeSitterProvider();
    spyOn(provider.captureOrganizer, "process").and.returnValue([
      { name: "stale", position: { compare: () => 0 } },
    ]);
    const controller = new AbortController();

    const symbolsPromise = provider.getDocumentSymbols(editor, {
      sourceId: "symbol-tree-sitter",
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    grammarGeneration++;
    grammarChanged();
    finishCaptureRequest();

    await expectAsync(symbolsPromise).toBeResolvedTo(null);
    expect(provider.captureOrganizer.process).not.toHaveBeenCalled();
    provider.destroy();
  });

  it("collects captures from root and injected grammar groups", async () => {
    const rootSymbol = { name: "root", position: { compare: () => -1 } };
    const injectedSymbol = { name: "injected", position: { compare: () => 1 } };
    const rootCaptures = [{ symbol: rootSymbol }];
    const injectedCaptures = [{ symbol: injectedSymbol }];
    const editor = queryEditor({
      getGrammarQueryCaptureGroups: () =>
        Promise.resolve([{ captures: injectedCaptures }, { captures: rootCaptures }]),
    });
    const provider = new TreeSitterProvider();
    spyOn(provider.captureOrganizer, "process").and.callFake((captures) =>
      captures.map(({ symbol }) => symbol),
    );

    const symbols = await provider.getDocumentSymbols(editor, {
      sourceId: "symbol-tree-sitter",
      signal: new AbortController().signal,
    });

    expect(provider.captureOrganizer.process.calls.allArgs()).toEqual([
      [injectedCaptures],
      [rootCaptures],
    ]);
    expect(symbols).toEqual([rootSymbol, injectedSymbol]);
    provider.destroy();
  });

  it("collects a file with more symbols than the function argument limit", async () => {
    const { Point } = require("lumine");
    const expected = Array.from({ length: 200000 }, (_, row) => ({
      name: `command-${row}`,
      position: new Point(row, 0),
    }));
    const editor = queryEditor({
      getGrammarQueryCaptureGroups: () => Promise.resolve([{ captures: [] }]),
    });
    const provider = new TreeSitterProvider();
    spyOn(provider.captureOrganizer, "process").and.returnValue(expected);

    const symbols = await provider.getDocumentSymbols(editor, { sourceId: "symbol-tree-sitter" });

    expect(symbols.length).toBe(expected.length);
    expect(symbols[0]).toBe(expected[0]);
    expect(symbols.at(-1)).toBe(expected.at(-1));
    provider.destroy();
  });

  for (const event of ["onDidChange", "onDidChangeGrammar", "onDidDestroy"]) {
    it(`discards a request invalidated by ${event} before reading captured nodes`, async () => {
      let cancel;
      let finishCaptures;
      let requestedSignal;
      const disposed = jasmine.createSpy("dispose");
      const editor = queryEditor({
        [event](callback) {
          cancel = callback;
          return { dispose: disposed };
        },
        getGrammarQueryCaptureGroups(_queryType, { signal }) {
          requestedSignal = signal;
          return new Promise((resolve) => (finishCaptures = resolve));
        },
      });
      const request = provider.getDocumentSymbols(editor, { sourceId: "symbol-tree-sitter" });
      cancel();
      finishCaptures([
        {
          captures: [
            {
              get node() {
                throw new Error("stale node");
              },
            },
          ],
        },
      ]);

      await expectAsync(request).toBeResolvedTo(null);
      expect(requestedSignal.aborted).toBe(true);
      expect(disposed).toHaveBeenCalledTimes(1);
    });
  }

  it("keeps overlapping large editor requests in separate organizers", async () => {
    const { Point, Range } = require("lumine");
    const editorFor = (prefix) =>
      queryEditor({
        getGrammarQueryCaptureGroups: () =>
          Promise.resolve([
            {
              captures: Array.from({ length: 4096 }, (_, row) => ({
                name: "name",
                node: {
                  id: row,
                  text: `${prefix}${row}`,
                  range: new Range(new Point(row, 0), new Point(row, 10)),
                },
              })),
            },
          ]),
      });

    const [first, second] = await Promise.all([
      provider.getDocumentSymbols(editorFor("first"), { sourceId: "symbol-tree-sitter" }),
      provider.getDocumentSymbols(editorFor("second"), { sourceId: "symbol-tree-sitter" }),
    ]);

    expect(first.length).toBe(4096);
    expect(second.length).toBe(4096);
    expect(first[0].name).toBe("first0");
    expect(first.at(-1).name).toBe("first4095");
    expect(second[0].name).toBe("second0");
    expect(second.at(-1).name).toBe("second4095");
    expect(provider.pendingSymbolRequests.size).toBe(0);
  });

  it("stops a large organization after an edit at the next yield", async () => {
    const { Range } = require("lumine");
    let changed;
    let signal;
    const visited = new Set();
    const outerController = new AbortController();
    const invalidations = [];
    provider.onDidInvalidateDocumentSymbols((event) => {
      invalidations.push(event);
      // The symbol hub withdraws the outer request before accepting a result
      // from the stale generation. A null answer is valid only after that.
      outerController.abort();
    });
    const editor = queryEditor({
      onDidChange(callback) {
        changed = callback;
        return { dispose() {} };
      },
      getGrammarQueryCaptureGroups(_queryType, options) {
        signal = options.signal;
        return Promise.resolve([
          {
            captures: Array.from({ length: 4096 }, (_, index) => ({
              name: "name",
              node: {
                id: index,
                text: `command${index}`,
                get range() {
                  expect(signal.aborted).toBe(false);
                  visited.add(index);
                  return new Range([index, 0], [index, 1]);
                },
              },
            })),
          },
        ]);
      },
    });

    const request = provider.getDocumentSymbols(editor, {
      sourceId: "symbol-tree-sitter",
      signal: outerController.signal,
    });
    setImmediate(() => changed());

    await expectAsync(request).toBeResolvedTo(null);
    expect(visited.size).toBeGreaterThan(0);
    expect(visited.size).toBeLessThan(4096);
    expect(outerController.signal.aborted).toBe(true);
    expect(invalidations).toEqual([{ editor }]);
    expect(provider.pendingSymbolRequests.size).toBe(0);
  });

  beforeEach(async () => {
    jasmine.useRealClock();

    await lumine.packages.activatePackage("language-javascript");

    lumine.config.set("symbol-tree-sitter.includeReferences", false);

    provider = new TreeSitterProvider();

    lumine.project.setPaths([
      temp.mkdirSync("other-dir-"),
      temp.mkdirSync("symbol-tree-sitter-spec-"),
    ]);

    directory = lumine.project.getDirectories()[1];
    fs.copySync(path.join(__dirname, "fixtures", "js"), lumine.project.getPaths()[1]);

    fs.copySync(path.join(__dirname, "fixtures", "ruby"), lumine.project.getPaths()[1]);
  });

  describe("when a tree-sitter grammar is used for a file", () => {
    beforeEach(async () => {
      await lumine.workspace.open(directory.resolve("sample.js"));
      editor = getEditor();
      await editor.whenGrammarSettled();
    });

    it("is willing to provide symbols for the current file", () => {
      expect(sourceScore(provider, editor)).toBe(0.999);
    });

    it("exposes only document symbol operations", () => {
      expect(provider.searchWorkspaceSymbols).toBeUndefined();
      expect(provider.getDefinitions).toBeUndefined();
    });

    it("provides all JavaScript functions", async () => {
      let symbols = await readDocumentSymbols(editor);

      expect(symbols[0].name).toBe("quicksort");
      expect(symbols[0].position.row).toEqual(0);

      expect(symbols[1].name).toBe("sort");
      expect(symbols[1].position.row).toEqual(1);
    });
  });

  describe("when the parserless sentinel grammar is used for a file", () => {
    beforeEach(async () => {
      await lumine.workspace.open(directory.resolve("sample.js"));
      editor = getEditor();
      editor.setGrammar(lumine.grammars.nullGrammar);
    });

    it("keeps the source ready and returns an empty list for the current file", async () => {
      expect(editor.getGrammar()).toBe(lumine.grammars.nullGrammar);

      expect(sourceScore(provider, editor)).toBe(0.999);
      expect(await readDocumentSymbols(editor)).toEqual([]);
    });
  });

  it("keeps a real plain-text buffer selectable and treats no queries as a valid empty answer", async () => {
    const editor = await lumine.workspace.open();
    editor.setGrammar(lumine.grammars.nullGrammar);
    editor.setText("There are no declarations or parser queries here.");
    expect(editor.hasGrammarQuery("tagsQuery")).toBe(false);
    const source = provider.getDocumentSymbolSources(editor)[0];
    expect(source).toEqual({
      id: "symbol-tree-sitter",
      name: "Tree-sitter",
      shortLabel: "TS",
      score: 0.999,
      state: "ready",
      execution: "local",
    });
    expect(await readDocumentSymbols(editor)).toEqual([]);
  });

  it("declines surfaces that do not implement the complete editor query facade", async () => {
    const incomplete = { getGrammarQueryCaptureGroups: jasmine.createSpy("captures") };
    expect(provider.getDocumentSymbolSources(incomplete)).toEqual([]);
    expect(
      await provider.getDocumentSymbols(incomplete, { sourceId: "symbol-tree-sitter" }),
    ).toBeNull();
    expect(incomplete.getGrammarQueryCaptureGroups).not.toHaveBeenCalled();
  });

  describe("when the buffer is new and unsaved", () => {
    let grammar;
    beforeEach(async () => {
      await lumine.workspace.open();
      editor = getEditor();
      grammar = lumine.grammars.grammarForId("source.js");
      editor.setGrammar(grammar);
      await editor.whenGrammarSettled();
    });

    it("is willing to provide symbols", () => {
      expect(sourceScore(provider, editor)).toBe(0.999);
    });

    describe("and has content", () => {
      beforeEach(async () => {
        let text = fs.readFileSync(path.join(__dirname, "fixtures", "js", "sample.js")).toString();
        editor.setText(text);
        await editor.whenGrammarSettled();
      });

      it("provides symbols just as if the file were saved on disk", async () => {
        let symbols = await readDocumentSymbols(editor);

        expect(symbols[0].name).toBe("quicksort");
        expect(symbols[0].position.row).toEqual(0);

        expect(symbols[1].name).toBe("sort");
        expect(symbols[1].position.row).toEqual(1);
      });
    });
  });

  describe("when the file has multiple language layers", () => {
    beforeEach(async () => {
      await lumine.packages.activatePackage(path.resolve(__dirname, "..", "..", "language-ruby"));
      await lumine.workspace.open(directory.resolve("embed.rb"));
      editor = getEditor();
      await editor.whenGrammarSettled();
    });

    it("detects symbols across several layers", async () => {
      expect(editor.hasGrammarQuery("tagsQuery")).toBe(true);
      const groups = await editor.getGrammarQueryCaptureGroups("tagsQuery");
      expect(groups.map(({ grammar }) => grammar.scopeName)).toEqual(
        jasmine.arrayWithExactContents(["source.ruby", "source.js"]),
      );

      let symbols = await readDocumentSymbols(editor);

      expect(symbols[0].name).toBe("foo");
      expect(symbols[0].position.row).toEqual(1);

      expect(symbols[1].name).toBe("bar");
      expect(symbols[1].position.row).toEqual(4);
    });
  });

  describe("when the tags query contains @definition captures", () => {
    let grammar;
    beforeEach(async () => {
      await lumine.workspace.open(directory.resolve("sample.js"));
      editor = getEditor();
      await editor.whenGrammarSettled();
      grammar = editor.getGrammar();
      await grammar.setQueryForTest(
        "tagsQuery",
        scm`
        (
          (variable_declaration
            (variable_declarator
              name: (identifier) @name
              value: [(arrow_function) (function_expression)]))
        ) @definition.function
        `,
      );
    });

    it("can infer tag names from those captures", async () => {
      let symbols = await readDocumentSymbols(editor);

      expect(symbols[0].name).toBe("quicksort");
      expect(symbols[0].tag).toBe("function");

      expect(symbols[1].name).toBe("sort");
      expect(symbols[1].tag).toBe("function");
    });
  });

  describe("when the tags query contains @reference captures", () => {
    let grammar;
    beforeEach(async () => {
      await lumine.workspace.open(directory.resolve("sample.js"));
      editor = getEditor();
      await editor.whenGrammarSettled();
      grammar = editor.getGrammar();
      await grammar.setQueryForTest(
        "tagsQuery",
        scm`
        (
          (variable_declaration
            (variable_declarator
              name: (identifier) @name
              value: [(arrow_function) (function_expression)]))
        ) @definition.function

        (
          (call_expression
            function: (identifier) @name) @reference.call
            (#not-match? @name "^(require)$"))
        `,
      );
    });

    it("skips references when they are disabled in settings", async () => {
      let symbols = await readDocumentSymbols(editor);
      expect(symbols.length).toBe(2);
    });

    it("includes references when they are enabled in settings", async () => {
      lumine.config.set("symbol-tree-sitter.includeReferences", true);
      let symbols = await readDocumentSymbols(editor);
      expect(symbols.length).toBe(5);
      expect(symbols.map((s) => s.tag)).toEqual(["function", "function", "call", "call", "call"]);
    });
  });

  describe("when the tags query uses the predicate", () => {
    let grammar;
    beforeEach(async () => {
      await lumine.workspace.open(directory.resolve("sample.js"));
      editor = getEditor();
      await editor.whenGrammarSettled();
      grammar = editor.getGrammar();
    });

    describe("symbol.context", () => {
      beforeEach(async () => {
        await grammar.setQueryForTest(
          "tagsQuery",
          scm`
          (
            (variable_declaration
              (variable_declarator
                name: (identifier) @name
                value: [(arrow_function) (function_expression)]))
                (#set! symbol.context "something")
          )
        `,
        );
      });

      it("assigns a `context` property on each symbol", async () => {
        let symbols = await readDocumentSymbols(editor);

        expect(symbols[0].context).toBe("something");
        expect(symbols[0].position.row).toEqual(0);

        expect(symbols[1].context).toBe("something");
        expect(symbols[1].position.row).toEqual(1);
      });
    });

    describe("symbol.contextNode", () => {
      beforeEach(async () => {
        await grammar.setQueryForTest(
          "tagsQuery",
          scm`
          (
            (property_identifier) @name
            (#eq? @name "push")
            (#set! symbol.contextNode "parent.firstNamedChild")
          )
        `,
        );
      });

      it("assigns a `context` property on each symbol containing the text of the referenced node", async () => {
        let symbols = await readDocumentSymbols(editor);

        expect(symbols[0].name).toBe("push");
        expect(symbols[0].context).toBe("left");
        expect(symbols[0].position.row).toEqual(6);

        expect(symbols[1].name).toBe("push");
        expect(symbols[1].context).toBe("right");
        expect(symbols[1].position.row).toEqual(6);
      });
    });

    describe("symbol.icon", () => {
      it("defines an `icon` property on each symbol", async () => {
        await grammar.setQueryForTest(
          "tagsQuery",
          scm`
          (
            (variable_declaration
              (variable_declarator
                name: (identifier) @name
                value: [(arrow_function) (function_expression)]))
                (#set! symbol.icon "book")
          )

        `,
        );

        let symbols = await readDocumentSymbols(editor);
        console.log("symbols:", symbols);

        expect(symbols[0].icon).toBe("book");
        expect(symbols[0].position.row).toEqual(0);

        expect(symbols[1].icon).toBe("book");
        expect(symbols[1].position.row).toEqual(1);
      });

      it("supersedes an `icon` property assigned by a tag", async () => {
        await grammar.setQueryForTest(
          "tagsQuery",
          scm`
          (
            (variable_declaration
              (variable_declarator
                name: (identifier) @name
                value: [(arrow_function) (function_expression)]))
                (#set! symbol.tag "class")
                (#set! symbol.icon "book")
          )
        `,
        );

        let symbols = await readDocumentSymbols(editor);

        expect(symbols[0].icon).toBe("book");
        expect(symbols[0].position.row).toEqual(0);

        expect(symbols[1].icon).toBe("book");
        expect(symbols[1].position.row).toEqual(1);
      });

      it("supersedes an `icon` property inferred by its container", async () => {
        await grammar.setQueryForTest(
          "tagsQuery",
          scm`
          (
            (variable_declaration
              (variable_declarator
                name: (identifier) @name
                value: [(arrow_function) (function_expression)]))
                (#set! symbol.tag "class")
                (#set! symbol.icon "book")
          ) @definition.namespace
        `,
        );

        let symbols = await readDocumentSymbols(editor);

        expect(symbols[0].icon).toBe("book");
        expect(symbols[0].position.row).toEqual(0);

        expect(symbols[1].icon).toBe("book");
        expect(symbols[1].position.row).toEqual(1);
      });
    });

    describe("symbol.tag", () => {
      it("defines a `tag` property on each symbol", async () => {
        await grammar.setQueryForTest(
          "tagsQuery",
          scm`
          (
            (variable_declaration
              (variable_declarator
                name: (identifier) @name
                value: [(arrow_function) (function_expression)]))
                (#set! symbol.tag "class")
          )
        `,
        );

        let symbols = await readDocumentSymbols(editor);

        expect(symbols[0].tag).toBe("class");
        expect(symbols[0].icon).toBeNull();
        expect(symbols[0].position.row).toEqual(0);

        expect(symbols[1].tag).toBe("class");
        expect(symbols[1].icon).toBeNull();
        expect(symbols[1].position.row).toEqual(1);
      });

      it("supersedes the `tag` property inferred by its container", async () => {
        await grammar.setQueryForTest(
          "tagsQuery",
          scm`
          (
            (variable_declaration
              (variable_declarator
                name: (identifier) @name
                value: [(arrow_function) (function_expression)]))
                (#set! symbol.tag "class")
          ) @definition.namespace
        `,
        );

        let symbols = await readDocumentSymbols(editor);

        expect(symbols[0].tag).toBe("class");
        expect(symbols[0].icon).toBeNull();
        expect(symbols[0].position.row).toEqual(0);

        expect(symbols[1].tag).toBe("class");
        expect(symbols[1].icon).toBeNull();
        expect(symbols[1].position.row).toEqual(1);
      });
    });

    describe("symbol.strip", () => {
      beforeEach(async () => {
        await grammar.setQueryForTest(
          "tagsQuery",
          scm`
          (
            (variable_declaration
              (variable_declarator
                name: (identifier) @name
                value: [(arrow_function) (function_expression)]))
                (#set! symbol.strip "ort$")
          )
        `,
        );
      });
      it("strips the given text from each symbol", async () => {
        let symbols = await readDocumentSymbols(editor);

        expect(symbols[0].name).toBe("quicks");
        expect(symbols[0].position.row).toEqual(0);

        expect(symbols[1].name).toBe("s");
        expect(symbols[1].position.row).toEqual(1);
      });
    });

    describe("symbol.prepend", () => {
      beforeEach(async () => {
        await grammar.setQueryForTest(
          "tagsQuery",
          scm`
          (
            (variable_declaration
              (variable_declarator
                name: (identifier) @name
                value: [(arrow_function) (function_expression)]))
                (#set! symbol.prepend "Foo: ")
          )
        `,
        );
      });
      it("prepends the given text to each symbol", async () => {
        let symbols = await readDocumentSymbols(editor);

        expect(symbols[0].name).toBe("Foo: quicksort");
        expect(symbols[0].position.row).toEqual(0);

        expect(symbols[1].name).toBe("Foo: sort");
        expect(symbols[1].position.row).toEqual(1);
      });
    });

    describe("symbol.append", () => {
      beforeEach(async () => {
        await grammar.setQueryForTest(
          "tagsQuery",
          scm`
          (
            (variable_declaration
              (variable_declarator
                name: (identifier) @name
                value: [(arrow_function) (function_expression)]))
                (#set! symbol.append " (foo)")
          )

        `,
        );
      });
      it("appends the given text to each symbol", async () => {
        let symbols = await readDocumentSymbols(editor);

        expect(symbols[0].name).toBe("quicksort (foo)");
        expect(symbols[0].position.row).toEqual(0);

        expect(symbols[1].name).toBe("sort (foo)");
        expect(symbols[1].position.row).toEqual(1);
      });
    });

    describe("symbol.prependTextForNode", () => {
      beforeEach(async () => {
        await grammar.setQueryForTest(
          "tagsQuery",
          scm`
          (
            (variable_declaration
              (variable_declarator
                name: (identifier) @name
                value: [(arrow_function) (function_expression)]))
                (#is? test.descendantOfType function_expression)
                (#set! symbol.prependTextForNode "parent.parent.parent.parent.parent.firstNamedChild")
                (#set! symbol.joiner ".")
                (#set! capture.final true)
          )
          (
            (variable_declaration
              (variable_declarator
                name: (identifier) @name
                value: [(arrow_function) (function_expression)]))
          )
        `,
        );
      });
      it(`prepends the associated node's text to each symbol`, async () => {
        let symbols = await readDocumentSymbols(editor);

        expect(symbols[0].name).toBe("quicksort");
        expect(symbols[0].position.row).toEqual(0);

        expect(symbols[1].name).toBe("quicksort.sort");
        expect(symbols[1].position.row).toEqual(1);
      });
    });

    describe("symbol.prependSymbolForNode", () => {
      beforeEach(async () => {
        await grammar.setQueryForTest(
          "tagsQuery",
          scm`
          ; Outer function has prepended text...
          (
            (variable_declaration
              (variable_declarator
                name: (identifier) @name
                value: [(arrow_function) (function_expression)]))
                (#is-not? test.descendantOfType function_expression)
                (#set! symbol.prepend "ROOT: ")
                (#set! capture.final true)
          )
          ; …which the inner function picks up on.
          (
            (variable_declaration
              (variable_declarator
                name: (identifier) @name
                value: [(arrow_function) (function_expression)]))
                (#is? test.descendantOfType function_expression)
                (#set! symbol.prependSymbolForNode "parent.parent.parent.parent.parent.firstNamedChild")
                (#set! symbol.joiner ".")
                (#set! capture.final true)
          )
        `,
        );
      });
      it(`prepends the associated node's symbol name to each symbol`, async () => {
        let symbols = await readDocumentSymbols(editor);

        expect(symbols[0].name).toBe("ROOT: quicksort");
        expect(symbols[0].position.row).toEqual(0);

        expect(symbols[1].name).toBe("ROOT: quicksort.sort");
        expect(symbols[1].position.row).toEqual(1);
      });
    });
  });
});
