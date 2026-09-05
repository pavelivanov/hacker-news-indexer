import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  parseManualDraftPayload,
  type ManualSaveV1,
} from "@hn-knowledge/contracts";
import { ApiError } from "../lib/api";
import { baseApi, detail, saved } from "../test/fixture";
import { ReviewEditor } from "./review-editor";

const setup = (
  overrides: Partial<ReturnType<typeof baseApi>> = {},
  source = detail,
) => {
  const api = {
    ...baseApi(),
    comment: vi.fn().mockResolvedValue(source),
    ...overrides,
  };
  const published = vi.fn();
  render(
    <ReviewEditor
      id={900001}
      api={api}
      onState={vi.fn()}
      onPublished={published}
      onBack={vi.fn()}
    />,
  );
  return { api, published };
};
describe("browser draft controls", () => {
  it("requires saving form defaults for an API-created partial draft before approval", async () => {
    const partial = {
      ...saved,
      payload: parseManualDraftPayload(
        JSON.parse(
          JSON.stringify({
            ...saved.payload,
            review: undefined,
            expert_note: {
              ...saved.payload.expert_note,
              qualifiers: undefined,
            },
          }),
        ),
      ),
    };
    const save = vi
      .fn()
      .mockImplementation((_id: string, request: ManualSaveV1) =>
        Promise.resolve({
          draft: { ...saved, version: 3, payload: request.payload },
        }),
      );
    setup({ save }, { ...detail, draft: partial });
    await screen.findByLabelText("Note title *");
    fireEvent.change(screen.getByLabelText("Approval or rejection reason *"), {
      target: { value: "Checked the source" },
    });
    expect(
      screen.getByRole("button", { name: "Approve saved draft" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Approve saved draft" }),
      ).toBeEnabled(),
    );
  });
  it("saves incomplete writing and keeps approval unavailable", async () => {
    const save = vi
      .fn()
      .mockImplementation((_id: string, request: ManualSaveV1) =>
        Promise.resolve({
          draft: { ...saved, version: 3, payload: request.payload },
        }),
      );
    setup(
      { save },
      {
        ...detail,
        draft: {
          ...saved,
          payload: {
            primary_decision: "EXPERT_NOTE",
            expert_note: { title: "" },
          },
        },
      },
    );
    fireEvent.change(await screen.findByLabelText("Note title *"), {
      target: { value: "Partial writing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved. You can return to it later.");
    const request = save.mock.calls[0]?.[1] as ManualSaveV1;
    expect(request.expected_version).toBe(2);
    expect(request.payload.expert_note?.title).toBe("Partial writing");
    expect(
      screen.getByRole("button", { name: "Approve saved draft" }),
    ).toBeDisabled();
  });
  it("preserves edits after a version conflict", async () => {
    setup({
      save: vi.fn().mockRejectedValue(new ApiError(409, "version_conflict")),
    });
    fireEvent.change(await screen.findByLabelText("Note title *"), {
      target: { value: "My writing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText(/A newer draft was saved elsewhere/);
    expect(screen.getByLabelText("Note title *")).toHaveValue("My writing");
    expect(
      screen.getByRole("button", { name: "Compare saved version" }),
    ).toBeEnabled();
  });
  it("shows final validation failures without reporting publication", async () => {
    const { published } = setup({
      finalize: vi
        .fn()
        .mockRejectedValue(
          new ApiError(422, "output_invalid", "SUBJECT_NAME_UNSUPPORTED"),
        ),
    });
    await screen.findByLabelText("Note title *");
    fireEvent.change(screen.getByLabelText("Approval or rejection reason *"), {
      target: { value: "Checked the source" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Approve saved draft" }),
    );
    await screen.findByText(/Use a discovery name that appears/);
    expect(published).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Note title *")).toHaveValue(
      "WidgetDB writes",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled(),
    );
  });
  it("renders source markup as text", async () => {
    const source = structuredClone(detail);
    if (!source.source) throw new Error("Fixture missing source");
    const malicious = {
      ...source.source.documents[0],
      spans: [
        {
          ...source.source.documents[0].spans[0],
          text: '<img src=x onerror="alert(1)">WidgetDB',
        },
      ],
    };
    setup(
      {},
      { ...source, source: { ...source.source, documents: [malicious] } },
    );
    await screen.findByText('<img src=x onerror="alert(1)">WidgetDB');
    expect(document.querySelector("img")).toBeNull();
  });
});
