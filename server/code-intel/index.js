/**
 * Semantic Code Intelligence — public API
 */
module.exports = {
  ...require('./index-builder'),
  ...require('./graph-store'),
  ...require('./utils'),
  ...require('./semantic-ranker'),
  ...require('./dependency-tracer'),
  ...require('./flow-analyzer'),
  ...require('./snippet-selector'),
  ...require('./field-extractor'),
  ...require('./embedding-store'),
  ...require('./grep-fallback'),
  angularIndexer: require('./angular-indexer'),
  routeIndexer: require('./route-indexer'),
  dotnetIndexer: require('./dotnet-indexer'),
  pageCatalog: require('./page-catalog'),
  chunkIndex: require('./chunk-index'),
  hybridRetriever: require('./hybrid-retriever'),
  queryProfile: require('./query-profile'),
  lexicalScorer: require('./lexical-scorer'),
  fieldRegistry: require('./field-registry'),
  fieldSynonyms: require('./field-synonyms'),
};
