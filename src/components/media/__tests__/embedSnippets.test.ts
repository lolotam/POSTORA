import { describe, expect, it } from "vitest";
import { embedSnippets } from "../embedSnippets";

describe("embedSnippets", () => {
  it("embeds images and videos as media, audio as a player, and other files as links", () => {
    const url = "https://cdn.example/f";
    expect(embedSnippets("image", url, "a.png").html).toBe(`<img src="${url}" alt="a.png" />`);
    expect(embedSnippets("video", url, "v.mp4").bbCode).toBe(`[video]${url}[/video]`);
    expect(embedSnippets("audio", url, "s.mp3").html).toBe(`<audio src="${url}" controls></audio>`);
    const pdf = embedSnippets("document", url, "invoice.pdf");
    expect(pdf.html).toBe(`<a href="${url}" download>invoice.pdf</a>`);
    expect(pdf.bbCode).toBe(`[url=${url}]invoice.pdf[/url]`);
    expect(pdf.html).not.toContain("<video");
  });

  it("escapes names so a quote or tag cannot break out of the snippet", () => {
    const html = embedSnippets("image", "https://cdn.example/f", `x" onerror="alert(1)`).html;
    expect(html).toContain("&quot;");
    expect(html).not.toContain(`" onerror="`);
  });

  it("escapes square brackets in the Markdown label so the link text cannot end early", () => {
    const url = "https://cdn.example/f";
    expect(embedSnippets("image", url, "a]b[c.png").markdown).toBe(`![a\\]b\\[c.png](${url})`);
    expect(embedSnippets("document", url, "[draft].pdf").markdown).toBe(`[\\[draft\\].pdf](${url})`);
  });

  it("escapes backslashes too, so a name cannot cancel the bracket escape and inject a link", () => {
    const url = "https://cdn.example/f";
    const name = "safe\\](https://attacker.example) [x";
    expect(embedSnippets("document", url, name).markdown)
      .toBe(`[safe\\\\\\](https://attacker.example) \\[x](${url})`);
  });
});
