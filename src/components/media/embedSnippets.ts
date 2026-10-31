// Share / Embed snippets per stored kind. Only images and videos embed as media;
// audio gets an <audio> player and every other file is a plain download link.

export interface EmbedSnippets {
  html: string;
  markdown: string;
  bbCode: string;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\[\]]/g, "\\$&");
}

export function embedSnippets(fileType: string, url: string, name: string): EmbedSnippets {
  const safeUrl = escapeHtml(url);
  const safeName = escapeHtml(name);
  const label = escapeMarkdownLabel(name);
  if (fileType === "image") {
    return { html: `<img src="${safeUrl}" alt="${safeName}" />`, markdown: `![${label}](${url})`, bbCode: `[img]${url}[/img]` };
  }
  if (fileType === "video") {
    return { html: `<video src="${safeUrl}" controls></video>`, markdown: `[${label}](${url})`, bbCode: `[video]${url}[/video]` };
  }
  if (fileType === "audio") {
    return { html: `<audio src="${safeUrl}" controls></audio>`, markdown: `[${label}](${url})`, bbCode: `[url=${url}]${name}[/url]` };
  }
  return { html: `<a href="${safeUrl}" download>${safeName}</a>`, markdown: `[${label}](${url})`, bbCode: `[url=${url}]${name}[/url]` };
}
