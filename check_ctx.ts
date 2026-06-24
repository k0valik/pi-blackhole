import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  pi.on("agent_end", (event: any, ctx: any) => {
    console.log("CTX properties:", Object.keys(ctx));
    console.log("waitForIdle exists:", typeof ctx.waitForIdle);
    console.log("compact exists:", typeof ctx.compact);
  });
}
