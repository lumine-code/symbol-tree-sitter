const CaptureOrganizer = require("./capture-organizer");
const WorkBudget = require("./work-budget");
const sortSymbols = require("./sort-symbols");
const { encode } = require("./symbol-packets");

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
