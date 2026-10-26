const { Point } = require("lumine");
const WorkBudget = require("./work-budget");

const descriptorParts = new Map();
const MAX_SYMBOL_TEXT_UNITS = 65536;

function checkTextLength(length) {
  if (length <= MAX_SYMBOL_TEXT_UNITS || !Number.isFinite(length)) return;
  const error = new Error("Symbol text exceeds the syntax analysis budget.");
  error.name = "QueryBudgetExceeded";
  error.code = "ERR_SYNTAX_QUERY_BUDGET";
  error.reason = "symbol-text-limit";
  throw error;
}

function nodeText(node) {
  // Real syntax nodes expose offsets, so reject before materializing a large
  // parent/container. Small synthetic test nodes may only expose their text.
  checkTextLength(node.endIndex - node.startIndex);
  const text = node.text;
  checkTextLength(text.length);
  return text;
}

function resolveNodeDescriptor(node, descriptor) {
  let parts = descriptorParts.get(descriptor);
  if (!parts) {
    parts = descriptor.split(".");
    descriptorParts.set(descriptor, parts);
  }
  let result = node;
  for (const part of parts) {
    if (result === null) return null;
    result = result[part];
    if (!result) return null;
  }
  return result;
}

const PatternCache = {
  getOrCompile(pattern) {
    this.patternCache ??= new Map();
    let regex = this.patternCache.get(pattern);
    if (!regex) {
      regex = new RegExp(pattern, "g");
      this.patternCache.set(pattern, regex);
    }
    return regex;
  },

  clear() {
    this.patternCache?.clear();
    descriptorParts.clear();
  },
};

/**
 * A container capture. When another capture's node is contained by the
 * definition capture's node, it gets added to this instance.
 */
class Container {
  constructor(capture, organizer) {
    this.captureFields = new Set([capture.name]);
    this.range = capture.node.range;
    this.organizer = organizer;
    this.props = capture.setProperties || {};

    this.tag = capture.name.substring(capture.name.indexOf(".") + 1);
    this.icon = this.resolveIcon();
    this.position = this.range.start;
  }

  hasCapture(capture) {
    return this.captureFields.has(capture.name);
  }

  endsBefore(range) {
    return this.range.end.compare(range.start) === -1;
  }

  add(capture) {
    if (this.captureFields.has(capture.name)) {
      console.warn(`Name already exists:`, capture.name);
    }
    // Any captures added to this definition need to be checked to make sure
    // their nodes are actually descendants of this definition's node.
    if (!this.range.containsRange(capture.node.range)) {
      return false;
    }
    this.captureFields.add(capture.name);
    if (capture.name === "name") {
      this.nameCapture = new Name(capture, this.organizer);
    }
    return true;
  }

  isValid() {
    return this.nameCapture && this.position instanceof Point;
  }

  resolveIcon() {
    // Only an explicit `symbol.icon` from the query. A symbol with none is left
    // to the kind vocabulary in the icon registry, which the view consults.
    return this.props["symbol.icon"] ?? null;
  }

  toSymbol() {
    if (!this.nameCapture) return null;
    let nameSymbol = this.nameCapture.toSymbol();
    let symbol = {
      name: nameSymbol.name,
      shortName: nameSymbol.shortName,
      tag: nameSymbol.tag ?? this.tag,
      icon: nameSymbol.icon ?? this.icon,
      position: this.position,
      range: this.range,
    };

    if (nameSymbol.context) {
      symbol.context = nameSymbol.context;
    }

    return symbol;
  }
}

class Definition extends Container {
  constructor(...args) {
    super(...args);
    this.type = "definition";
  }
}

class Reference extends Container {
  constructor(...args) {
    super(...args);
    this.type = "reference";
  }
}

class Name {
  constructor(capture, organizer) {
    this.type = "name";
    this.organizer = organizer;
    this.props = capture.setProperties ?? {};
    this.node = capture.node;
    this.range = capture.node.range;
    this.position = this.range.start;
    this.shortName = this.resolveBaseName();
    this.name = this.resolveName();
    this.context = this.resolveContext(capture);
    this.tag = this.resolveTag(capture);
    this.icon = this.resolveIcon(capture);
    // Names are fully resolved now. Completed symbols must not keep WASM
    // nodes, raw captures or the organizer alive until the entire scan ends.
    this.node = null;
    this.props = null;
    this.organizer = null;
  }

  getSymbolNameForNode(node) {
    return this.organizer.nameCache.get(node.id);
  }

  resolveBaseName() {
    let { node, props } = this;
    let base = nodeText(node);
    if (props["symbol.strip"]) {
      let pattern = PatternCache.getOrCompile(props["symbol.strip"]);
      base = base.replace(pattern, "");
    }

    return base;
  }

  resolveName() {
    const { node, props } = this;
    let base = this.shortName;

    // TODO: Regex-based replacement?
    if (props["symbol.prepend"]) {
      checkTextLength(props["symbol.prepend"].length + base.length);
      base = `${props["symbol.prepend"]}${base}`;
    }
    if (props["symbol.append"]) {
      checkTextLength(base.length + props["symbol.append"].length);
      base = `${base}${props["symbol.append"]}`;
    }

    let prefix = this.resolvePrefix();
    if (prefix) {
      let joiner = props["symbol.joiner"] ?? "";
      checkTextLength(prefix.length + joiner.length + base.length);
      base = `${prefix}${joiner}${base}`;
    }
    this.organizer.nameCache.set(node.id, base);
    return base;
  }

  resolveContext() {
    let { node, props } = this;
    let result = null;
    if (props["symbol.contextNode"]) {
      let contextNode = resolveNodeDescriptor(node, props["symbol.contextNode"]);
      if (contextNode) {
        result = nodeText(contextNode);
      }
    }

    if (props["symbol.context"]) {
      result = props["symbol.context"];
      checkTextLength(result.length);
    }

    return result;
  }

  resolvePrefix() {
    let { node, props } = this;
    let symbolDescriptor = props["symbol.prependSymbolForNode"];
    let textDescriptor = props["symbol.prependTextForNode"];

    // Prepending with a symbol name requires that we already have determined
    // the name for another node, which means the other node must have a
    // corresponding symbol. But it allows for recursion.
    if (symbolDescriptor) {
      let other = resolveNodeDescriptor(node, symbolDescriptor);
      if (other) {
        let symbolName = this.getSymbolNameForNode(other);
        if (symbolName) return symbolName;
      }
    }

    // A simpler option is to prepend with a node's text. This works on any
    // arbitrary node, even nodes that don't have their own symbol names.
    if (textDescriptor) {
      let other = resolveNodeDescriptor(node, textDescriptor);
      if (other) {
        return nodeText(other);
      }
    }

    return null;
  }

  resolveTag() {
    return this.props["symbol.tag"] ?? null;
  }

  resolveIcon() {
    return this.props["symbol.icon"] ?? null;
  }

  toSymbol() {
    let { name, shortName, position, context, tag, icon } = this;
    let symbol = { name, shortName, position, range: this.range, icon };
    if (tag) symbol.tag = tag;
    if (context) symbol.context = context;

    return symbol;
  }
}

/**
 * Keeps track of @definition.* captures and the captures they may contain.
 */
class CaptureOrganizer {
  clear() {
    this.nameCache ??= new Map();
    this.nameCache.clear();
    this.activeContainers = [];

    this.definitions = [];
    this.references = [];
    this.names = [];
    this.processing = false;
    this.includeReferences = false;
  }

  begin() {
    this.clear();
    this.processing = true;
    this.includeReferences = lumine.config.get("symbol-tree-sitter.includeReferences");
  }

  destroy() {
    PatternCache.clear();
    this.clear();
  }

  isDefinition(capture) {
    return capture.name.startsWith("definition.");
  }

  isReference(capture) {
    return capture.name.startsWith("reference.");
  }

  isName(capture) {
    return capture.name === "name";
  }

  complete(container) {
    if (!container?.isValid()) return;
    if (container instanceof Definition) {
      this.definitions.push(container.toSymbol());
    } else if (container instanceof Reference && this.includeReferences) {
      this.references.push(container.toSymbol());
    }
  }

  addToContainer(capture) {
    let index = this.activeContainers.length - 1;
    let added = false;
    while (index >= 0) {
      let container = this.activeContainers[index];
      if (!container.hasCapture(capture)) {
        if (container.add(capture)) {
          added = true;
          break;
        }
      }
      index--;
    }
    return added;
  }

  pruneActiveContainers(capture) {
    let { range } = capture.node;
    const remaining = [];
    for (let index = this.activeContainers.length - 1; index >= 0; index--) {
      const container = this.activeContainers[index];
      if (container.endsBefore(range)) {
        this.complete(container);
      } else {
        remaining.push(container);
      }
    }
    this.activeContainers = remaining.reverse();
  }

  processCapture(capture) {
    this.pruneActiveContainers(capture);

    if (this.isDefinition(capture)) {
      this.activeContainers.push(new Definition(capture, this));
    } else if (this.isReference(capture)) {
      this.activeContainers.push(new Reference(capture, this));
    } else if (this.isName(capture)) {
      // See if this @name capture belongs with the most recent @definition
      // capture.
      if (!this.addToContainer(capture)) {
        this.names.push(new Name(capture, this).toSymbol());
      }
    } else this.addToContainer(capture);
  }

  process(captures) {
    this.begin();

    for (const capture of captures) this.processCapture(capture);
    for (const container of this.activeContainers) {
      this.complete(container);
    }
    this.activeContainers.length = 0;

    this.processing = false;
    return [...this.definitions, ...this.references, ...this.names];
  }

  async processAsync(captures, options = {}) {
    this.begin();
    return this.processBatch(captures, { ...options, last: true });
  }

  // Batches from a layer are contiguous. Keep only unfinished containers and
  // resolved name strings between them; completed results are already data.
  async processBatch(captures, { last = false, ...options } = {}) {
    if (!this.processing) this.begin();
    const budget = options.budget ?? new WorkBudget(options);
    const signal = budget.signal;
    const symbols = [];

    for (const capture of captures) {
      if (signal?.aborted) return null;
      this.processCapture(capture);
      if (budget.shouldYield() && !(await budget.yield())) return null;
    }
    if (!last) return symbols;
    for (const container of this.activeContainers) {
      if (signal?.aborted) return null;
      this.complete(container);
      if (budget.shouldYield() && !(await budget.yield())) return null;
    }
    this.activeContainers.length = 0;
    this.processing = false;

    // Retain the established definition/reference/standalone-name order before
    // stable position sorting, including symbols with the same start position.
    for (const group of [this.definitions, this.references, this.names]) {
      for (const symbol of group) {
        if (signal?.aborted) return null;
        symbols.push(symbol);
        if (budget.shouldYield() && !(await budget.yield())) return null;
      }
    }

    return symbols;
  }
}

module.exports = CaptureOrganizer;
