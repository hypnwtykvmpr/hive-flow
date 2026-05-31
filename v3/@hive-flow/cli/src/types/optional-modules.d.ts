/**
 * Ambient type declarations for optional runtime-imported modules.
 *
 * These modules are dynamically imported at runtime and may or may not
 * be installed. They are NOT bundled — users install them as needed.
 * Declaring them here prevents TS2307 in strict pnpm CI builds where
 * hoisted node_modules are not available.
 */

declare module 'pg' {
  const pg: any;
  export default pg;
  export const Pool: any;
  export const Client: any;
}

declare module 'sql.js' {
  const initSqlJs: any;
  export default initSqlJs;
}

declare module '@xenova/transformers' {
  const transformers: any;
  export default transformers;
  export const pipeline: any;
  export const env: any;
}
