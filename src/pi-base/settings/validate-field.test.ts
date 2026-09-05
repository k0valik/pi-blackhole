/**
 * Tests for validateFieldValue — per-field validation.
 */

import { describe, expect, it } from "vitest";
import { validateFieldValue } from "./validate-field.ts";
import type { Field } from "./types.ts";

describe("validateFieldValue", () => {
  // ── enum ────────────────────────────────────────────────────────
  describe("enum", () => {
    const field: Field = {
      key: "mode",
      type: "enum",
      label: "Mode",
      value: "dark",
      options: ["dark", "light", "auto"],
    };

    it("accepts valid enum values", () => {
      expect(validateFieldValue(field, "dark")).toBeUndefined();
      expect(validateFieldValue(field, "light")).toBeUndefined();
      expect(validateFieldValue(field, "auto")).toBeUndefined();
    });

    it("rejects values not in the option list", () => {
      expect(validateFieldValue(field, "solarized")).toMatch(/must be one of/i);
    });

    it("rejects non-string values", () => {
      expect(validateFieldValue(field, 42)).toMatch(/must be a string/i);
      expect(validateFieldValue(field, true)).toMatch(/must be a string/i);
    });
  });

  // ── boolean ─────────────────────────────────────────────────────
  describe("boolean", () => {
    const field: Field = {
      key: "enabled",
      type: "boolean",
      label: "Enabled",
      value: true,
    };

    it("accepts booleans", () => {
      expect(validateFieldValue(field, true)).toBeUndefined();
      expect(validateFieldValue(field, false)).toBeUndefined();
    });

    it("rejects non-booleans", () => {
      expect(validateFieldValue(field, "true")).toMatch(/must be a boolean/i);
      expect(validateFieldValue(field, 1)).toMatch(/must be a boolean/i);
    });
  });

  // ── string ──────────────────────────────────────────────────────
  describe("string", () => {
    const field: Field = {
      key: "name",
      type: "string",
      label: "Name",
      value: "",
    };

    it("accepts strings", () => {
      expect(validateFieldValue(field, "hello")).toBeUndefined();
      expect(validateFieldValue(field, "")).toBeUndefined();
    });

    it("rejects multi-line strings", () => {
      expect(validateFieldValue(field, "hello\nworld")).toMatch(/single-line/i);
    });

    it("rejects non-strings", () => {
      expect(validateFieldValue(field, 42)).toMatch(/must be a string/i);
    });
  });

  // ── text ────────────────────────────────────────────────────────
  describe("text", () => {
    const field: Field = {
      key: "prompt",
      type: "text",
      label: "Prompt",
      value: "",
    };

    it("accepts strings (including multi-line)", () => {
      expect(validateFieldValue(field, "hello\nworld")).toBeUndefined();
      expect(validateFieldValue(field, "")).toBeUndefined();
    });

    it("rejects non-strings", () => {
      expect(validateFieldValue(field, 42)).toMatch(/must be a string/i);
    });
  });

  // ── number (plain) ──────────────────────────────────────────────
  describe("number (plain)", () => {
    const field: Field = {
      key: "threshold",
      type: "number",
      label: "Threshold",
      value: 5,
    };

    it("accepts finite numbers", () => {
      expect(validateFieldValue(field, 5)).toBeUndefined();
      expect(validateFieldValue(field, -3)).toBeUndefined();
      expect(validateFieldValue(field, 0)).toBeUndefined();
    });

    it("rejects NaN / Infinity", () => {
      expect(validateFieldValue(field, NaN)).toMatch(/finite/i);
      expect(validateFieldValue(field, Infinity)).toMatch(/finite/i);
    });

    it("rejects non-numbers", () => {
      expect(validateFieldValue(field, "5")).toMatch(/must be a finite number/i);
    });
  });

  // ── number (integer) ────────────────────────────────────────────
  describe("number (integer)", () => {
    const field: Field = {
      key: "count",
      type: "number",
      label: "Count",
      value: 3,
      integer: true,
    };

    it("accepts integers", () => {
      expect(validateFieldValue(field, 3)).toBeUndefined();
      expect(validateFieldValue(field, 0)).toBeUndefined();
    });

    it("rejects floats", () => {
      expect(validateFieldValue(field, 3.5)).toMatch(/integer/i);
    });
  });

  // ── number (ranged) ─────────────────────────────────────────────
  describe("number (ranged)", () => {
    const field: Field = {
      key: "level",
      type: "number",
      label: "Level",
      value: 1,
      min: 1,
      max: 10,
    };

    it("accepts values within range", () => {
      expect(validateFieldValue(field, 1)).toBeUndefined();
      expect(validateFieldValue(field, 5)).toBeUndefined();
      expect(validateFieldValue(field, 10)).toBeUndefined();
    });

    it("rejects values below min", () => {
      expect(validateFieldValue(field, 0)).toMatch(/at least/i);
    });

    it("rejects values above max", () => {
      expect(validateFieldValue(field, 11)).toMatch(/at most/i);
    });
  });

  // ── number (discrete values) ────────────────────────────────────
  describe("number (discrete values)", () => {
    const field: Field = {
      key: "speed",
      type: "number",
      label: "Speed",
      value: 1,
      values: [1, 2, 3],
    };

    it("accepts values in the list", () => {
      expect(validateFieldValue(field, 1)).toBeUndefined();
      expect(validateFieldValue(field, 2)).toBeUndefined();
      expect(validateFieldValue(field, 3)).toBeUndefined();
    });

    it("rejects values not in the list", () => {
      expect(validateFieldValue(field, 4)).toMatch(/one of/i);
    });
  });

  // ── number (step alignment) ─────────────────────────────────────
  describe("number (step alignment)", () => {
    const field: Field = {
      key: "volume",
      type: "number",
      label: "Volume",
      value: 10,
      min: 0,
      max: 100,
      step: 5,
    };

    it("accepts step-aligned values", () => {
      expect(validateFieldValue(field, 0)).toBeUndefined();
      expect(validateFieldValue(field, 5)).toBeUndefined();
      expect(validateFieldValue(field, 10)).toBeUndefined();
      expect(validateFieldValue(field, 100)).toBeUndefined();
    });

    it("rejects misaligned values", () => {
      expect(validateFieldValue(field, 3)).toMatch(/step/i);
      expect(validateFieldValue(field, 7)).toMatch(/step/i);
      expect(validateFieldValue(field, 101)).toMatch(/at most/i);
    });
  });

  // ── undefined / null ────────────────────────────────────────────
  it("returns undefined for undefined/null values (unset)", () => {
    const field: Field = {
      key: "x",
      type: "string",
      label: "X",
      value: "",
    };
    expect(validateFieldValue(field, undefined)).toBeUndefined();
    expect(validateFieldValue(field, null)).toBeUndefined();
  });

  // ── action / custom ─────────────────────────────────────────────
  it("returns undefined for action/custom types (not validated)", () => {
    const actionField: Field = {
      key: "act",
      type: "action",
      label: "Do it",
      onActivate: () => {},
    };
    const customField: Field = {
      key: "custom",
      type: "custom",
      label: "Custom",
      value: "anything",
      render: () => "",
    };
    expect(validateFieldValue(actionField, "anything")).toBeUndefined();
    expect(validateFieldValue(customField, "anything")).toBeUndefined();
  });
});
