import { describe, expect, it } from "vitest";
import { formatCompactNdjson } from "../src/io.js";

function parseLines(text: string): Array<Record<string, unknown>> {
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("compact-ndjson output", () => {
  it("emits a meta line followed by schema-aligned rows for records", () => {
    const lines = parseLines(
      formatCompactNdjson([
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta", rank: 2 }
      ])
    );
    expect(lines[0]).toMatchObject({ type: "meta", schema: ["id", "name", "rank"], count: 2 });
    expect(lines.slice(1)).toEqual([
      { type: "row", key: "a", v: ["a", "Alpha", null] },
      { type: "row", key: "b", v: ["b", "Beta", 2] }
    ]);
  });

  it("unwraps common pagination containers and preserves count/cursor", () => {
    const lines = parseLines(
      formatCompactNdjson({ rows: [{ code: "PURCHASE" }], total: 7, nextCursor: "cursor-2" })
    );
    expect(lines[0]).toMatchObject({ type: "meta", schema: ["code"], count: 1, cursor: "cursor-2" });
    expect(lines[1]).toEqual({ type: "row", key: "PURCHASE", v: ["PURCHASE"] });
  });

  it("prefers a business code over a technical id for row keys", () => {
    const lines = parseLines(formatCompactNdjson([
      { id: "technical-id", code: "BUSINESS-CODE", name: "Example" }
    ]));
    expect(lines[1]).toMatchObject({ type: "row", key: "BUSINESS-CODE" });
  });

  it("prefers the serial-number composite identity over an id", () => {
    const lines = parseLines(formatCompactNdjson([
      { id: "technical-id", entityClassName: "com.example.Order", tenantCode: "global" }
    ]));
    expect(lines[1]).toMatchObject({ type: "row", key: "com.example.Order|global" });
  });

  it("unwraps a successful data envelope without treating the envelope as a row", () => {
    expect(parseLines(formatCompactNdjson({ success: true, data: [{ id: "a", value: 1 }] })))
      .toEqual([
        { type: "meta", schema: ["id", "value"], count: 1 },
        { type: "row", key: "a", v: ["a", 1] }
      ]);
  });

  it("uses a stable scalar fallback for non-table values and empty arrays", () => {
    expect(parseLines(formatCompactNdjson("ok"))).toEqual([
      { type: "meta", schema: ["value"], count: 1 },
      { type: "row", v: ["ok"] }
    ]);
    expect(parseLines(formatCompactNdjson([]))).toEqual([{ type: "meta", schema: [], count: 0 }]);
  });

  it("does not encode an EADP failure envelope as a successful row", () => {
    expect(() => formatCompactNdjson({ success: false, message: "denied" }))
      .toThrow("EADP 请求失败：denied");
  });
});
