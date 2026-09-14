/**
 * Package-local PGlite boundary for tests that exercise the PostgreSQL document
 * contract from outside this package. PGlite is installed in this package's
 * devDependencies, so callers must not reach through a nested node_modules
 * path (which is not stable under pnpm or package publishing).
 */
export { PGlite } from '@electric-sql/pglite';
