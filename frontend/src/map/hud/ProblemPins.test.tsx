import { act, fireEvent, render, screen } from "@testing-library/react";
import ProblemPins from "./ProblemPins";
import type { Pin } from "./pins";

const pins: Pin[] = [
  { key: "zone:wait", assetId: "P2", tone: "bad", count: 2, text: "ED Waiting Room · 2 alerts" },
  { key: "B1", assetId: "B1", tone: "warn", count: 1, text: "B1 dirty 45m" },
];

test("pins stand where the scene projects their figure, hide off screen, and select their record on click", async () => {
  const onSelect = vi.fn();
  const at: Record<string, { x: number; y: number } | null> = { P2: { x: 120, y: 80 }, B1: null };
  const { container } = render(<ProblemPins pins={pins} project={(id) => at[id] ?? null} onSelect={onSelect} />);
  vi.spyOn(container.querySelector(".lm-hud-pins")!, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 800, height: 600 } as DOMRect);
  await act(() => new Promise((r) => setTimeout(r, 50))); // a few animation frames
  const wait = screen.getByRole("button", { name: /ED Waiting Room · 2 alerts/ });
  const dirty = container.querySelector<HTMLElement>('[data-pin="B1"]')!;
  expect(wait.style.visibility).toBe("");
  expect(wait.style.transform).toContain("translate(120px, 80px)");
  expect(dirty.style.visibility).toBe("hidden"); // figure not drawn (other floor, off screen)
  fireEvent.click(wait);
  expect(onSelect).toHaveBeenCalledWith("P2");
});

test("no projector (2D view, or 3D still loading): no pins", () => {
  const { container } = render(<ProblemPins pins={pins} project={null} onSelect={() => {}} />);
  expect(container.querySelector(".lm-hud-pin")).toBeNull();
});
