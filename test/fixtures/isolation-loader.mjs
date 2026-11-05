const blocked = JSON.parse(process.env.UTILS_TEST_BLOCKED);
const packageRoot = new URL('../../', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  const dependency = result.url.startsWith(packageRoot) ? result.url.slice(packageRoot.length) : result.url;
  if (blocked.some(fragment => dependency.includes(fragment))) {
    throw new Error(`Unexpected dependency loaded: ${specifier}`);
  }
  return result;
}
