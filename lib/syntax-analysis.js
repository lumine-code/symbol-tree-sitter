const CaptureOrganizer = require("./capture-organizer");
const WorkBudget = require("./work-budget");
const sortSymbols = require("./sort-symbols");
const { encode } = require("./symbol-packets");

exports.symbolPath = async function (context, { position }) {
  const grouped = await context.getGrammarQueryMatchesAtBufferPosition?.("tagsQuery", position);
  if (!grouped) return null;
  const point = context.Point.fromObject(position);
  const organizer = new CaptureOrganizer();
  const path = [];
  try {
    for (const { grammar, matches } of grouped) {
      if (grammar.queryPaths?.tagsQuerySupportsLocalPath !== true) return null;
      for (const { captures } of matches) {
        const names = captures.filter((capture) => organizer.isName(capture));
        const containers = captures.filter(
          (capture) => organizer.isDefinition(capture) || organizer.isReference(capture),
        );
        // The local contract pairs a declaration and one name in a match.
        // A separate capture can contribute to a full organizer scan, but we
        // cannot reconstruct it when the required match is not at the cursor.
        if (!containers.length && !names.length) continue;
        if (containers.length > 1 || names.length !== 1) return null;
        const [name] = names;
        const [container] = containers;
        const range = (container ?? name).node.range;
        if (!range.containsPoint(point)) continue;
        if (range.isEmpty()) return null;
        if (
          name.setProperties?.["symbol.prependSymbolForNode"] ||
          (container && !range.containsRange(name.node.range))
        )
          return null;
        const [symbol] = organizer.process(container ? [container, name] : [name]);
        if (symbol) path.push(symbol);
      }
    }
  } finally {
    organizer.clear();
  }
  // A point between symbols uses the full tree's nearest-symbol behavior.
  // Equal or crossing ranges also require its global tie-breaking order.
  if (!path.length) return point.isEqual([0, 0]) ? [] : null;
  path.sort((a, b) => a.range.start.compare(b.range.start) || b.range.end.compare(a.range.end));
  let outer = path[0].range;
  for (const { range } of path.slice(1)) {
    if (outer.isEqual(range) || !outer.containsRange(range)) return null;
    outer = range;
  }
  return path;
};

exports.symbols = async function (context, _params, { signal, emit }) {
  const organizer = new CaptureOrganizer();
  const budget = new WorkBudget({ signal });
  const results = [];
  try {
    let activeLayer = null;
    for await (const { captures, layerId, last } of context.scanGrammarQueryCaptures("tagsQuery")) {
      signal.throwIfAborted();
      if (activeLayer === null) activeLayer = layerId;
      else if (activeLayer !== layerId)
        throw new Error("Syntax capture layer ended without completion");
      const symbols = await organizer.processBatch(captures, { budget, last });
      signal.throwIfAborted();
      if (!last) continue;
      activeLayer = null;
      for (const symbol of symbols) {
        results.push(symbol);
        if (budget.shouldYield()) {
          await budget.yield();
          signal.throwIfAborted();
        }
      }
      organizer.clear();
    }
    if (activeLayer !== null) throw new Error("Syntax capture scan ended without completion");
    const sorted = await sortSymbols(results, budget);
    signal.throwIfAborted();
    const dictionary = new Map();
    for (let start = 0; start < sorted.length; start += 256) {
      const end = Math.min(start + 256, sorted.length);
      const packet = encode(sorted, start, end, dictionary);
      await emit(packet, [packet.coordinates.buffer, packet.labels.buffer]);
      signal.throwIfAborted();
    }
    return { count: results.length };
  } finally {
    organizer.clear();
  }
};
