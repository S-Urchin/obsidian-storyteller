// Same rules Obsidian's community plugin review runs.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["main.js", "node_modules/**", "esbuild.config.mjs", "eslint.config.mjs", "scripts/**"] },
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// Proper nouns and script conventions the sentence-case check can't know about.
			"obsidianmd/ui/sentence-case": [
				"warn",
				{
					brands: ["Word", "Google Docs", "Greg Pak", "Courier Final Draft", "Courier Prime", "Courier New", "Obsidian"],
					acronyms: ["CAPTION", "SFX", "RADIO", "CSS", "JSON"],
				},
			],
		},
	},
]);
