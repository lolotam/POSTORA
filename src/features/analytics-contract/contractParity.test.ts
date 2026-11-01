import { describe, expect, it } from "vitest";
import * as browser from "./index";
import {
  assertAnalyticsArtifactParity, edgeAnalyticsRuntime, serializedAnalyticsArtifact,
} from "../../../supabase/functions/_shared/analyticsContractTestSupport.ts";

describe("canonical browser/Edge analytics contract", () => {
  it("compares the complete serialized schema, registry, calendar, delta, freshness and response fixtures", () => {
    expect(() => assertAnalyticsArtifactParity(serializedAnalyticsArtifact(browser), serializedAnalyticsArtifact(edgeAnalyticsRuntime))).not.toThrow();
  });

  it("rejects isolated-copy metadata and behavior mutations beyond keys and status names", () => {
    const expected = serializedAnalyticsArtifact(edgeAnalyticsRuntime);
    const metadataCopy = JSON.parse(expected);
    metadataCopy.registry[0].minimumPermission = "mutated-permission";
    expect(() => assertAnalyticsArtifactParity(JSON.stringify(metadataCopy), expected)).toThrow("parity failed");
    const calendarCopy = JSON.parse(expected);
    calendarCopy.calendar[0].current.buckets[0].until = "2026-03-03T08:00:00.001Z";
    expect(() => assertAnalyticsArtifactParity(JSON.stringify(calendarCopy), expected)).toThrow("parity failed");
  });
});
