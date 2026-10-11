import { readFile } from "fs/promises";

/*
 * docx bundles jszip's old setImmediate polyfills, which include an Internet Explorer
 * fallback that creates <script> elements, plus a `new Function(string)` path. Neither
 * ever runs in Obsidian (it always has setImmediate or MessageChannel), but code scanners
 * rightly flag them. Strip them at build time; fail loudly if docx changes this code.
 */
export const stripLegacyScriptTricks = {
  name: "strip-legacy-script-tricks",
  setup(build) {
    build.onLoad({ filter: /[\\/]docx[\\/]dist[\\/]index\.(mjs|cjs|umd\.cjs)$/ }, async (args) => {
      let code = await readFile(args.path, "utf8");
      const patches = [
        // lie / immediate: IE onreadystatechange trick -> plain setTimeout fallback
        [/"document" in t && "onreadystatechange" in t\.document\.createElement\("script"\) \? function\(\) \{[\s\S]*?\} : (function\(\) \{\s*setTimeout\(u, 0\);\s*\})/, "$1"],
        // setimmediate: same IE trick
        [/: l && "onreadystatechange" in l\.createElement\("script"\) \? \(s = l\.documentElement, function\(e\) \{[\s\S]*?\}\) : (function\(e\) \{\s*setTimeout\(c, 0, e\);\s*\})/, ": $1"],
        // setimmediate: string callbacks compiled with new Function -> ignored
        [/"function" != typeof e && \(e = new Function\("" \+ e\)\);/, 'if ("function" != typeof e) return;'],
      ];
      for (const [pattern, replacement] of patches) {
        if (!pattern.test(code)) throw new Error(`strip-legacy-script-tricks: pattern not found in ${args.path} (${pattern}). Has docx changed?`);
        code = code.replace(pattern, replacement);
      }
      return { contents: code, loader: "js" };
    });
  },
};
