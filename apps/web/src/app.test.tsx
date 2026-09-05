import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import App from "./app";
const responseFor = (path: string) =>
  new Response(
    JSON.stringify(
      path === "/v1/processing"
        ? {
            configured: false,
            enabled: false,
            online: false,
            failures: [],
            pending: 0,
            processing: 0,
            failed: 0,
            interval_seconds: 1800,
            batch_size: 20,
            requests_today: 0,
            daily_request_limit: 100,
            budget_resets_at: "2026-09-06T00:00:00Z",
            last_checked_at: null,
            last_result_at: null,
          }
        : { items: [], next_cursor: null },
    ),
  );

describe("in-memory browser authentication", () => {
  it("unlocks, clears the input and session on lock, and never uses persistent storage", async () => {
    const fetcher = vi
      .fn()
      .mockImplementation((path: string) => Promise.resolve(responseFor(path)));
    vi.stubGlobal("fetch", fetcher);
    const storage = vi.spyOn(Storage.prototype, "setItem");
    render(<App />);
    fireEvent.change(screen.getByLabelText("Local API token"), {
      target: { value: "test-only-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock workspace" }));
    await screen.findByRole("navigation", { name: "Main navigation" });
    expect(screen.queryByLabelText("Local API token")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Lock" }));
    expect(screen.getByLabelText("Local API token")).toHaveValue("");
    expect(storage).not.toHaveBeenCalled();
    expect(location.search).not.toContain("token");
  });
  it("clears rejected credentials and explains recovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 401 })),
    );
    render(<App />);
    fireEvent.change(screen.getByLabelText("Local API token"), {
      target: { value: "rejected-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock workspace" }));
    await screen.findByText("Unable to unlock");
    expect(screen.getByLabelText("Local API token")).toHaveValue("");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
  it("a server 401 locks an already-open workspace", async () => {
    const fetcher = vi
      .fn()
      .mockImplementation((path: string) => Promise.resolve(responseFor(path)));
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    fireEvent.change(screen.getByLabelText("Local API token"), {
      target: { value: "test-only-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock workspace" }));
    await screen.findByRole("button", { name: "Refresh results" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh results" }),
      ).toBeEnabled(),
    );
    fetcher.mockImplementation(() =>
      Promise.resolve(new Response("{}", { status: 401 })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh results" }));
    await screen.findByLabelText("Local API token");
    expect(screen.getByLabelText("Local API token")).toHaveValue("");
  });
});
