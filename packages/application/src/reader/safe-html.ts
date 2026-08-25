import { URL } from "node:url";

import { Element, isTag, Text, type ChildNode } from "domhandler";
import { parseDocument } from "htmlparser2";

const CONTAINER_TAGS = new Set([
  "blockquote",
  "code",
  "em",
  "p",
  "pre",
  "strong",
]);
const STRIP_CONTENT_TAGS = new Set(["script", "style"]);

const escapeText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const escapeAttribute = (value: string): string =>
  escapeText(value).replaceAll('"', "&quot;");

const safeUrl = (value: string): string | null => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.username = "";
    parsed.password = "";
    return parsed.href;
  } catch {
    return null;
  }
};

const renderNodes = (nodes: readonly ChildNode[]): string =>
  nodes.map(renderNode).join("");

const renderNode = (node: ChildNode): string => {
  if (node instanceof Text) {
    return escapeText(node.data);
  }
  if (
    node instanceof Element &&
    STRIP_CONTENT_TAGS.has(node.name.toLowerCase())
  ) {
    return "";
  }
  if (!isTag(node)) {
    return "";
  }
  const name = node.name.toLowerCase();
  const content = renderNodes(node.children);
  if (name === "br") {
    return "<br>";
  }
  if (name === "a") {
    const href = safeUrl(node.attribs["href"] ?? "");
    return href === null
      ? content
      : `<a href="${escapeAttribute(href)}" rel="noopener noreferrer nofollow">${content}</a>`;
  }
  const canonical = name === "b" ? "strong" : name === "i" ? "em" : name;
  return CONTAINER_TAGS.has(canonical)
    ? `<${canonical}>${content}</${canonical}>`
    : content;
};

export const renderReaderSafeHtml = (canonicalHtml: string): string => {
  const document = parseDocument(canonicalHtml, {
    decodeEntities: true,
    lowerCaseAttributeNames: true,
    lowerCaseTags: true,
  });
  return renderNodes(document.children);
};

export const redactReaderUrl = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }
  const safe = safeUrl(value);
  if (safe === null) {
    return null;
  }
  const parsed = new URL(safe);
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
};
