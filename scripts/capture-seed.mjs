import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Element, Text } from "domhandler";
import { parseDocument } from "htmlparser2";

const argument = (name) => {
  const index = process.argv.lastIndexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const integerArgument = (name, fallback) => {
  const value = Number(argument(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
};

const sourceKey = "hn_best_comments";
const minId = integerArgument("--min-id", 32_847);
const maxId = integerArgument("--max-id", 32_946);
const messageCount = maxId - minId + 1;
if (messageCount < 90 || messageCount > 150) {
  throw new TypeError("Capture window must contain 90 to 150 messages");
}
const outputDirectory = path.resolve(
  argument("--output-dir") ?? "tests/fixtures/seed",
);
await mkdir(outputDirectory, { recursive: true });
const outputPaths = [
  path.join(outputDirectory, `window-${minId}-${maxId}.json`),
  path.join(outputDirectory, "hn-items.json"),
  path.join(outputDirectory, "manifest.json"),
];
for (const outputPath of outputPaths) {
  try {
    await access(outputPath);
  } catch {
    continue;
  }
  throw new Error(`Refusing to overwrite existing capture file: ${outputPath}`);
}
const retryCount = 3;
const capturedAt = new Date().toISOString();

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const fetchText = async (url) => {
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.ok) {
        return await response.text();
      }
      if (attempt >= retryCount || response.status < 500) {
        throw new Error(`Capture request failed with HTTP ${response.status}`);
      }
    } catch (error) {
      if (attempt >= retryCount) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
    await sleep(250 * 2 ** attempt);
  }
};

const hasClass = (element, className) =>
  (element.attribs.class ?? "").split(/\s+/u).includes(className);

const findElement = (nodes, predicate) => {
  for (const node of nodes) {
    if (node instanceof Element) {
      if (predicate(node)) {
        return node;
      }
      const nested = findElement(node.children, predicate);
      if (nested !== null) {
        return nested;
      }
    }
  }
  return null;
};

const captureMessageText = (node, state) => {
  if (node instanceof Text) {
    state.text += node.data.replaceAll("\u00a0", " ");
    return;
  }
  if (!(node instanceof Element)) {
    return;
  }
  if (node.name === "br") {
    state.text += "\n";
    return;
  }
  if (node.name === "a") {
    const offset = state.text.length;
    for (const child of node.children) {
      captureMessageText(child, state);
    }
    state.entities.push({
      kind: "text_link",
      offset,
      length: state.text.length - offset,
      url: node.attribs.href ?? "",
    });
    return;
  }
  for (const child of node.children) {
    captureMessageText(child, state);
  }
};

const parseTelegramEmbed = (html, messageId) => {
  const document = parseDocument(html, { decodeEntities: true });
  const message = findElement(document.children, (element) =>
    hasClass(element, "js-message_text"),
  );
  const time = findElement(
    document.children,
    (element) => element.name === "time",
  );
  if (message === null || time?.attribs.datetime === undefined) {
    throw new Error(`Public Telegram message ${messageId} is unavailable`);
  }
  const state = { text: "", entities: [] };
  for (const child of message.children) {
    captureMessageText(child, state);
  }
  const text = state.text.trim();
  return {
    id: messageId,
    date: new Date(time.attribs.datetime).toISOString(),
    editDate: null,
    text,
    contentHash: sha256(text),
    entities: state.entities,
  };
};

const mapConcurrent = async (values, concurrency, operation) => {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await operation(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
};

const messageIds = Array.from(
  { length: maxId - minId + 1 },
  (_, index) => minId + index,
);
const messages = await mapConcurrent(messageIds, 8, async (messageId) => {
  const url = `https://t.me/${sourceKey}/${messageId}?embed=1&mode=tme`;
  return parseTelegramEmbed(await fetchText(url), messageId);
});

const hnId = (rawUrl) => {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== "news.ycombinator.com" || url.pathname !== "/item") {
      return null;
    }
    const id = Number(url.searchParams.get("id"));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
};

const occurrenceReferences = messages.map((message) => {
  const ids = message.entities
    .map((entity) => hnId(entity.url))
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error(`Telegram message ${message.id} has no HN reference`);
  }
  return {
    messageId: message.id,
    displayedStoryId: ids.length > 1 ? ids[0] : null,
    selectedCommentId: ids.at(-1),
  };
});

const hnItems = new Map();
const fetchHnItem = async (id) => {
  const existing = hnItems.get(id);
  if (existing !== undefined) {
    return existing;
  }
  const pending = (async () => {
    const raw = await fetchText(
      `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
    );
    const value = JSON.parse(raw);
    if (value === null || value.id !== id) {
      throw new Error(`HN item ${id} is unavailable`);
    }
    const item = {
      id: value.id,
      ...(typeof value.type === "string" ? { type: value.type } : {}),
      ...(typeof value.parent === "number" ? { parent: value.parent } : {}),
      ...(typeof value.by === "string" ? { by: value.by } : {}),
      ...(typeof value.time === "number" ? { time: value.time } : {}),
      ...(typeof value.title === "string" ? { title: value.title } : {}),
      ...(typeof value.text === "string" ? { text: value.text } : {}),
      ...(typeof value.url === "string" ? { url: value.url } : {}),
      ...(value.deleted === true ? { deleted: true } : {}),
      ...(value.dead === true ? { dead: true } : {}),
      responseHash: sha256(raw),
    };
    return item;
  })();
  hnItems.set(id, pending);
  return pending;
};

const resolutions = await mapConcurrent(
  occurrenceReferences,
  12,
  async ({ messageId, displayedStoryId, selectedCommentId }) => {
    const ancestorIds = [];
    const visited = new Set([selectedCommentId]);
    let current = await fetchHnItem(selectedCommentId);
    if (current.type !== "comment") {
      throw new Error(`Selected HN item ${selectedCommentId} is not a comment`);
    }
    while (typeof current.parent === "number") {
      if (ancestorIds.length >= 64 || visited.has(current.parent)) {
        throw new Error(`Invalid HN parent chain for ${selectedCommentId}`);
      }
      visited.add(current.parent);
      current = await fetchHnItem(current.parent);
      ancestorIds.push(current.id);
    }
    if (current.type !== "story" && current.type !== "poll") {
      throw new Error(`Invalid HN root ${current.id}`);
    }
    return {
      messageId,
      selectedCommentId,
      displayedStoryId,
      ancestorIds,
      resolvedRootId: current.id,
    };
  },
);

const selectedIds = new Set(
  resolutions.map((value) => value.selectedCommentId),
);
const rootIds = new Set(resolutions.map((value) => value.resolvedRootId));
const displayedIds = new Set(
  resolutions
    .map((value) => value.displayedStoryId)
    .filter((id) => id !== null),
);
const mismatches = resolutions.filter(
  (value) =>
    value.displayedStoryId !== null &&
    value.displayedStoryId !== value.resolvedRootId,
);
const selectedCounts = new Map();
for (const resolution of resolutions) {
  selectedCounts.set(
    resolution.selectedCommentId,
    (selectedCounts.get(resolution.selectedCommentId) ?? 0) + 1,
  );
}
const multipartSelectedIds = [...selectedCounts.entries()]
  .filter(([, count]) => count > 1)
  .map(([id]) => id)
  .sort((left, right) => left - right);
const resolvedItems = await Promise.all([...hnItems.values()]);
resolvedItems.sort((left, right) => left.id - right.id);

const telegramFixture = {
  schemaVersion: 1,
  source: "TELEGRAM_PUBLIC_EMBED",
  sourceKey,
  minId,
  maxId,
  messages,
};
const hnFixture = {
  schemaVersion: 1,
  source: "OFFICIAL_HN_API",
  capturedAt,
  items: resolvedItems,
  resolutions,
};
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
const telegramJson = serialize(telegramFixture);
const hnJson = serialize(hnFixture);
const counts = {
  telegramOccurrences: messages.length,
  uniqueSelectedComments: selectedIds.size,
  currentRoots: rootIds.size,
  displayedStoryReferences: displayedIds.size,
  displayedRootMismatches: mismatches.length,
  multipartGroups: multipartSelectedIds.length,
  multipartParts:
    resolutions.length - selectedIds.size + multipartSelectedIds.length,
  uniqueHnItems: resolvedItems.length,
  siblingRequests: 0,
};
const manifest = {
  schemaVersion: 1,
  approvalStatus: "PENDING_OWNER_APPROVAL",
  telegramSha256: sha256(telegramJson),
  hnSha256: sha256(hnJson),
  multipartSelectedIds,
  counts,
};

await Promise.all([
  writeFile(outputPaths[0], telegramJson, { flag: "wx" }),
  writeFile(outputPaths[1], hnJson, { flag: "wx" }),
  writeFile(outputPaths[2], serialize(manifest), { flag: "wx" }),
]);

console.log(JSON.stringify(manifest, null, 2));
