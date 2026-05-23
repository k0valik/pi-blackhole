import { defineConfig } from "vitest/config";

// ── pnpm global store paths for @earendil-works packages ──────────────────

const GLOBAL_PNPM =
	"/home/kovalik/.local/share/pnpm/global/5/.pnpm";

const PKGS: Record<string, string> = {
	"@earendil-works/pi-ai": `${GLOBAL_PNPM}/@earendil-works+pi-ai@0.75.4_ws@8.20.1_zod@4.4.3/node_modules/@earendil-works/pi-ai`,
	"@earendil-works/pi-ai/oauth": `${GLOBAL_PNPM}/@earendil-works+pi-ai@0.75.4_ws@8.20.1_zod@4.4.3/node_modules/@earendil-works/pi-ai/oauth`,
	"@earendil-works/pi-agent-core": `${GLOBAL_PNPM}/@earendil-works+pi-agent-core@0.75.4_ws@8.20.1_zod@4.4.3/node_modules/@earendil-works/pi-agent-core`,
	"@earendil-works/pi-coding-agent": `${GLOBAL_PNPM}/@earendil-works+pi-coding-agent@0.75.4_ws@8.20.1_zod@4.4.3/node_modules/@earendil-works/pi-coding-agent`,
	"@earendil-works/pi-tui": `${GLOBAL_PNPM}/@earendil-works+pi-tui@0.75.4/node_modules/@earendil-works/pi-tui`,
};

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 10000,
		include: ["tests/**/*.test.ts"],
	},
	resolve: {
		alias: [
			// Map @earendil-works/* to global pnpm store
			...Object.entries(PKGS).map(([name, path]) => ({
				find: new RegExp(`^${escapeRegex(name)}$`),
				replacement: path,
			})),
			// Resolve .js → extension-less for our source files
			{
				find: /\.js$/,
				replacement: "",
			},
		],
	},
});

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
