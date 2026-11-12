import { describe, expect, test } from "bun:test";
import { PRECEDENCE, build, focused, route, seeds, skillBody, userText, wantsGraph } from "./prompt-router";

describe("route", () => {
  const kind = (p: string) => route(p)?.kind ?? null;
  test.each([
    ["The payroll total is wrong and the test fails", "bug"],
    ["why does the timesheet lock twice?", "bug"],
    ["Refactor the compliance service into two modules", "refactor"],
    ["Add a leave balance endpoint", "build"],
    ["implement step S5", "build"],
    ["review the diff before I merge", "review"],
    ["look at PR #42", "review"],
    ["audit the web app for bloat", "audit"],
    ["write a commit message for this", "commit"],
    ["run the gates and confirm it is green", "verify"],
  ])("%s → %s", (p, k) => expect(kind(p)).toBe(k));

  test("prose and general questions get no route", () => {
    expect(kind("Summarise the UAE WPS rules in two lines")).toBeNull();
    expect(kind("thanks, looks good")).toBeNull();
  });
});

describe("wantsGraph", () => {
  test("code intents always query the graph", () => expect(wantsGraph("tidy this", "refactor")).toBe(true));
  test("explore questions and identifiers query it", () => {
    expect(wantsGraph("who calls the eligibility check?", undefined)).toBe(true);
    expect(wantsGraph("what is checkEligibility for", undefined)).toBe(true);
    expect(wantsGraph("open apps/api/src/main.ts", undefined)).toBe(true);
    expect(wantsGraph("what does `latestByType` return", undefined)).toBe(true);
  });
  test("plain prose does not", () => expect(wantsGraph("Summarise the WPS rules", undefined)).toBe(false));
});

describe("userText", () => {
  test("drops harness blocks attached to the prompt", () => {
    expect(userText("<browser_instruction>\nreview or share the GIF\n</browser_instruction>Proceed and do not compromise.")).toBe("Proceed and do not compromise.");
    expect(userText('<system-reminder a="1">fix bug</system-reminder>\nthanks')).toBe("thanks");
  });
  test("keeps the user's own text, including a lone angle bracket", () => expect(userText("is a < b in checkEligibility?")).toBe("is a < b in checkEligibility?"));
});

test("seeds are the code names in the prompt, at most three", () => {
  expect(seeds("why does checkEligibility fail in `latestByType` for apps/api/src/main.ts and worker_code_seq or rankCandidates")).toEqual(["checkEligibility", "latestByType", "apps/api/src/main.ts"]);
  expect(seeds("refactor the roster page")).toEqual([]);
  expect(seeds("what does `a b` mean")).toEqual([]);
});

describe("focused", () => {
  test("a slice from a few seeds is kept; a keyword spray is dropped", () => {
    expect(focused("Graph: x | Start: ['checkEligibility()'] | 73 nodes found\nNODE a")).toBe(true);
    expect(focused("Graph: x | Start: ['a'] | 1014 nodes found\nNODE a")).toBe(false);
    expect(focused("no header\nNODE a")).toBe(false);
  });
});

describe("build", () => {
  test("harness text alone triggers nothing", () => {
    expect(build("<browser_instruction>review the diff, fix the bug</browser_instruction>Proceed and do not compromise.", "/no/graph/here")).toBe("");
  });
  test("slash commands and empty prompts pass untouched", () => {
    expect(build("/review", ".")).toBe("");
    expect(build("   ", ".")).toBe("");
  });
  test("a code route carries the precedence line; prose gets nothing", () => {
    expect(build("Refactor the roster page", "/no/graph/here")).toContain(PRECEDENCE);
    expect(build("Summarise the WPS rules", "/no/graph/here")).toBe("");
  });
});

test("skillBody drops frontmatter, title and blank lines", () => {
  expect(skillBody("---\nname: x\ndescription: y\n---\n\n# Title\n\nline one\n\n- two\n")).toBe("line one\n- two");
});
