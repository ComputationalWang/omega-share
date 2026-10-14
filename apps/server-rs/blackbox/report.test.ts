import { describe, expect, test } from "bun:test";
import { evaluate, parseJunit, type TestResult } from "./report";

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="5">
  <testsuite name="a.test.ts" file="apps/server/test/a.test.ts">
    <testsuite name="outer" file="apps/server/test/a.test.ts" line="3">
      <testcase name="passes" classname="outer" time="0.01" file="apps/server/test/a.test.ts" line="4" assertions="1" />
      <testcase name="it&apos;s &lt;odd&gt; &amp; &quot;quoted&quot;" classname="outer" time="0.01" file="apps/server/test/a.test.ts" line="5">
        <failure type="AssertionError" message="expected 1"/>
      </testcase>
      <testcase name="needs the in-process server" classname="outer" time="0.01" file="apps/server/test/a.test.ts" line="6">
        <failure type="NotBlackBox" message="NotBlackBox: registry: not expressible as an environment variable"/>
      </testcase>
      <testcase name="skipped" classname="outer" time="0" file="apps/server/test/a.test.ts" line="7">
        <skipped />
      </testcase>
    </testsuite>
    <testcase name="top level" classname="a.test.ts" time="0" file="apps/server/test/a.test.ts" line="9" />
  </testsuite>
</testsuites>`;

describe("parseJunit", () => {
  test("ids, files and statuses, with entities unescaped", () => {
    expect(parseJunit(xml)).toEqual([
      { id: "apps/server/test/a.test.ts::outer::passes", file: "apps/server/test/a.test.ts", status: "pass" },
      {
        id: `apps/server/test/a.test.ts::outer::it's <odd> & "quoted"`,
        file: "apps/server/test/a.test.ts",
        status: "fail",
      },
      {
        id: "apps/server/test/a.test.ts::outer::needs the in-process server",
        file: "apps/server/test/a.test.ts",
        status: "not-black-box",
      },
      { id: "apps/server/test/a.test.ts::outer::skipped", file: "apps/server/test/a.test.ts", status: "skip" },
      { id: "apps/server/test/a.test.ts::a.test.ts::top level", file: "apps/server/test/a.test.ts", status: "pass" },
    ]);
  });

  test("no testcases is an empty list", () => {
    expect(parseJunit('<testsuites name="bun test" tests="0"></testsuites>')).toEqual([]);
  });
});

const r = (id: string, status: TestResult["status"], file = "f.test.ts"): TestResult => ({ id, file, status });

describe("evaluate", () => {
  const results = [
    r("a", "pass"),
    r("b", "fail"),
    r("c", "not-black-box"),
    r("d", "pass"),
    r("u", "pass", "unit.test.ts"),
  ];
  const usesServer = (file: string): boolean => file !== "unit.test.ts";

  test("a listed test that no longer passes is a regression; a listed test that vanished too", () => {
    expect(evaluate(results, ["a", "b", "gone"], usesServer).regressions).toEqual(["b", "gone"]);
  });

  test("a listed not-black-box test is a regression", () => {
    expect(evaluate(results, ["c"], usesServer).regressions).toEqual(["c"]);
  });

  test("passing tests that touch a server and aren't listed are reported; pure units are not", () => {
    expect(evaluate(results, ["a"], usesServer).unlisted).toEqual(["d"]);
  });

  test("counts by status", () => {
    expect(evaluate(results, [], usesServer).counts).toEqual({ pass: 3, fail: 1, "not-black-box": 1, skip: 0 });
  });

  test("everything listed passes: no regressions", () => {
    expect(evaluate(results, ["a", "d"], usesServer).regressions).toEqual([]);
  });
});
