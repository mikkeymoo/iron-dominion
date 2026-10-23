declare const __BUILD_HASH__: string | undefined;

/** Content hash injected by build.mjs into both bundles; 'dev' under Vitest. The worker rejects a mismatched Hello. */
export const BUILD_HASH: string = typeof __BUILD_HASH__ === 'undefined' ? 'dev' : (__BUILD_HASH__ as string);
