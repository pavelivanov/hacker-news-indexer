import { URL } from "node:url";

import type {
  CanonicalContentBlock,
  NormalizedHnContent,
  UrlCandidate,
} from "@hn-knowledge/domain";
import type { Hasher } from "@hn-knowledge/ports";
import { Element, Text, type ChildNode } from "domhandler";
import { parseDocument } from "htmlparser2";

const HN_HOSTS = new Set(["news.ycombinator.com", "www.news.ycombinator.com"]);
const STRIP_CONTENT_TAGS = new Set(["script", "style"]);

export const normalizePlainText = (value: string): string =>
  value
    .replaceAll("\u00a0", " ")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

const escapeText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const escapeAttribute = (value: string): string =>
  escapeText(value).replaceAll('"', "&quot;");

interface CanonicalUrl {
  readonly canonicalUrl: string | null;
  readonly scheme: string | null;
  readonly host: string | null;
  readonly valid: boolean;
}

const canonicalUrl = (rawUrl: string): CanonicalUrl => {
  try {
    const parsed = new URL(rawUrl, "https://news.ycombinator.com/");
    const scheme = parsed.protocol.replace(/:$/u, "").toLowerCase();
    const host = parsed.hostname.toLowerCase();
    if (scheme !== "http" && scheme !== "https") {
      return { canonicalUrl: null, scheme, host, valid: false };
    }
    if (HN_HOSTS.has(host) && parsed.pathname === "/item") {
      const id = Number(parsed.searchParams.get("id"));
      if (Number.isSafeInteger(id) && id > 0) {
        return {
          canonicalUrl: `https://news.ycombinator.com/item?id=${id}`,
          scheme: "https",
          host: "news.ycombinator.com",
          valid: true,
        };
      }
    }
    if (/^[./]/u.test(rawUrl) || /^item\?/iu.test(rawUrl)) {
      return { canonicalUrl: null, scheme, host, valid: false };
    }
    parsed.protocol = `${scheme}:`;
    parsed.hostname = host;
    return { canonicalUrl: parsed.href, scheme, host, valid: true };
  } catch {
    return { canonicalUrl: null, scheme: null, host: null, valid: false };
  }
};

const childrenHtml = (
  children: readonly ChildNode[],
  candidates: UrlCandidate[],
  sourceDocument: string,
  hasher: Hasher,
): string =>
  children
    .map((child) => sanitizeNode(child, candidates, sourceDocument, hasher))
    .join("");

const sanitizeNode = (
  node: ChildNode,
  candidates: UrlCandidate[],
  sourceDocument: string,
  hasher: Hasher,
): string => {
  if (node instanceof Text) {
    return escapeText(node.data);
  }
  if (!(node instanceof Element)) {
    return "";
  }

  const name = node.name.toLowerCase();
  if (STRIP_CONTENT_TAGS.has(name)) {
    return "";
  }
  const content = childrenHtml(
    node.children,
    candidates,
    sourceDocument,
    hasher,
  );
  if (name === "br") {
    return "<br>";
  }
  if (name === "a") {
    const rawUrl = node.attribs["href"] ?? "";
    const normalized = canonicalUrl(rawUrl);
    candidates.push({
      rawUrl,
      canonicalUrl: normalized.canonicalUrl,
      sourceDocument,
      originField: "href",
      scheme: normalized.scheme,
      host: normalized.host,
      validationState: normalized.valid ? "VALID" : "REJECTED",
      contentHash: hasher.sha256(`${sourceDocument}\u0000href\u0000${rawUrl}`),
    });
    return normalized.canonicalUrl === null
      ? content
      : `<a href="${escapeAttribute(normalized.canonicalUrl)}">${content}</a>`;
  }

  const canonicalName = name === "b" ? "strong" : name === "i" ? "em" : name;
  if (
    !["p", "pre", "code", "blockquote", "em", "strong"].includes(canonicalName)
  ) {
    return content;
  }
  return `<${canonicalName}>${content}</${canonicalName}>`;
};

const textOf = (node: ChildNode): string => {
  if (node instanceof Text) {
    return node.data;
  }
  if (!(node instanceof Element) || STRIP_CONTENT_TAGS.has(node.name)) {
    return "";
  }
  if (node.name === "br") {
    return "\n";
  }
  const content = node.children.map(textOf).join("");
  return ["p", "pre", "blockquote"].includes(node.name)
    ? `\n\n${content}\n\n`
    : content;
};

const blockText = (node: Element): string =>
  normalizePlainText(node.children.map(textOf).join(""));

const collectBlocks = (
  nodes: readonly ChildNode[],
  blocks: CanonicalContentBlock[],
): void => {
  let inlineText = "";
  const flushInline = (): void => {
    const text = normalizePlainText(inlineText);
    if (text.length > 0) {
      blocks.push({ kind: "TEXT", text });
    }
    inlineText = "";
  };

  for (const node of nodes) {
    if (node instanceof Text) {
      inlineText += node.data;
      continue;
    }
    if (!(node instanceof Element) || STRIP_CONTENT_TAGS.has(node.name)) {
      continue;
    }
    if (node.name === "pre") {
      flushInline();
      const text = blockText(node);
      if (text.length > 0) {
        blocks.push({ kind: "CODE", text });
      }
      continue;
    }
    if (node.name === "p" || node.name === "blockquote") {
      flushInline();
      const text = blockText(node);
      if (text.length > 0) {
        blocks.push({ kind: "TEXT", text });
      }
      continue;
    }
    inlineText += textOf(node);
  }
  flushInline();
};

export const normalizeHnCommentHtml = (
  html: string,
  sourceDocument: string,
  hasher: Hasher,
): NormalizedHnContent => {
  const document = parseDocument(html, {
    decodeEntities: true,
    lowerCaseAttributeNames: true,
    lowerCaseTags: true,
  });
  const candidates: UrlCandidate[] = [];
  const canonicalHtml = childrenHtml(
    document.children,
    candidates,
    sourceDocument,
    hasher,
  );
  const canonicalText = normalizePlainText(
    document.children.map(textOf).join(""),
  );
  const blocks: CanonicalContentBlock[] = [];
  collectBlocks(document.children, blocks);
  if (blocks.length === 0 && canonicalText.length > 0) {
    blocks.push({ kind: "TEXT", text: canonicalText });
  }

  return {
    canonicalHtml,
    canonicalText,
    contentHash: hasher.sha256(canonicalHtml),
    blocks,
    urlCandidates: candidates,
  };
};
