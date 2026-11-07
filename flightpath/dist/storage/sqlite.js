// The only file in the product that loads node:sqlite; everything
// else goes through the storage module's typed functions (ADR-0020).
//
// The warning filter is installed first and the built-in is then
// loaded with process.getBuiltinModule. A static import would be
// resolved at link time — before the filter could be installed —
// and the experimental warning would print anyway.
import { installSqliteWarningFilter } from "./warning-filter.js";
installSqliteWarningFilter();
// The double assertion is the point: the built-in is loaded by
// name at runtime, so nothing narrower is known about it until
// it is treated as the module its types describe.
// eslint-disable-next-line no-restricted-syntax -- the load-by-name above is exactly the case the ban cannot type
const sqlite = process.getBuiltinModule("node:sqlite");
export const DatabaseSync = sqlite.DatabaseSync;
