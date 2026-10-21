const { Point, Range } = require("lumine");
const { encode, decode } = require("../lib/symbol-packets");

describe("Syntax symbol packets", () => {
  it("round trips transferred batches with shared labels and optional fields", () => {
    const symbols = Array.from({ length: 1025 }, (_, row) => ({
      name: `function${row % 7}`,
      position: new Point(row, 1),
      range: new Range([row, 0], [row, 9]),
      ...(row % 3 === 0 ? { icon: null } : row % 3 === 1 ? { icon: undefined } : {}),
    }));
    const dictionary = new Map(),
      receivedDictionary = [],
      results = [];
    for (let start = 0; start < symbols.length; start += 256) {
      const packet = encode(symbols, start, Math.min(start + 256, symbols.length), dictionary);
      const transferred = structuredClone(packet, {
        transfer: [packet.coordinates.buffer, packet.labels.buffer],
      });
      expect(packet.coordinates.byteLength).toBe(0);
      results.push(...decode(transferred, receivedDictionary, { Point, Range }));
    }
    expect(results).toEqual(symbols);
    expect(receivedDictionary.length).toBe(7);
    expect(Object.hasOwn(results[0], "icon")).toBeTrue();
    expect(Object.hasOwn(results[1], "icon")).toBeTrue();
    expect(Object.hasOwn(results[2], "icon")).toBeFalse();
  });

  it("rejects invalid lengths, coordinates and dictionary references", () => {
    const packet = () =>
      encode(
        [{ name: "x", position: new Point(0, 0), range: new Range([0, 0], [0, 1]) }],
        0,
        1,
        new Map(),
      );
    const badLength = packet();
    badLength.labels = new Int32Array(0);
    expect(() => decode(badLength, [], { Point, Range })).toThrowError(/Invalid symbol packet/);
    const badPoint = packet();
    badPoint.coordinates[0] = NaN;
    expect(() => decode(badPoint, [], { Point, Range })).toThrowError(/coordinate/);
    const badLabel = packet();
    badLabel.labels[0] = 99;
    expect(() => decode(badLabel, [], { Point, Range })).toThrowError(/dictionary index/);
  });
});
