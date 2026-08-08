/** Public identity shared by adapters, broker commands, service files, and release tooling. */
export const PRODUCT_IDENTITY = Object.freeze({
  productName: 'cosyncing',
  primaryBinary: 'cosyncing',
  aliasBinary: 'cosy',
  environmentVariablePrefix: 'COSYNCING_',
  tokenHeader: 'x-cosyncing-token',
  repositoryDirectoryName: '.cosyncing',
  stateDirectoryName: '.cosyncing',
  cacheDirectoryName: 'cosyncing',
  serviceName: 'cosyncing',
  releaseAssetPrefix: 'cosyncing',
});

export type ProductIdentity = typeof PRODUCT_IDENTITY;
