const FIELDS = ["name", "shortName", "tag", "icon", "context"];

function encode(symbols, start, end, dictionary) {
  const coordinates = new Float64Array((end - start) * 6);
  const labels = new Int32Array((end - start) * FIELDS.length);
  const strings = [];
  for (let index = start; index < end; index++) {
    const symbol = symbols[index];
    const offset = index - start;
    const { position, range } = symbol;
    coordinates.set(
      [
        position.row,
        position.column,
        range.start.row,
        range.start.column,
        range.end.row,
        range.end.column,
      ],
      offset * 6,
    );
    for (let field = 0; field < FIELDS.length; field++) {
      const key = FIELDS[field];
      const value = symbol[key];
      let id;
      if (!Object.hasOwn(symbol, key)) id = -1;
      else if (value === null) id = -2;
      else if (value === undefined) id = -3;
      else {
        if (typeof value !== "string") throw new TypeError(`Invalid symbol field: ${key}`);
        id = dictionary.get(value);
        if (id === undefined) {
          id = dictionary.size;
          dictionary.set(value, id);
          strings.push(value);
        }
      }
      labels[offset * FIELDS.length + field] = id;
    }
  }
  return { version: 1, coordinates, labels, strings };
}

function decode(packet, dictionary, { Point, Range }) {
  const { coordinates, labels, strings } = packet;
  if (
    packet.version !== 1 ||
    !(coordinates instanceof Float64Array) ||
    !(labels instanceof Int32Array) ||
    coordinates.length % 6 !== 0 ||
    labels.length !== (coordinates.length / 6) * FIELDS.length ||
    !Array.isArray(strings)
  )
    throw new TypeError("Invalid symbol packet");
  for (const string of strings) {
    if (typeof string !== "string") throw new TypeError("Invalid symbol dictionary");
    dictionary.push(string);
  }
  const symbols = [];
  for (let index = 0; index < coordinates.length / 6; index++) {
    const offset = index * 6;
    for (let field = 0; field < 6; field++) {
      const value = coordinates[offset + field];
      if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError("Invalid symbol coordinate");
    }
    const start = new Point(coordinates[offset + 2], coordinates[offset + 3]);
    const end = new Point(coordinates[offset + 4], coordinates[offset + 5]);
    const row = coordinates[offset],
      column = coordinates[offset + 1];
    const position =
      row === start.row && column === start.column
        ? start
        : row === end.row && column === end.column
          ? end
          : new Point(row, column);
    const symbol = { position, range: new Range(start, end) };
    for (let field = 0; field < FIELDS.length; field++) {
      const id = labels[index * FIELDS.length + field];
      if (id >= 0 && id < dictionary.length) symbol[FIELDS[field]] = dictionary[id];
      else if (id === -2) symbol[FIELDS[field]] = null;
      else if (id === -3) symbol[FIELDS[field]] = undefined;
      else if (id !== -1) throw new RangeError("Invalid symbol dictionary index");
    }
    symbols.push(symbol);
  }
  return symbols;
}

module.exports = { encode, decode };
