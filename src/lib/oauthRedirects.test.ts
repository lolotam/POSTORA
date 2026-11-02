import { afterEach, expect, it, vi } from "vitest";
import { buildReturnUrl } from "./oauthRedirects";

afterEach(() => vi.unstubAllGlobals());

it.each(["http://127.0.0.1:8080", "https://postora.cloud", "https://preview.postora.cloud"])(
  "keeps Instagram reconnect on the application origin %s instead of forcing production",
  (origin) => {
    vi.stubGlobal("window", { location: new URL(`${origin}/profiles`) });
    const landing = new URL(buildReturnUrl("instagramBusiness", { select: "opaque+selection" }));
    expect(landing.origin).toBe(origin);
    expect(landing.pathname).toBe("/profiles");
    expect(landing.searchParams.get("connected")).toBe("instagramBusiness");
    expect(landing.searchParams.get("select")).toBe("opaque+selection");
  },
);
