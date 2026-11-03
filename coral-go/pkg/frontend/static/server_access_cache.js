/* A synchronous cache-only read. The policy module installs its reader when first loaded. */
let read = () => null;
export const cachedServerAccess = id => read(id);
export const setAccessCacheReader = reader => { read = reader; };
