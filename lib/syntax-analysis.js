const CaptureOrganizer = require("./capture-organizer");
const WorkBudget = require("./work-budget");
const sortSymbols = require("./sort-symbols");
const { encode } = require("./symbol-packets");

exports.symbols = async function (context, _params, { signal, emit }) {
  const groups = await context.getGrammarQueryCaptureGroups("tagsQuery");
  signal.throwIfAborted();
  const organizer = new CaptureOrganizer();
  const budget = new WorkBudget({ signal });
  const results = [];
  try {
    const asynchronous = groups.reduce((sum, group) => sum + group.captures.length, 0) >= 4096;
    for (const { captures } of groups) {
      signal.throwIfAborted();
      const symbols = asynchronous
        ? await organizer.processAsync(captures, { budget })
        : organizer.process(captures);
      signal.throwIfAborted();
      for (const symbol of symbols) {
        results.push(symbol);
        if (budget.shouldYield()) {
          await budget.yield();
          signal.throwIfAborted();
        }
      }
    }
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
