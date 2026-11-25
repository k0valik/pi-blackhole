import { afterEach, describe, expect, it } from "vitest";
import {
  decodeKittyPrintable,
  isKittyProtocolActive,
  matchesKey,
  parseKey,
  setKittyProtocolActive,
} from "../src/ui/keys.js";

const ORIGINAL_WT_SESSION = process.env.WT_SESSION;

function withWindowsTerminal(fn: () => void): void {
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_CLIENT;
  delete process.env.SSH_TTY;
  try {
    fn();
  } finally {
    if (ORIGINAL_WT_SESSION === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = ORIGINAL_WT_SESSION;
  }
}

afterEach(() => {
  setKittyProtocolActive(false);
  if (ORIGINAL_WT_SESSION === undefined) delete process.env.WT_SESSION;
  else process.env.WT_SESSION = ORIGINAL_WT_SESSION;
});

describe("matchesKey — arrows", () => {
  it("matches CSI arrows in legacy mode", () => {
    expect(matchesKey("\x1b[A", "up")).toBe(true);
    expect(matchesKey("\x1b[B", "down")).toBe(true);
    expect(matchesKey("\x1b[C", "right")).toBe(true);
    expect(matchesKey("\x1b[D", "left")).toBe(true);
  });

  it("matches SS3 arrows", () => {
    expect(matchesKey("\x1bOA", "up")).toBe(true);
    expect(matchesKey("\x1bOB", "down")).toBe(true);
    expect(matchesKey("\x1bOC", "right")).toBe(true);
    expect(matchesKey("\x1bOD", "left")).toBe(true);
  });

  it("does not cross-match arrow directions", () => {
    expect(matchesKey("\x1b[B", "up")).toBe(false);
    expect(matchesKey("\x1b[D", "right")).toBe(false);
  });

  it("matches Kitty arrow sequences with modifier bits", () => {
    expect(matchesKey("\x1b[1;1A", "up")).toBe(true);
    expect(matchesKey("\x1b[1;5A", "ctrl+up")).toBe(true);
    expect(matchesKey("\x1b[1;2A", "shift+up")).toBe(true);
    expect(matchesKey("\x1b[1;3A", "alt+up")).toBe(true);
  });

  it("does not treat a malformed modifyOtherKeys arrow as a match", () => {
    // modifyOtherKeys only carries real codepoints; arrows arrive as CSI 1;mod A-D.
    expect(matchesKey("\x1b[27;5;-1~", "ctrl+up")).toBe(false);
    expect(matchesKey("\x1b[1;5A", "ctrl+up")).toBe(true);
  });

  it("matches legacy ctrl+arrow xterm form", () => {
    expect(matchesKey("\x1b[1;5D", "ctrl+left")).toBe(true);
    expect(matchesKey("\x1bOd", "ctrl+left")).toBe(true);
  });
});

describe("matchesKey — alt arrows", () => {
  it("matches ESC+f as alt+right in legacy mode", () => {
    expect(matchesKey("\x1bf", "alt+right")).toBe(true);
  });

  it("matches ESC+B as alt+left only while Kitty protocol is inactive", () => {
    expect(matchesKey("\x1bB", "alt+left")).toBe(true);
    setKittyProtocolActive(true);
    expect(matchesKey("\x1bB", "alt+left")).toBe(false);
  });

  it("matches alt+left through the xterm arrow form, not a negative CSI-u codepoint", () => {
    expect(matchesKey("\x1b[1;3D", "alt+left")).toBe(true);
    expect(matchesKey("\x1b[-4;3u", "alt+left")).toBe(false);
  });
});

describe("matchesKey — enter and return", () => {
  it("matches CR for both enter and return", () => {
    expect(matchesKey("\r", "enter")).toBe(true);
    expect(matchesKey("\r", "return")).toBe(true);
  });

  it("matches LF as enter only while Kitty protocol is inactive", () => {
    expect(matchesKey("\n", "enter")).toBe(true);
    setKittyProtocolActive(true);
    expect(matchesKey("\n", "enter")).toBe(false);
  });

  it("matches SS3 M (numpad enter) as enter", () => {
    expect(matchesKey("\x1bOM", "enter")).toBe(true);
  });

  it("matches Kitty CSI-u enter and numpad enter", () => {
    expect(matchesKey("\x1b[13u", "enter")).toBe(true);
    expect(matchesKey("\x1b[13;1u", "enter")).toBe(true);
    expect(matchesKey("\x1b[57414u", "enter")).toBe(true);
  });

  it("rejects space for enter", () => {
    expect(matchesKey(" ", "enter")).toBe(false);
  });
});

describe("matchesKey — shift+enter and alt+enter", () => {
  it("treats ESC+CR as alt+enter in legacy mode", () => {
    expect(matchesKey("\x1b\r", "alt+enter")).toBe(true);
  });

  it("reinterprets ESC+CR as shift+enter once Kitty protocol is active", () => {
    setKittyProtocolActive(true);
    expect(matchesKey("\x1b\r", "alt+enter")).toBe(false);
    expect(matchesKey("\x1b\r", "shift+enter")).toBe(true);
  });

  it("matches CSI-u shift+enter", () => {
    expect(matchesKey("\x1b[13;2u", "shift+enter")).toBe(true);
    expect(matchesKey("\x1b[13;3u", "alt+enter")).toBe(true);
  });
});

describe("matchesKey — escape", () => {
  it("matches a bare ESC byte", () => {
    expect(matchesKey("\x1b", "escape")).toBe(true);
    expect(matchesKey("\x1b", "esc")).toBe(true);
  });

  it("rejects printable input", () => {
    expect(matchesKey("x", "escape")).toBe(false);
  });

  it("matches Kitty CSI-u escape", () => {
    expect(matchesKey("\x1b[27u", "escape")).toBe(true);
    expect(matchesKey("\x1b[27;1u", "escape")).toBe(true);
  });

  it("rejects modified escape ids", () => {
    expect(matchesKey("\x1b", "ctrl+escape")).toBe(false);
  });
});

describe("matchesKey — named Ctrl combinations", () => {
  it("matches raw control bytes for letters", () => {
    expect(matchesKey("\x03", "ctrl+c")).toBe(true);
    expect(matchesKey("\x01", "ctrl+a")).toBe(true);
    expect(matchesKey("\x13", "ctrl+s")).toBe(true);
  });

  it("does not match a different letter's control byte", () => {
    expect(matchesKey("\x03", "ctrl+s")).toBe(false);
  });

  it("matches CSI-u ctrl+letter", () => {
    expect(matchesKey("\x1b[99;5u", "ctrl+c")).toBe(true);
    expect(matchesKey("\x1b[115;5u", "ctrl+s")).toBe(true);
  });

  it("accepts both spellings of the ctrl+[ raw byte collision", () => {
    // Legacy terminals send a bare ESC for Ctrl+[, so plain escape input also
    // satisfies a ctrl+[ binding; only CSI-u disambiguates them.
    expect(matchesKey("\x1b", "ctrl+[")).toBe(true);
    expect(matchesKey("\x1b[91;5u", "ctrl+[")).toBe(true);
  });

  it("matches ctrl+- via the 0x1f alias of ctrl+_", () => {
    expect(matchesKey("\x1f", "ctrl+-")).toBe(true);
    expect(matchesKey("\x1f", "ctrl+_")).toBe(true);
  });

  it("matches ctrl+space as the raw NUL byte in legacy mode", () => {
    expect(matchesKey("\x00", "ctrl+space")).toBe(true);
    setKittyProtocolActive(true);
    expect(matchesKey("\x00", "ctrl+space")).toBe(false);
  });
});

describe("matchesKey — tab and shift+tab", () => {
  it("matches TAB", () => {
    expect(matchesKey("\t", "tab")).toBe(true);
  });

  it("matches CSI-u tab", () => {
    expect(matchesKey("\x1b[9u", "tab")).toBe(true);
  });

  it("matches shift+tab as CSI-[Z", () => {
    expect(matchesKey("\x1b[Z", "shift+tab")).toBe(true);
    expect(matchesKey("\t", "shift+tab")).toBe(false);
  });
});

describe("matchesKey — alt keys", () => {
  it("matches ESC+letter as alt+letter in legacy mode", () => {
    expect(matchesKey("\x1bd", "alt+d")).toBe(true);
    expect(matchesKey("\x1bx", "alt+x")).toBe(true);
  });

  it("does not accept ESC+letter once Kitty protocol is active", () => {
    setKittyProtocolActive(true);
    expect(matchesKey("\x1bd", "alt+d")).toBe(false);
  });

  it("matches CSI-u alt+letter", () => {
    expect(matchesKey("\x1b[100;3u", "alt+d")).toBe(true);
  });

  it("matches alt+backspace in both legacy spellings", () => {
    expect(matchesKey("\x1b\x7f", "alt+backspace")).toBe(true);
    expect(matchesKey("\x1b\b", "alt+backspace")).toBe(true);
  });
});

describe("matchesKey — backspace and the raw 0x08 ambiguity", () => {
  it("matches DEL (0x7f) as plain backspace", () => {
    expect(matchesKey("\x7f", "backspace")).toBe(true);
    expect(matchesKey("\x7f", "ctrl+backspace")).toBe(false);
  });

  it("treats raw 0x08 as plain backspace outside Windows Terminal", () => {
    delete process.env.WT_SESSION;
    expect(matchesKey("\x08", "backspace")).toBe(true);
    expect(matchesKey("\x08", "ctrl+backspace")).toBe(false);
  });

  it("treats raw 0x08 as ctrl+backspace inside Windows Terminal", () => {
    withWindowsTerminal(() => {
      process.env.WT_SESSION = "1:2;3";
      expect(matchesKey("\x08", "ctrl+backspace")).toBe(true);
      expect(matchesKey("\x08", "backspace")).toBe(false);
    });
  });

  it("keeps 0x08 shadowed by ctrl+h for the ctrl+h binding", () => {
    delete process.env.WT_SESSION;
    // 0x08 is Ctrl+H's raw byte, so a ctrl+h binding always claims it.
    expect(matchesKey("\x08", "ctrl+h")).toBe(true);
  });

  it("matches CSI-u backspace variants", () => {
    expect(matchesKey("\x1b[127u", "backspace")).toBe(true);
    expect(matchesKey("\x1b[127;5u", "ctrl+backspace")).toBe(true);
    expect(matchesKey("\x1b[127;3u", "alt+backspace")).toBe(true);
  });
});

describe("matchesKey — functional and navigation keys", () => {
  it("matches delete and insert", () => {
    expect(matchesKey("\x1b[3~", "delete")).toBe(true);
    expect(matchesKey("\x1b[2~", "insert")).toBe(true);
    expect(matchesKey("\x1b[3$", "shift+delete")).toBe(true);
    expect(matchesKey("\x1b[3^", "ctrl+delete")).toBe(true);
  });

  it("matches home and end in their xterm and vt100 spellings", () => {
    expect(matchesKey("\x1b[H", "home")).toBe(true);
    expect(matchesKey("\x1bOH", "home")).toBe(true);
    expect(matchesKey("\x1b[7~", "home")).toBe(true);
    expect(matchesKey("\x1b[F", "end")).toBe(true);
    expect(matchesKey("\x1b[8~", "end")).toBe(true);
  });

  it("matches pageUp/pageDown including the tmux bracket form", () => {
    expect(matchesKey("\x1b[5~", "pageUp")).toBe(true);
    expect(matchesKey("\x1b[[5~", "pageUp")).toBe(true);
    expect(matchesKey("\x1b[6~", "pageDown")).toBe(true);
    expect(matchesKey("\x1b[[6~", "pageDown")).toBe(true);
  });

  it("matches function keys across SS3, DEC and Linux spellings", () => {
    expect(matchesKey("\x1bOP", "f1")).toBe(true);
    expect(matchesKey("\x1b[11~", "f1")).toBe(true);
    expect(matchesKey("\x1b[[A", "f1")).toBe(true);
    expect(matchesKey("\x1bOS", "f4")).toBe(true);
    expect(matchesKey("\x1b[24~", "f12")).toBe(true);
  });

  it("matches Kitty functional PUA equivalents", () => {
    expect(matchesKey("\x1b[57426u", "delete")).toBe(true);
    expect(matchesKey("\x1b[57423u", "home")).toBe(true);
    expect(matchesKey("\x1b[57419u", "up")).toBe(true);
  });
});

describe("matchesKey — printable keys and key id parsing", () => {
  it("matches a plain letter", () => {
    expect(matchesKey("x", "x")).toBe(true);
    expect(matchesKey("X", "x")).toBe(false);
  });

  it("matches shift+letter as the uppercase byte", () => {
    expect(matchesKey("X", "shift+x")).toBe(true);
  });

  it("matches a shifted symbol through its logical form", () => {
    // The logical match needs the terminal to report the base key: CSI-u sends
    // "+" as <shifted>:<base>;<mod>, so "43" alone only matches "shift+".
    expect(matchesKey("\x1b[61:43;2u", "+")).toBe(true);
    expect(matchesKey("\x1b[61:43;2u", "shift+=")).toBe(true);
    expect(matchesKey("\x1b[43;2u", "+")).toBe(false);
    expect(matchesKey("\x1b[43;2u", "shift+=")).toBe(false);
  });

  it("returns false for unknown or malformed key ids", () => {
    expect(matchesKey("x", "unknown" as never)).toBe(false);
    expect(matchesKey("\x1b", "ctrl+ctrl+c" as never)).toBe(false);
  });

  it("is case-insensitive on the key id", () => {
    expect(matchesKey("\x03", "CTRL+C" as never)).toBe(true);
  });
});

describe("decodeKittyPrintable", () => {
  it("decodes a plain CSI-u printable", () => {
    expect(decodeKittyPrintable("\x1b[53u")).toBe("5");
  });

  it("prefers the shifted codepoint when shift is held", () => {
    expect(decodeKittyPrintable("\x1b[97:65;2u")).toBe("A");
  });

  it("decodes a non-ASCII codepoint", () => {
    expect(decodeKittyPrintable("\x1b[233u")).toBe("é");
  });

  it("returns undefined for non CSI-u input", () => {
    expect(decodeKittyPrintable("a")).toBeUndefined();
    expect(decodeKittyPrintable("\x1b[A")).toBeUndefined();
  });

  it("rejects ctrl and alt modified CSI-u sequences", () => {
    expect(decodeKittyPrintable("\x1b[97;5u")).toBeUndefined();
    expect(decodeKittyPrintable("\x1b[97;3u")).toBeUndefined();
  });

  it("rejects super-modified sequences", () => {
    expect(decodeKittyPrintable("\x1b[97;9u")).toBeUndefined();
  });

  it("ignores caps-lock and num-lock bits", () => {
    expect(decodeKittyPrintable("\x1b[97;65u")).toBe("a");
  });

  it("drops control codepoints and unmapped functional PUA codepoints", () => {
    expect(decodeKittyPrintable("\x1b[13u")).toBeUndefined();
    expect(decodeKittyPrintable("\x1b[57344u")).toBeUndefined();
  });

  it("maps keypad codepoints to their printable equivalents", () => {
    expect(decodeKittyPrintable("\x1b[57399u")).toBe("0");
    expect(decodeKittyPrintable("\x1b[57409u")).toBe(".");
  });
});

describe("parseKey", () => {
  it("round-trips recognized legacy sequences", () => {
    expect(parseKey("\x1b")).toBe("escape");
    expect(parseKey("\t")).toBe("tab");
    expect(parseKey("\r")).toBe("enter");
    expect(parseKey("\x7f")).toBe("backspace");
    expect(parseKey("\x1b[Z")).toBe("shift+tab");
    expect(parseKey("\x1bb")).toBe("alt+left");
  });

  it("names raw control bytes as ctrl+letter", () => {
    expect(parseKey("\x03")).toBe("ctrl+c");
    expect(parseKey("\x1f")).toBe("ctrl+-");
  });

  it("resolves the raw 0x08 ambiguity the same way matchesKey does", () => {
    delete process.env.WT_SESSION;
    expect(parseKey("\x08")).toBe("backspace");
    withWindowsTerminal(() => {
      process.env.WT_SESSION = "1:2;3";
      expect(parseKey("\x08")).toBe("ctrl+backspace");
    });
  });

  it("formats Kitty sequences with modifier names", () => {
    expect(parseKey("\x1b[99;5u")).toBe("ctrl+c");
    expect(parseKey("\x1b[1;5A")).toBe("ctrl+up");
  });

  it("returns undefined for unrecognized input", () => {
    expect(parseKey("\x1b[999999u")).toBeUndefined();
  });
});

describe("kitty protocol state contract", () => {
  it("defaults to inactive and toggles explicitly", () => {
    expect(isKittyProtocolActive()).toBe(false);
    setKittyProtocolActive(true);
    expect(isKittyProtocolActive()).toBe(true);
    setKittyProtocolActive(false);
    expect(isKittyProtocolActive()).toBe(false);
  });
});
