const { Point, Range } = require("lumine");
const CaptureOrganizer = require("../lib/capture-organizer");
const WorkBudget = require("../lib/work-budget");
const sortSymbols = require("../lib/sort-symbols");

const node = (id, row, text, endRow = row) => ({
  id,
  text,
  range: new Range(new Point(row, 0), new Point(endRow, text.length)),
});

describe("CaptureOrganizer cooperative processing", () => {
  beforeEach(() => {
    jasmine.useRealClock();
    lumine.config.set("symbol-tree-sitter.includeReferences", false);
  });

  it("preserves definitions, references, standalone names, and recursive prefixes across yields", async () => {
    lumine.config.set("symbol-tree-sitter.includeReferences", true);
    const outer = node(1, 0, "outer", 100);
    const inner = node(2, 1, "inner", 90);
    inner.parent = outer;
    const captures = [
      { name: "definition.module", node: outer },
      { name: "name", node: outer },
      { name: "definition.function", node: inner },
      ...Array.from({ length: 40 }, (_, index) => ({
        name: `auxiliary${index}`,
        node: node(index + 10, 1, "auxiliary"),
      })),
      {
        name: "name",
        node: inner,
        setProperties: { "symbol.prependSymbolForNode": "parent", "symbol.joiner": "." },
      },
      { name: "reference.call", node: node(3, 101, "call") },
      { name: "name", node: node(4, 101, "call") },
      { name: "name", node: node(5, 102, "standalone") },
    ];
    let yields = 0;
    const synchronous = new CaptureOrganizer().process(captures);
    const asynchronous = await new CaptureOrganizer().processAsync(captures, {
      sliceMillis: 0,
      yieldTask: async () => yields++,
    });

    expect(yields).toBeGreaterThan(0);
    expect(asynchronous).toEqual(synchronous);
    expect(asynchronous.map(({ name }) => name)).toContain("outer.inner");
    expect(asynchronous.map(({ name }) => name)).toContain("standalone");
  });

  it("stops before reading more syntax nodes after cancellation during a yield", async () => {
    const controller = new AbortController();
    let reads = 0;
    const captures = Array.from({ length: 100 }, (_, index) => ({
      name: "name",
      node: {
        id: index,
        get range() {
          expect(controller.signal.aborted).toBe(false);
          reads++;
          return new Range([index, 0], [index, 1]);
        },
        get text() {
          expect(controller.signal.aborted).toBe(false);
          return "x";
        },
      },
    }));
    const symbols = await new CaptureOrganizer().processAsync(captures, {
      signal: controller.signal,
      sliceMillis: 0,
      yieldTask: async () => controller.abort(),
    });

    expect(symbols).toBeNull();
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(captures.length);
  });

  it("yields while converting completed containers to plain symbols", async () => {
    const captures = [];
    for (let row = 0; row < 100; row++) {
      const value = node(row, row, `command${row}`);
      captures.push({ name: "definition.method", node: value }, { name: "name", node: value });
    }
    const organizer = new CaptureOrganizer();
    let conversionYields = 0;
    const symbols = await organizer.processAsync(captures, {
      sliceMillis: 0,
      yieldTask: async () => {
        if (organizer.activeContainers.length === 0 && organizer.definitions.length === 100) {
          conversionYields++;
        }
      },
    });

    expect(symbols.length).toBe(100);
    expect(conversionYields).toBeGreaterThan(0);
  });

  it("sorts large symbol lists in slices with stable equal-position order", async () => {
    const symbols = Array.from({ length: 4096 }, (_, index) => ({
      name: `symbol${index}`,
      position: new Point(Math.floor((4095 - index) / 2), 0),
    }));
    const expected = [...symbols].sort((left, right) => left.position.compare(right.position));
    let yields = 0;
    const result = await sortSymbols(
      symbols,
      new WorkBudget({ sliceMillis: 0, yieldTask: async () => yields++ }),
    );

    expect(result).toEqual(expected);
    expect(yields).toBeGreaterThan(1);
  });

  it("can cancel during the final sort without publishing partial results", async () => {
    const controller = new AbortController();
    const symbols = Array.from({ length: 100 }, (_, index) => ({
      position: new Point(100 - index, 0),
    }));
    let yields = 0;
    const result = await sortSymbols(
      symbols,
      new WorkBudget({
        signal: controller.signal,
        sliceMillis: 0,
        yieldTask: async () => {
          if (++yields === 4) controller.abort();
        },
      }),
    );

    expect(result).toBeNull();
    expect(yields).toBe(4);
  });
});
