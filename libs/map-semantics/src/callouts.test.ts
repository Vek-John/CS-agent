import { describe, expect, it } from "vitest";
import {
  MIRAGE_CALLOUTS,
  mirageChineseCallout,
  resolveMirageCalloutAlias,
  resolveMirageEnginePlaceName
} from "./callouts";

describe("Mirage engine callout vocabulary", () => {
  it("keeps all observed engine tokens and stable IDs unique", () => {
    expect(MIRAGE_CALLOUTS).toHaveLength(23);
    expect(new Set(MIRAGE_CALLOUTS.map((item) => item.id)).size).toBe(23);
    expect(new Set(MIRAGE_CALLOUTS.map((item) => item.engine_place_name)).size).toBe(23);
  });

  it.each([
    ["SnipersNest", "VIP"],
    ["Catwalk", "B小"],
    ["TRamp", "A大"],
    ["PalaceInterior", "A宫"],
    ["Shop", "超市"],
    ["TopofMid", "中远（匪口）"]
  ])("maps the exact engine token %s to %s", (token, expected) => {
    expect(mirageChineseCallout(token)).toBe(expected);
    expect(resolveMirageEnginePlaceName(token)).toMatchObject({
      status: "EXACT",
      source: "ENGINE_PLACE_NAME"
    });
  });

  it("normalizes only explicit aliases", () => {
    expect(resolveMirageCalloutAlias(" B  APPS ")).toMatchObject({
      status: "EXACT",
      callout: { id: "MIRAGE_APARTMENTS", zh_cn: "B二楼" }
    });
    expect(resolveMirageCalloutAlias("梯子间")).toMatchObject({
      status: "EXACT",
      callout: { id: "MIRAGE_LADDER", zh_cn: "狗洞" }
    });
    expect(resolveMirageCalloutAlias("大概在 A1 附近")).toEqual({
      status: "UNKNOWN",
      raw: "大概在 A1 附近"
    });
  });

  it("returns unknown instead of inventing a callout", () => {
    expect(resolveMirageEnginePlaceName(undefined)).toEqual({ status: "UNKNOWN" });
    expect(resolveMirageEnginePlaceName("NotAValvePlace")).toEqual({
      status: "UNKNOWN",
      raw: "NotAValvePlace"
    });
  });
});
