const { Point } = require("lumine");

const descriptorParts = new Map();

function resolveNodeDescriptor(node, descriptor) {
  let parts = descriptorParts.get(descriptor);
  if (!parts) {
    parts = descriptor.split(".");
    descriptorParts.set(descriptor, parts);
  }
  let result = node;
  for (const part of parts) {
    if (result === null) return null;
    if (!result[part]) {
      return null;
    }
    result = result[part];
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
    this.captureFields = new Map();
    this.captureFields.set(capture.name, capture);
    this.capture = capture;
    this.node = capture.node;
    this.range = capture.node.range;
    this.organizer = organizer;
    this.props = capture.setProperties || {};

    this.tag = capture.name.substring(capture.name.indexOf(".") + 1);
    this.icon = this.resolveIcon();
    this.position = this.range.start;
  }

  getCapture(name) {
    return this.captureFields.get(name);
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
    this.captureFields.set(capture.name, capture);
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
    this.capture = capture;
    this.node = capture.node;
    this.range = capture.node.range;
    this.position = this.range.start;
    this.name = this.resolveName(capture);
    this.shortName = this.resolveName(capture, { short: true });
    this.context = this.resolveContext(capture);
    this.tag = this.resolveTag(capture);
    this.icon = this.resolveIcon(capture);
  }

  getSymbolNameForNode(node) {
    return this.organizer.nameCache.get(node.id);
  }

  resolveName(capture, { short = false } = {}) {
    let { node, props } = this;
    let base = node.text;
    if (props["symbol.strip"]) {
      let pattern = PatternCache.getOrCompile(props["symbol.strip"]);
      base = base.replace(pattern, "");
    }

    // The “short name” is the symbol's base name before we prepend or append
    // any text.
    if (short) return base;

    // TODO: Regex-based replacement?
    if (props["symbol.prepend"]) {
      base = `${props["symbol.prepend"]}${base}`;
    }
    if (props["symbol.append"]) {
      base = `${base}${props["symbol.append"]}`;
    }

    let prefix = this.resolvePrefix(capture);
    if (prefix) {
      let joiner = props["symbol.joiner"] ?? "";
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
        result = contextNode.text;
      }
    }

    if (props["symbol.context"]) {
      result = props["symbol.context"];
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
        return other.text;
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
    this.extraCaptures = [];
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
    if (!container) return;
    if (container instanceof Definition) {
      this.definitions.push(container);
    } else if (container instanceof Reference) {
      this.references.push(container);
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
        remaining.unshift(container);
      }
    }
    this.activeContainers = remaining;
  }

  process(captures) {
    this.clear();

    for (let capture of captures) {
      this.pruneActiveContainers(capture);

      if (this.isDefinition(capture)) {
        this.activeContainers.push(new Definition(capture, this));
      } else if (this.isReference(capture)) {
        this.activeContainers.push(new Reference(capture, this));
      } else if (this.isName(capture)) {
        // See if this @name capture belongs with the most recent @definition
        // capture.
        if (this.addToContainer(capture)) {
          continue;
        }
        this.names.push(new Name(capture, this));
      } else {
        if (!this.addToContainer(capture)) {
          continue;
        } else {
          this.extraCaptures.push(capture);
        }
      }
    }
    for (const container of this.activeContainers) {
      this.complete(container);
    }
    this.activeContainers.length = 0;

    let symbols = [];
    for (let definition of this.definitions) {
      if (!definition.isValid()) continue;
      symbols.push(definition.toSymbol());
    }

    if (lumine.config.get("symbol-tree-sitter.includeReferences")) {
      for (let reference of this.references) {
        if (!reference.isValid()) continue;
        symbols.push(reference.toSymbol());
      }
    }

    for (let name of this.names) {
      symbols.push(name.toSymbol());
    }

    return symbols;
  }
}

module.exports = CaptureOrganizer;
