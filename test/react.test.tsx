// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { caffeine } from "../src/index.js";
import { useCachedValue } from "../src/react/index.js";

function View({ cache, keyName }: { cache: ReturnType<typeof makeCache>; keyName: string }) {
  const { data, isLoading, error } = useCachedValue(cache, keyName);
  if (error) return <div>error: {String(error)}</div>;
  if (isLoading) return <div>loading</div>;
  return <div>data: {data}</div>;
}

function makeCache(loader: (k: string) => Promise<string>) {
  return caffeine<string, string>({ maximumSize: 100 }).recordStats().buildAsync(loader);
}

describe("useCachedValue", () => {
  it("shows loading then resolves the value", async () => {
    const cache = makeCache(async (k) => `val-${k}`);
    render(<View cache={cache} keyName="a" />);
    expect(screen.getByText("loading")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("data: val-a")).toBeTruthy());
    cleanup();
  });

  it("coalesces concurrent components onto one loader call", async () => {
    const loader = vi.fn(async (k: string) => `v-${k}`);
    const cache = makeCache(loader);
    render(
      <>
        <View cache={cache} keyName="x" />
        <View cache={cache} keyName="x" />
        <View cache={cache} keyName="x" />
      </>,
    );
    await waitFor(() => expect(screen.getAllByText("data: v-x").length).toBe(3));
    expect(loader).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("surfaces loader errors", async () => {
    const cache = makeCache(async () => {
      throw new Error("boom");
    });
    render(<View cache={cache} keyName="e" />);
    await waitFor(() => expect(screen.getByText(/error: Error: boom/)).toBeTruthy());
    cleanup();
  });

  it("does not update state after unmount", async () => {
    let resolve!: (v: string) => void;
    const cache = makeCache(() => new Promise<string>((r) => (resolve = r)));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(<View cache={cache} keyName="u" />);
    unmount();
    await act(async () => {
      resolve("late");
      await Promise.resolve();
    });
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("unmounted"))).toBe(false);
    errSpy.mockRestore();
  });
});
