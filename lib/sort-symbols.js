const compare = (left, right) => left.position.compare(right.position);

async function sortSymbols(symbols, budget) {
  let sorted = true;
  for (let index = 1; index < symbols.length; index++) {
    if (budget.signal?.aborted) return null;
    if (compare(symbols[index - 1], symbols[index]) > 0) sorted = false;
    if (budget.shouldYield() && !(await budget.yield())) return null;
  }
  if (sorted) return symbols;

  // Native sorting is efficient for small runs; keep each invocation bounded
  // before merging the runs in interruptible passes.
  const runSize = 512;
  for (let start = 0; start < symbols.length; start += runSize) {
    if (budget.signal?.aborted) return null;
    const run = symbols.slice(start, start + runSize).sort(compare);
    for (let index = 0; index < run.length; index++) {
      symbols[start + index] = run[index];
      if (budget.shouldYield() && !(await budget.yield())) return null;
    }
  }

  // Stable merges preserve the native sort's order for equal positions. Copy
  // references in bounded slices, including the last pass over a large list.
  let source = symbols;
  let target = new Array(symbols.length);
  for (let width = runSize; width < symbols.length; width *= 2) {
    for (let start = 0; start < symbols.length; start += width * 2) {
      const middle = Math.min(start + width, symbols.length);
      const end = Math.min(start + width * 2, symbols.length);
      let left = start;
      let right = middle;
      for (let index = start; index < end; index++) {
        if (budget.signal?.aborted) return null;
        if (left < middle && (right >= end || compare(source[left], source[right]) <= 0)) {
          target[index] = source[left++];
        } else {
          target[index] = source[right++];
        }
        if (budget.shouldYield() && !(await budget.yield())) return null;
      }
    }
    [source, target] = [target, source];
  }
  return source;
}

module.exports = sortSymbols;
