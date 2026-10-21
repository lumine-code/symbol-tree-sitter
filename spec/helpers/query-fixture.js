exports.setQuery = async (context, { scopeName, queryType, contents }) => {
  const grammar = context.getGrammar();
  if (grammar.scopeName !== scopeName) throw new Error("Query fixture has the wrong grammar");
  await grammar.setQueryForTest(queryType, contents);
  return true;
};

exports.layers = async (context) =>
  (await context.getGrammarQueryCaptureGroups("tagsQuery")).map((group) => group.grammar.scopeName);
