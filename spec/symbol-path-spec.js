const { Point, Range } = require("lumine");
const { symbolPath } = require("../lib/syntax-analysis");

function match(tag, text, range, nameRange, setProperties) {
  return {
    captures: [
      { name: `definition.${tag}`, node: { range: Range.fromObject(range) } },
      {
        name: "name",
        node: { text, range: Range.fromObject(nameRange) },
        setProperties,
      },
    ],
  };
}

describe("symbol paths from local tags matches", () => {
  const grammar = { queryPaths: { tagsQuerySupportsLocalPath: true } };
  const outer = match(
    "class",
    "Outer",
    [
      [1, 0],
      [6, 1],
    ],
    [
      [1, 6],
      [1, 11],
    ],
  );
  const inner = match(
    "method",
    "inside",
    [
      [2, 2],
      [5, 3],
    ],
    [
      [2, 2],
      [2, 8],
    ],
  );
  const contextFor = (matches, activeGrammar = grammar) => ({
    Point,
    async getGrammarQueryMatchesAtBufferPosition(type, point) {
      expect(type).toBe("tagsQuery");
      expect(Point.fromObject(point)).toBeDefined();
      return [{ grammar: activeGrammar, matches }];
    },
  });

  it("keeps enclosing declarations and names before the requested position", async () => {
    const result = await symbolPath(contextFor([inner, outer]), { position: [4, 4] });
    expect(result.map(({ name }) => name)).toEqual(["Outer", "inside"]);
    expect(result[0].position.isEqual([1, 0])).toBeTrue();
    expect(result[1].position.isEqual([2, 2])).toBeTrue();
  });

  it("declines missing names, nonlocal name references and ambiguous enclosing ranges", async () => {
    const nonlocal = {
      captures: [
        inner.captures[0],
        { ...inner.captures[1], setProperties: { "symbol.prependSymbolForNode": "parent" } },
      ],
    };
    for (const matches of [
      [outer, { captures: [inner.captures[0]] }],
      [outer, nonlocal],
      [outer, inner, inner],
    ])
      expect(await symbolPath(contextFor(matches), { position: [4, 4] })).toBeNull();
  });

  it("defers the nearest-symbol rule and grammars without the local contract", async () => {
    expect(await symbolPath(contextFor([]), { position: [0, 0] })).toEqual([]);
    expect(await symbolPath(contextFor([]), { position: [7, 0] })).toBeNull();
    expect(await symbolPath(contextFor([outer], {}), { position: [4, 4] })).toBeNull();
    expect(await symbolPath({ Point }, { position: [4, 4] })).toBeNull();
  });
});
