import { describe, it, expect } from "vitest";
import {
  stemToken,
  tokenizeContent,
  computeSimHash64,
  simHashHammingDistance,
  sorensenDiceTokenSimilarity,
  clusterObservations,
} from "../src/project-recall/dedup.js";
import { technicalDensityFactor } from "../src/project-recall/format-export.js";
import type { CorpusObservation } from "../src/project-recall/corpus.js";

describe("dedup algorithms", () => {
  describe("stemToken", () => {
    it("stems common verb and noun inflections", () => {
      expect(stemToken("refactoring")).toBe("refactor");
      expect(stemToken("refactored")).toBe("refactor");
      expect(stemToken("compaction")).toBe("compact");
      expect(stemToken("compacted")).toBe("compact");
      expect(stemToken("configuring")).toBe("config");
      expect(stemToken("configuration")).toBe("config");
      expect(stemToken("pruned")).toBe("prun");
      expect(stemToken("pruning")).toBe("prun");
    });

    it("stems technical roots and agentive nouns across ecosystems", () => {
      expect(stemToken("initialize")).toBe("init");
      expect(stemToken("initialization")).toBe("init");
      expect(stemToken("authenticate")).toBe("auth");
      expect(stemToken("authentication")).toBe("auth");
      expect(stemToken("synchronous")).toBe("sync");
      expect(stemToken("providers")).toBe("provid");
      expect(stemToken("serializers")).toBe("serializ");
      expect(stemToken("handlers")).toBe("handl");
      expect(stemToken("transpiler")).toBe("transpil");
    });

    it("preserves short tokens and irregular words", () => {
      expect(stemToken("git")).toBe("git");
      expect(stemToken("run")).toBe("run");
      expect(stemToken("bus")).toBe("bus");
      expect(stemToken("is")).toBe("is");
    });

    it("improves token similarity across morphological variants", () => {
      const a = "User refactored the compaction engine";
      const b = "User is refactoring the compaction engine";
      const sim = sorensenDiceTokenSimilarity(a, b);
      expect(sim).toBe(1);
    });
  });

  describe("computeSimHash64 and Hamming distance", () => {
    it("returns 0 distance for identical token sets", () => {
      const tokensA = tokenizeContent(
        "Session goal was updated in unified-config",
      );
      const tokensB = tokenizeContent(
        "Session goal was updated in unified-config",
      );
      const hashA = computeSimHash64(tokensA);
      const hashB = computeSimHash64(tokensB);
      expect(simHashHammingDistance(hashA, hashB)).toBe(0);
    });

    it("returns small distance for near-duplicate sets and large for disjoint sets", () => {
      const tokensA = tokenizeContent(
        "The export command writes a markdown file to disk",
      );
      const tokensB = tokenizeContent(
        "The export command writes a markdown file too disk",
      );
      const tokensC = tokenizeContent(
        "Kitty terminal compatibility issue with ANSI escape sequences",
      );

      const hashA = computeSimHash64(tokensA);
      const hashB = computeSimHash64(tokensB);
      const hashC = computeSimHash64(tokensC);

      const distNear = simHashHammingDistance(hashA, hashB);
      const distFar = simHashHammingDistance(hashA, hashC);

      expect(distNear).toBeLessThan(12);
      expect(distFar).toBeGreaterThan(18);
    });
  });

  describe("technicalDensityFactor", () => {
    it("boosts content with file paths, symbols, CLI flags, and SHAs", () => {
      const technical =
        "ConfigManager.save() in src/om/runtime.ts must check writeConfig() with PI_BLACKHOLE_PASSIVE=true (commit 837530d7)";
      const conversational =
        "User discussed doing some changes later when we get to that part of the plan";

      const techFactor = technicalDensityFactor(technical);
      const convFactor = technicalDensityFactor(conversational);

      expect(techFactor).toBeGreaterThan(convFactor);
      expect(techFactor).toBeGreaterThan(1.15);
      expect(convFactor).toBe(1);
    });

    it("boosts multi-ecosystem technical constructs (Rust, Docker, APIs, SQL, Status codes)", () => {
      const webRustObservation =
        "POST /api/v1/auth/login returned 401 Unauthorized; check Result<Token, AuthError> in crates/server/main.rs and Dockerfile";
      const factor = technicalDensityFactor(webRustObservation);
      expect(factor).toBeGreaterThan(1.25);
    });
  });

  describe("clusterObservations with drift guard", () => {
    it("clusters exact and fuzzy duplicates without drift", () => {
      const obs: CorpusObservation[] = [
        {
          id: "obs1",
          content: "The export command writes markdown to disk",
          relevance: "high",
          timestamp: "2026-08-28T00:00:00Z",
          sessionId: "s1",
          source: "branch",
        },
        {
          id: "obs2",
          content: "The export command writes a markdown file to disk",
          relevance: "high",
          timestamp: "2026-08-28T01:00:00Z",
          sessionId: "s2",
          source: "branch",
        },
        {
          id: "obs3",
          content:
            "Completely unrelated observation regarding kitty terminal freezes",
          relevance: "medium",
          timestamp: "2026-08-28T02:00:00Z",
          sessionId: "s3",
          source: "branch",
        },
      ];

      const clusters = clusterObservations(obs, {
        fuzzy: true,
        sorensen: true,
      });
      expect(clusters).toHaveLength(2);
      expect(
        clusters.find((c) => c.rep.content.includes("export command"))
          ?.occurrences,
      ).toBe(2);
    });
  });
});
