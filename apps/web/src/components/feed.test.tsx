import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { baseApi } from "../test/fixture";
import { Feed } from "./feed";

describe("reader feed rendering", () => {
  it("explains an empty published feed", async () => {
    render(
      <Feed
        api={{
          ...baseApi(),
          feed: vi.fn().mockResolvedValue({
            items: [],
            story_clusters: [],
            next_cursor: null,
          }),
        }}
        kind="expert_note"
        commentId={null}
        onAll={vi.fn()}
      />,
    );
    await screen.findByText("Your collection starts with a review");
  });
  it("renders actual reader evidence and source links", async () => {
    render(
      <Feed
        api={{
          ...baseApi(),
          publishedComment: vi.fn().mockResolvedValue({
            items: [
              {
                id: "note-1",
                kind: "expert_note",
                title: "Batched writes",
                summary: "Fewer synchronizations",
                subjects: [],
                evidence: [
                  {
                    origin: "COMMENT",
                    excerpt: "WidgetDB batches writes.",
                    start_offset: 0,
                    end_offset: 24,
                  },
                ],
                selected_comment_id: 900001,
                published_at: "2026-09-05T00:00:00Z",
              },
            ],
          }),
        }}
        kind="expert_note"
        commentId={900001}
        onAll={vi.fn()}
      />,
    );
    await screen.findByRole("heading", { name: "Batched writes" });
    expect(screen.getByText("WidgetDB batches writes.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Read source/ })).toHaveAttribute(
      "href",
      "https://news.ycombinator.com/item?id=900001",
    );
  });
});
