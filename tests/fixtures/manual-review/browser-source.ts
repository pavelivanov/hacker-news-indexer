export const browserSource = {
  commentId: 900001,
  rootId: 900000,
  title: "WidgetDB internals",
  rootHtml: "<p>WidgetDB uses a write-ahead log.</p>",
  url: "https://widgetdb.example/",
  commentHtml:
    "<p>WidgetDB batches writes to reduce disk synchronization. This helps throughput when small writes arrive together.</p><p>The tradeoff is a short delay before each batch is persisted.</p>",
} as const;
