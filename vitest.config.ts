import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 10000,
		include: ["tests/**/*.test.ts"],
	},
	resolve: {
		alias: [
			// Resolve .js → extension-less for our TypeScript source files
			{
				find: /\.js$/,
				replacement: "",
			},
		],
	},
});
