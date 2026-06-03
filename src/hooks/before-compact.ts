/**
 * Before-compact hook — handles pi-vcc compaction + OM content injection.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/hooks/before-compact.ts)
 * Modified by pi-vcc-om:
 * - After pi-vcc compiles its summary, calls buildCompactionProjection
 *   and renderSummary to append observations/reflections to the output.
 * - This is the single joining point between pi-vcc and OM.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "fs";
import { compile } from "../core/summarize";
import type { PiVccCompactionDetails } from "../details";
import { buildCompactionProjection, renderSummary } from "../om/ledger/index.js";
import type { Runtime } from "../om/runtime.js";
import { debugLog } from "../om/debug-log.js";
import { configFileNeedsMigration } from "../core/unified-config.js";
import { completeSimple } from "@earendil-works/pi-ai";
import { runQualityGate, formatGateNotification } from "../quality-gate/index.js";
import type { SourceEvidence } from "../quality-gate/judge.js";

export const PI_VCC_COMPACT_INSTRUCTION = "__pi_vcc__";

// ── Migration reminder ────────────────────────────────────────────────────────

/** Per-session notification count for migration reminder (max 2). */
const migrationNotifyCount = new Map<string, number>();

/**
 * Show migration reminder notification if user's on-disk config still has legacy keys.
 * At most 2 notifications per session. Call after compaction completes.
 */
export function notifyMigrationReminder(
	sessionId: string,
	notify: (msg: string, level: string) => void,
): void {
	const count = migrationNotifyCount.get(sessionId) ?? 0;
	if (count >= 2) return;
	if (!configFileNeedsMigration()) return;
	migrationNotifyCount.set(sessionId, count + 1);
	notify(
		"blackhole: Use `/blackhole configure` to save your updated configuration.",
		"info",
	);
}


const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

const dbg = (debug: boolean, data: Record<string, unknown>) => {
  if (!debug) return;
  try { writeFileSync("/tmp/pi-blackhole-debug.json", JSON.stringify(data, null, 2)); } catch {}
};

const previewContent = (content: unknown): string => {
  if (typeof content === "string") return content.slice(0, 300);
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (c?.type === "text") return c.text ?? "";
        if (c?.type === "toolCall") return `[toolCall:${c.name}]`;
        if (c?.type === "thinking") return `[thinking]`;
        if (c?.type === "image") return `[image:${c.mimeType}]`;
        return `[${c?.type ?? "unknown"}]`;
      })
      .join("\n")
      .slice(0, 300);
  }
  return "";
};

interface EntryWithMessage {
  entry: { id: string; type: string };
  message: { role: string; content: unknown };
}

export type OwnCutCancelReason =
  | "no_live_messages"
  | "too_few_live_messages";

export type OwnCutResult =
  | { ok: true; messages: any[]; firstKeptEntryId: string; compactAll: boolean }
  | { ok: false; reason: OwnCutCancelReason };

export function buildOwnCut(
  branchEntries: any[],
  /** Pi's firstKeptEntryId from preparation (undefined = don't use Pi's cut). */
  piFirstKeptEntryId?: string,
  /** "pi-default" = use Pi's cut, "minimal" = keep only last user message (current). */
  tailBehavior?: "pi-default" | "minimal",
): OwnCutResult {
  // Find the last compaction entry and its firstKeptEntryId
  let lastCompactionIdx = -1;
  let lastKeptId: string | undefined;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type === "compaction") {
      lastCompactionIdx = i;
      lastKeptId = branchEntries[i].firstKeptEntryId;
      break;
    }
  }

  // Orphan recovery: triggers when lastKeptId is set to "" (sentinel from prior
  // compact-all) OR set to an id that no longer exists in the branch. In both cases,
  // start collecting from right after the last compaction entry.
  const hasPriorCompaction = lastCompactionIdx >= 0;
  const hasValidKeptId = !!lastKeptId && branchEntries.some((e: any) => e.id === lastKeptId);
  const orphanRecovery = hasPriorCompaction && !hasValidKeptId;

  // Collect live messages
  const liveMessages: EntryWithMessage[] = [];
  if (orphanRecovery) {
    for (let i = lastCompactionIdx + 1; i < branchEntries.length; i++) {
      const e = branchEntries[i];
      if (e.type === "compaction") continue;
      if (e.type === "message" && e.message) {
        liveMessages.push({ entry: e, message: e.message });
      }
    }
  } else {
    let foundKept = !lastKeptId; // if no prior compaction, start collecting immediately
    for (const e of branchEntries) {
      if (!foundKept && e.id === lastKeptId) foundKept = true;
      if (!foundKept) continue;
      if (e.type === "compaction") continue;
      if (e.type === "message" && e.message) {
        liveMessages.push({ entry: e, message: e.message });
      }
    }
  }

  // ── Pi's cut path: use Pi's firstKeptEntryId instead of last-user cut ──
  if (tailBehavior === "pi-default" && piFirstKeptEntryId) {
    const cutInBranch = branchEntries.findIndex((e: any) => e.id === piFirstKeptEntryId);
    if (cutInBranch >= 0) {
      const liveCutIdx = liveMessages.findIndex((lm) => lm.entry.id === piFirstKeptEntryId);
      if (liveCutIdx > 0) {
        return {
          ok: true,
          messages: liveMessages.slice(0, liveCutIdx).map((e) => e.message),
          firstKeptEntryId: piFirstKeptEntryId,
          compactAll: false,
        };
      }
      if (liveCutIdx === 0) {
        // Pi's cut is at first live message.
        // Pi wants to keep everything, so only compact-all is acceptable (summarizes
        // everything for a fresh page).  If minimal path would aggressively cut
        // (multiple user messages), cancel to respect Pi's guidance.
        let lastUserIdx = liveMessages.length - 1;
        while (lastUserIdx > 0 && liveMessages[lastUserIdx].message.role !== "user") {
          lastUserIdx--;
        }
        if (lastUserIdx > 0) {
          // Multiple user messages — minimal would aggressively cut, violating Pi
          return { ok: false, reason: "too_few_live_messages" };
        }
        // Single user message — fall through to minimal path (will compact-all)
      }
      // liveCutIdx === -1: piFirstKeptEntryId not found in liveMessages
      // (e.g., refers to a non-message entry like type:"custom" OM metadata or
      // type:"compaction"). Resolve to the next message entry after pi's cut point.
      if (liveCutIdx < 0) {
        const nextMsgEntry = branchEntries.find(
          (e: any, i: number) => i > cutInBranch && e.type === "message" && e.message,
        );
        if (nextMsgEntry) {
          const resolvedId: string = nextMsgEntry.id;
          const resolvedLiveIdx = liveMessages.findIndex(
            (lm) => lm.entry.id === resolvedId,
          );
          if (resolvedLiveIdx > 0) {
            return {
              ok: true,
              messages: liveMessages.slice(0, resolvedLiveIdx).map((e) => e.message),
              firstKeptEntryId: resolvedId,
              compactAll: false,
            };
          }
          if (resolvedLiveIdx === 0) {
            let lastUserIdx = liveMessages.length - 1;
            while (lastUserIdx > 0 && liveMessages[lastUserIdx].message.role !== "user") {
              lastUserIdx--;
            }
            if (lastUserIdx > 0) {
              return { ok: false, reason: "too_few_live_messages" };
            }
            // Single user message — fall through to minimal (will compact-all)
          }
          // resolvedLiveIdx === -1: resolved message not in liveMessages
          // (shouldn't happen since liveMessages starts from prior firstKeptEntryId
          // which should be before or at pi's cut), but fall through if it does.
        }
        // No message found after pi's cut point in branch — fall through
      }
    }
    // piFirstKeptEntryId not found in branch → fall through to minimal / orphan recovery
  }

  if (liveMessages.length === 0) return { ok: false, reason: "no_live_messages" };
  if (liveMessages.length <= 2) return { ok: false, reason: "too_few_live_messages" };

  // Summarize all messages, keep only the last user message as context
  let cutIdx = liveMessages.length - 1;
  while (cutIdx > 0 && liveMessages[cutIdx].message.role !== "user") {
    cutIdx--;
  }

  if (cutIdx <= 0) {
    // Single user prompt scenario (or no user at all).
    // Compact EVERYTHING and keep no tail. This handles both:
    //  - Single user prompt at index 0: compact all, fresh start after summary
    //  - No user message at all (e.g., long assistant/tool chain): still compact
    //    to recover from context overflow rather than cancelling and leaving
    //    the session unrecoverable.
    // firstKeptEntryId="" is a sentinel: pi-core's buildSessionContext won't match it
    // (so 0 kept from pre-compaction), and next buildOwnCut triggers orphan recovery.
    return {
      ok: true,
      messages: liveMessages.map((e) => e.message),
      firstKeptEntryId: "",
      compactAll: true,
    };
  }

  return {
    ok: true,
    messages: liveMessages.slice(0, cutIdx).map((e) => e.message),
    firstKeptEntryId: liveMessages[cutIdx].entry.id,
    compactAll: false,
  };
}

const REASON_MESSAGES: Record<OwnCutCancelReason, string> = {
  no_live_messages: "blackhole: Nothing to compact (no live messages)",
  too_few_live_messages: "blackhole: Too few live messages — Pi's default logic preserves visible context. Set tailBehavior to \"minimal\" in config to force compaction with fewer messages.",
};

// ── Quality gate helpers ──────────────────────────────────────────────────

/**
 * Build structured source evidence for the quality gate judge.
 * Extracts message excerpts, file paths, errors, decisions, and constraints
 * from the agent messages — analogous to pi-slipstream-compact's SnapshotManifest
 * but operating directly on raw messages instead of a pre-built snapshot.
 */
function buildSourceEvidence(messages: any[], maxChars: number): SourceEvidence {
	const excerpts: string[] = [];
	const filesModified = new Set<string>();
	const unresolvedErrors: string[] = [];
	const userDecisions: string[] = [];
	const constraints: string[] = [];
	let totalChars = 0;

	// Iterate newest-first so we capture the most recent context
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		const role: string = msg.role ?? "unknown";
		let text = "";

		if (typeof msg.content === "string") {
			text = msg.content;
		} else if (Array.isArray(msg.content)) {
			text = msg.content
				.map((block: any) => {
					if (block.type === "text") return block.text;
					if (block.type === "toolCall") return `[toolCall: ${block.name}]`;
					if (block.type === "toolResult") {
						return `[toolResult: ${typeof block.content === "string" ? block.content.slice(0, 300) : JSON.stringify(block.content ?? "").slice(0, 300)}]`;
					}
					return "";
				})
				.filter(Boolean)
				.join("\n");
		}

		if (!text) continue;

		// Extract structured facts from the text
		// File paths: look for patterns like path/to/file.ts or File: path/to/file
		for (const match of text.matchAll(/["'`]?(?:[\w.-]+\/)+[\w.-]+\.[a-z]+["'`]?/gi)) {
			const path = match[0].replace(/["'`]/g, "");
			if (path.length > 10 && !path.startsWith("node_modules/") && !path.startsWith(".git/")) {
				filesModified.add(path);
			}
		}

		// Errors: lines containing error/exception/failed/failure
		for (const line of text.split("\n")) {
			const lower = line.toLowerCase();
			if (/error|exception|failed|failure|exit code \d+/i.test(lower) && !lower.includes("no error")) {
				const cleaned = line.replace(/^\s*[\[\(]?\d+[\]\)]?\s*/, "").slice(0, 200).trim();
				if (cleaned && !unresolvedErrors.includes(cleaned)) {
					unresolvedErrors.push(cleaned);
				}
			}
		}

		// User decisions and constraints: look for patterns in user messages
		if (role === "user") {
			for (const line of text.split("\n")) {
				const lower = line.toLowerCase().trim();
				if (!lower) continue;
				// User preferences / constraints
				if (/^(?:please |can you |make sure |ensure |remember |don't |do not |always |never )/i.test(lower)) {
					const cleaned = line.trim().slice(0, 150);
					if (!constraints.includes(cleaned)) constraints.push(cleaned);
				}
				// Explicit decisions
				if (/^(?:let's |i (?:decided|chose|pick|want|prefer|think|believe) )/i.test(lower)) {
					const cleaned = line.trim().slice(0, 150);
					if (!userDecisions.includes(cleaned)) userDecisions.push(cleaned);
				}
			}
		}

		const excerpt = `[${role}] ${text.slice(0, 3000)}`;
		if (totalChars + excerpt.length > maxChars) break;

		excerpts.unshift(excerpt); // maintain chronological order
		totalChars += excerpt.length;
	}

	return {
		messageExcerpts: excerpts,
		filesModified: [...filesModified].slice(0, 30),
		unresolvedErrors: unresolvedErrors.slice(0, 15),
		userDecisions: userDecisions.slice(0, 10),
		constraints: constraints.slice(0, 10),
	};
}

/**
 * Create a completeText callback for the quality gate by resolving the judge
 * model and wiring up Pi's LLM infrastructure.
 *
 * Returns null if the model cannot be resolved (caller should skip the gate).
 */
async function makeQualityGateCompleter(
	ctx: any,
	qgConfig: { judgeModel?: string | null },
): Promise<((prompt: string, signal?: AbortSignal) => Promise<string>) | null> {
	try {
		let model: any;
		let apiKey: string;
		let headers: Record<string, string> | undefined;

		const registry = ctx.modelRegistry;
		const judgeModelStr = qgConfig.judgeModel;

		if (judgeModelStr && typeof judgeModelStr === "string") {
			// Parse "provider/modelId"
			const slashIdx = judgeModelStr.indexOf("/");
			if (slashIdx < 0) {
				console.warn(`blackhole: quality gate: invalid judgeModel "${judgeModelStr}" (expected "provider/modelId")`);
				return null;
			}
			const provider = judgeModelStr.slice(0, slashIdx);
			const modelId = judgeModelStr.slice(slashIdx + 1);
			model = registry?.find?.(provider, modelId);
			if (!model) {
				console.warn(`blackhole: quality gate: judge model "${judgeModelStr}" not found in registry`);
				return null;
			}
			const auth = await registry?.getApiKeyAndHeaders?.(model);
			if (!auth?.ok) {
				console.warn(`blackhole: quality gate: no auth for judge model "${judgeModelStr}"`);
				return null;
			}
			apiKey = auth.apiKey as string;
			headers = auth.headers as Record<string, string> | undefined;
		} else {
			// Use session's active model
			model = ctx.model;
			if (!model) {
				console.warn("blackhole: quality gate: no session model available");
				return null;
			}
			const auth = await registry?.getApiKeyAndHeaders?.(model);
			if (!auth?.ok) {
				console.warn("blackhole: quality gate: no API key for session model");
				return null;
			}
			apiKey = auth.apiKey as string;
			headers = auth.headers as Record<string, string> | undefined;
		}

		return async (prompt: string, signal?: AbortSignal): Promise<string> => {
			const result = await completeSimple(model, {
				messages: [{ role: "user", content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }],
			}, {
				apiKey,
				headers,
				signal,
				maxTokens: 2000,
			});
			const textBlock = result.content.find(
				(b: any): b is { type: "text"; text: string } => b.type === "text",
			);
			return textBlock?.text ?? "";
		};
	} catch (err) {
		console.warn(`blackhole: quality gate: failed to resolve model: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}


export const registerBeforeCompactHook = (pi: ExtensionAPI, omRuntime: Runtime) => {
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, branchEntries, customInstructions } = event;
    omRuntime.ensureConfig(ctx.cwd ?? process.cwd());
    const trace = (ev: string, d?: Record<string, unknown>) => debugLog(ev, d, omRuntime.config.debugLog === true);

    trace("before_compact.enter", {
      customInstructions,
      isPiVcc: customInstructions === PI_VCC_COMPACT_INSTRUCTION,
      overrideDefaultCompaction: omRuntime.config.overrideDefaultCompaction,
      noAutoCompact: omRuntime.config.noAutoCompact,
      branchLength: branchEntries.length,
      hasPreviousSummary: !!preparation.previousSummary,
    });

    // Always handle explicit /blackhole marker.
    // Otherwise, only handle when user opted in via settings.
    const isPiVcc = customInstructions === PI_VCC_COMPACT_INSTRUCTION;

    // NEW: Unified compaction guards
    // compaction "off": blackhole skips auto-triggered, but /blackhole still uses blackhole pipeline
    if (omRuntime.config.compaction === "off" && !isPiVcc) {
      trace("before_compact.return_early", { reason: "compaction_off" });
      return;
    }

    // compactionEngine "pi-default" means let Pi handle auto-triggered compactions
    if (omRuntime.config.compactionEngine === "pi-default" && !isPiVcc) {
      trace("before_compact.return_early", { reason: "compactionEngine_pi_default" });
      return;
    }

    // compaction "manual": /compact falls through to Pi, /blackhole still works
    if (omRuntime.config.compaction === "manual" && !isPiVcc) {
      trace("before_compact.return_early", { reason: "compaction_manual" });
      return;
    }

    // LEGACY: old config key guards — only apply when new keys are absent (unmigrated config)
    if (omRuntime.config.compaction === undefined && omRuntime.config.compactionEngine === undefined) {
      if (!isPiVcc && !omRuntime.config.overrideDefaultCompaction) {
        trace("before_compact.return_early", { reason: "overrideDefaultCompaction=false and not /blackhole" });
        return;
      }

      if (omRuntime.config.noAutoCompact && !isPiVcc) {
        trace("before_compact.cancel", { reason: "noAutoCompact and not /blackhole" });
        return { cancel: true };
      }
    }

    // Determine effective tail behavior for buildOwnCut
    const effectiveTailBehavior = isPiVcc
      ? (omRuntime.config.tailBehavior ?? "minimal")   // /blackhole: minimal by default
      : (omRuntime.config.tailBehavior ?? "minimal");

    trace("before_compact.tail_behavior", {
      effectiveTailBehavior,
      configTailBehavior: omRuntime.config.tailBehavior,
      isPiVcc,
      piFirstKeptEntryId: preparation.firstKeptEntryId,
    });

    const ownCut = buildOwnCut(
      branchEntries as any[],
      preparation.firstKeptEntryId,
      effectiveTailBehavior,
    );
    if (!ownCut.ok) {
      const lastComp = [...branchEntries].reverse().find((e: any) => e.type === "compaction");
      const lastCompIdx = lastComp ? (branchEntries as any[]).indexOf(lastComp) : -1;

      // Recompute liveMessages view (same logic as buildOwnCut) for diagnostic
      const lastKeptId: string | undefined = (lastComp as any)?.firstKeptEntryId;
      const hasPriorCompaction = lastCompIdx >= 0;
      const hasValidKeptId = !!lastKeptId && (branchEntries as any[]).some((e: any) => e.id === lastKeptId);
      const diagOrphan = hasPriorCompaction && !hasValidKeptId;
      const liveRoles: string[] = [];
      if (diagOrphan) {
        for (let i = lastCompIdx + 1; i < branchEntries.length; i++) {
          const e = (branchEntries as any[])[i];
          if (e.type === "compaction") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      } else {
        let foundKept = !lastKeptId;
        for (const e of branchEntries as any[]) {
          if (!foundKept && e.id === lastKeptId) foundKept = true;
          if (!foundKept) continue;
          if (e.type === "compaction") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      }
      const userIndices = liveRoles.reduce<number[]>((acc, r, i) => (r === "user" ? (acc.push(i), acc) : acc), []);

      dbg(omRuntime.config.debug, {
        cancelled: true,
        reason: ownCut.reason,
        isPiVcc,
        counts: {
          total: branchEntries.length,
          messages: (branchEntries as any[]).filter((e: any) => e.type === "message").length,
          compactions: (branchEntries as any[]).filter((e: any) => e.type === "compaction").length,
          entriesAfterLastCompaction: lastCompIdx >= 0 ? branchEntries.length - lastCompIdx - 1 : null,
        },
        liveMessages: {
          count: liveRoles.length,
          userCount: userIndices.length,
          firstUserIdx: userIndices[0] ?? null,
          lastUserIdx: userIndices[userIndices.length - 1] ?? null,
          roleSequence: liveRoles.length <= 30
            ? liveRoles
            : [...liveRoles.slice(0, 10), "...", ...liveRoles.slice(-10)],
        },
        lastCompaction: lastComp ? {
          hasFirstKeptEntryId: !!(lastComp as any).firstKeptEntryId,
          foundInBranch: (lastComp as any).firstKeptEntryId
            ? (branchEntries as any[]).some((e: any) => e.id === (lastComp as any).firstKeptEntryId)
            : null,
        } : null,
        tail: (branchEntries as any[]).slice(-5).map((e: any) => ({
          type: e.type,
          role: e.type === "message" ? e.message?.role : undefined,
          hasContent: e.type === "message" ? e.message?.content != null : undefined,
        })),
      });

      trace("before_compact.cancel", { reason: ownCut.reason, isPiVcc });
      try {
        ctx?.ui?.notify?.(REASON_MESSAGES[ownCut.reason], "warning");
      } catch {}
      return { cancel: true };
    }

    trace("before_compact.proceeding", {
      messageCount: ownCut.messages.length,
      firstKeptEntryId: ownCut.firstKeptEntryId,
      compactAll: ownCut.compactAll,
      isPiVcc,
    });

    const agentMessages = ownCut.messages;
    const firstKeptEntryId = ownCut.firstKeptEntryId;
    const messages = convertToLlm(agentMessages);

    // Count kept messages and estimate tokens
    const keptIdx = (branchEntries as any[]).findIndex((e: any) => e.id === firstKeptEntryId);
    const keptEntries = keptIdx >= 0
      ? (branchEntries as any[]).slice(keptIdx).filter((e: any) => e.type === "message")
      : [];
    const keptChars = keptEntries.reduce((sum: number, e: any) => {
      const c = e.message?.content;
      if (typeof c === "string") return sum + c.length;
      if (Array.isArray(c)) return sum + c.reduce((s: number, p: any) => {
        if (p.text) return s + p.text.length;
        if (p.type === "toolCall") return s + (p.name?.length ?? 0) + (typeof p.input === "string" ? p.input.length : JSON.stringify(p.input ?? "").length);
        if (p.type === "toolResult") return s + (typeof p.content === "string" ? p.content.length : JSON.stringify(p.content ?? "").length);
        return s;
      }, 0);
      return sum;
    }, 0);
    omRuntime.compactionStats = {
      summarized: agentMessages.length,
      kept: keptEntries.length,
      keptTokensEst: Math.round(keptChars / 4),
    };

    const summary = compile({
      messages,
      previousSummary: preparation.previousSummary,
      fileOps: {
        readFiles: [...preparation.fileOps.read],
        modifiedFiles: [...preparation.fileOps.written, ...preparation.fileOps.edited],
      },
    });

    const branchIds = branchEntries.map((e: any) => e.id);
    const cutIdx = branchIds.indexOf(firstKeptEntryId);
    const cutWindow = cutIdx >= 0
      ? branchEntries.slice(Math.max(0, cutIdx - 3), Math.min(branchEntries.length, cutIdx + 3)).map((e: any) => ({
          id: e.id,
          type: e.type,
          role: e.type === "message" ? e.message?.role : undefined,
          preview: e.type === "message" ? previewContent(e.message?.content) : undefined,
        }))
      : [];

    dbg(omRuntime.config.debug, {
      usedOwnCut: true,
      messagesToSummarize: agentMessages.length,
      messagesPreviewHead: agentMessages.slice(0, 3).map((m: any) => ({ role: m.role, preview: previewContent(m.content) })),
      messagesPreviewTail: agentMessages.slice(-3).map((m: any) => ({ role: m.role, preview: previewContent(m.content) })),
      convertedMessages: messages.length,
      firstKeptEntryId,
      cutWindow,
      tokensBefore: preparation.tokensBefore,
      summaryLength: summary.length,
      summaryPreview: summary.slice(0, 500),
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
    });

    trace("before_compact.summary_generated", { summaryLength: summary.length, messageCount: agentMessages.length });

    const details: PiVccCompactionDetails = {
      compactor: "blackhole",
      version: 1,
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
      sourceMessageCount: agentMessages.length,
      previousSummaryUsed: Boolean(preparation.previousSummary),
    };

    omRuntime.compactWasPiVcc = isPiVcc;

    // ── Inject observational-memory content ───────────────────────────
    let omContent = "";
    let omDetails: Record<string, unknown> | undefined;
    trace("before_compact.om_injection", { memoryEnabled: omRuntime.config.memory !== false });
    if (omRuntime.config.memory !== false) {
      const projection = buildCompactionProjection(
      branchEntries as any[],
      firstKeptEntryId,
      { observationsPoolMaxTokens: omRuntime.config.observationsPoolMaxTokens },
    );
      omContent = renderSummary(projection.reflections, projection.observations);
      omDetails = projection.details;
    }

    // ── Build the combined summary ──
    const combinedSummary = omContent ? summary + "\n\n" + omContent : summary;

    // ── Optional quality gate ──
    let finalSummary = combinedSummary;
    let qualityGateDetails: Record<string, unknown> | undefined;
    const qgConfig = omRuntime.config.qualityGate;
    if (
      qgConfig?.enabled &&
      omRuntime.config.compactionEngine !== "pi-default"
    ) {
      const sourceEvidence = buildSourceEvidence(agentMessages, 8000);
      const traceInfo: Record<string, unknown> = {
        sourceMessageCount: agentMessages.length,
        excerptChars: sourceEvidence.messageExcerpts.reduce((s, e) => s + e.length, 0),
        filesFound: sourceEvidence.filesModified.length,
        errorsFound: sourceEvidence.unresolvedErrors.length,
      };

      try {
        const completeText = await makeQualityGateCompleter(ctx, qgConfig);
        if (completeText) {
          const gateResult = await runQualityGate({
            candidate: combinedSummary,
            sourceEvidence,
            completeText,
            config: qgConfig,
            signal: event.signal,
          });

          finalSummary = gateResult.summary;
          qualityGateDetails = {
            accepted: gateResult.accepted,
            repaired: gateResult.repaired,
            score: gateResult.score,
            diagnosis: gateResult.diagnosis,
            repairCount: gateResult.repairCount,
          };

          Object.assign(traceInfo, qualityGateDetails);

          // Apply onRejected policy
          if (!gateResult.accepted) {
            if (qgConfig.onRejected === "reject") {
              ctx?.ui?.notify?.(formatGateNotification(gateResult), "warning");
              return { cancel: true };
            }
            // "warn" (default): accept with notification
            ctx?.ui?.notify?.(formatGateNotification(gateResult), "info");
          }
        }
      } catch (err) {
        // Gate failure: fall through to accept the original summary
        traceInfo.gateError = err instanceof Error ? err.message : String(err);
      }

      trace("before_compact.quality_gate", traceInfo);
    }

    return {
      compaction: {
        summary: finalSummary,
        details: { ...details, "om.folded": omDetails, ...(qualityGateDetails ? { "quality-gate": qualityGateDetails } : {}) },
        tokensBefore: preparation.tokensBefore,
        firstKeptEntryId,
      },
    };
  });

  // Fire success toast for /compact path only (delayed to let UI settle).
  // /blackhole path uses its own onComplete callback in the command handler.
  pi.on("session_compact", (event, ctx) => {
    if (!event.fromExtension) return;
    if (omRuntime.compactWasPiVcc) return; // /blackhole handles its own toast via onComplete
    const stats = omRuntime.compactionStats;
    if (!stats) return;
    const sessionId = ctx.sessionManager.getSessionId();
    setTimeout(() => {
      try {
        ctx?.ui?.notify?.(
          `blackhole: ${stats.summarized} source entries processed; tail kept ${stats.kept} (~${formatTokens(stats.keptTokensEst)} tok).`,
          "info",
        );
        notifyMigrationReminder(sessionId, (msg, level) => ctx?.ui?.notify?.(msg, level as any));
      } catch {}
    }, 500);
  });
};
