import { expect, test, vi } from "vitest";
vi.mock("@earendil-works/pi-ai", () => ({
  // pi-ai 0.85.1 overflow.js had this ungated bodyless pattern.
  isContextOverflow: (message: { errorMessage?: string }) =>
    /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i.test(message.errorMessage ?? ""),
}));
import { isRequestLocalError } from "../src/om/retryable-error.js";
test("generic bodyless 400 is not request-local even with pi-ai 0.85.1", () => {
  expect(isRequestLocalError(new Error("Observer API error: 400 status code (no body)"))).toBe(
    false,
  );
});
