/** POSIX lexical paths for in-memory NERVA modules. No filesystem or host cwd.
 * Backslashes are ordinary characters; only forward slashes separate segments.
 */
function stringPath(value) {
  if (typeof value !== 'string') {
    const error = new TypeError('The path argument must be a string');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  return value;
}

export function normalize(value) {
  const path = stringPath(value);
  if (path.length === 0) return '.';
  const absolute = path[0] === '/';
  const trailingSlash = path[path.length - 1] === '/';
  const segments = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length && segments[segments.length - 1] !== '..') segments.pop();
      else if (!absolute) segments.push('..');
    } else segments.push(segment);
  }
  let result = segments.join('/');
  if (!result && !absolute) result = '.';
  if (result && trailingSlash) result += '/';
  return absolute ? '/' + result : result;
}

export function dirname(value) {
  const path = stringPath(value);
  if (path.length === 0) return '.';
  const absolute = path[0] === '/';
  // Strip only the final component. Existing repeated separators in the parent
  // remain untouched, as they do with POSIX dirname rather than normalize.
  let end = path.length - 1;
  while (end >= 0 && path[end] === '/') end--;
  if (end < 0) return absolute ? '/' : '.';
  const separator = path.lastIndexOf('/', end);
  if (separator < 0) return absolute ? '/' : '.';
  if (absolute && separator === 1) return '//';
  return separator === 0 ? '/' : path.slice(0, separator);
}

export function join(...paths) {
  const parts = [];
  for (const value of paths) {
    const path = stringPath(value);
    if (path.length) parts.push(path);
  }
  return normalize(parts.join('/'));
}

export const posix = Object.freeze({ normalize, dirname, join });
export default Object.freeze({ posix });
