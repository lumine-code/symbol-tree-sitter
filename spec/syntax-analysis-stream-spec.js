const { Point, Range } = require("lumine");
const analysis = require("../lib/syntax-analysis");
const { decode } = require("../lib/symbol-packets");

function capture(name, text, id, row = 0) {
  return { name, node: { id, text, range: new Range([row, 0], [row, text.length]) } };
}

describe("Streaming symbol analysis", () => {
  beforeEach(() => {
    jasmine.useRealClock();
    lumine.config.set("symbol-tree-sitter.includeReferences", false);
  });

  it("keeps category and layer order for equal-position symbols across batches", async () => {
    const controller = new AbortController();
    const packets = [];
    const context = {
      async *scanGrammarQueryCaptures(type) {
        expect(type).toBe("tagsQuery");
        yield { layerId: 0, last: false, captures: [capture("name", "standalone", 1)] };
        yield { layerId: 0, last: false, captures: [capture("definition.function", "first", 2)] };
        yield { layerId: 0, last: true, captures: [capture("name", "first", 2)] };
        yield { layerId: 1, last: true, captures: [capture("name", "second-layer", 3)] };
      },
    };
    const result = await analysis.symbols(
      context,
      {},
      { signal: controller.signal, emit: async (packet) => packets.push(packet) },
    );
    const dictionary = [];
    const symbols = packets.flatMap((packet) => decode(packet, dictionary, { Point, Range }));
    expect(result).toEqual({ count: 3 });
    expect(symbols.map(({ name }) => name)).toEqual(["first", "standalone", "second-layer"]);
  });

  it("publishes no packets if a scan fails after yielding captures", async () => {
    const controller = new AbortController();
    const emit = jasmine.createSpy("emit");
    const context = {
      async *scanGrammarQueryCaptures() {
        yield { layerId: 0, last: false, captures: [capture("name", "partial", 1)] };
        const error = new Error("query budget exhausted");
        error.name = "QueryBudgetExceeded";
        throw error;
      },
    };
    await expectAsync(
      analysis.symbols(context, {}, { signal: controller.signal, emit }),
    ).toBeRejectedWithError("query budget exhausted");
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects a truncated layer stream and never publishes its partial symbols", async () => {
    const controller = new AbortController();
    const emit = jasmine.createSpy("emit");
    const context = {
      async *scanGrammarQueryCaptures() {
        yield { layerId: 0, last: false, captures: [capture("name", "partial", 1)] };
      },
    };
    await expectAsync(
      analysis.symbols(context, {}, { signal: controller.signal, emit }),
    ).toBeRejectedWithError("Syntax capture scan ended without completion");
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not inspect subsequent captures after cancellation", async () => {
    const controller = new AbortController();
    const emit = jasmine.createSpy("emit");
    const context = {
      async *scanGrammarQueryCaptures() {
        yield { layerId: 0, last: false, captures: [capture("name", "first", 1)] };
        controller.abort();
        yield {
          layerId: 0,
          last: true,
          captures: [
            {
              get node() {
                throw new Error("stale node read");
              },
            },
          ],
        };
      },
    };
    await expectAsync(
      analysis.symbols(context, {}, { signal: controller.signal, emit }),
    ).toBeRejected();
    expect(emit).not.toHaveBeenCalled();
  });
});
