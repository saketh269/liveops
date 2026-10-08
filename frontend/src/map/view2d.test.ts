import { FOLLOW_SCALE_2D, SCALE_2D, clampView2D, follow2D, initialView2D, outerPoint, pan2D, rotate2D, rotationOf, viewBoxOf, zoom2DAt } from "./view2d";

const box = { x: -2, y: -2, w: 104, h: 54 };

describe("2D view", () => {
  test("starts framing the whole floor", () => {
    expect(viewBoxOf(initialView2D(box), box)).toBe("-2 -2 104 54");
    expect(rotationOf(initialView2D(box), box)).toBe("rotate(0.000 50 25)");
  });

  test("zoom towards the pointer keeps that point in place", () => {
    const v = zoom2DAt(initialView2D(box), box, 2, 80, 10);
    expect(v.scale).toBe(2);
    // The point (80, 10) is at the same fraction of the viewBox before and after.
    const [x, y, w, h] = viewBoxOf(v, box).split(" ").map(Number);
    expect((80 - x) / w).toBeCloseTo((80 + 2) / 104);
    expect((10 - y) / h).toBeCloseTo((10 + 2) / 54);
  });

  test("zoom and pan are clamped", () => {
    expect(zoom2DAt(initialView2D(box), box, 100, null, null).scale).toBe(SCALE_2D.max);
    expect(zoom2DAt(initialView2D(box), box, 0.001, null, null).scale).toBe(SCALE_2D.min);
    const far = pan2D(initialView2D(box), box, 1000, -1000);
    expect(far.cx).toBe(box.x - box.w * 0.25);
    expect(far.cy).toBe(box.y + box.h * 1.25);
    expect(clampView2D({ cx: Number.NaN, cy: 0, scale: Number.NaN, rot: Number.NaN }, box)).toEqual({ cx: 50, cy: 0, scale: 1, rot: 0 });
  });

  test("dragging moves the content with the pointer", () => {
    const v = pan2D(initialView2D(box), box, 10, -4);
    expect(v.cx).toBe(40);
    expect(v.cy).toBe(29);
  });

  test("rotating keeps the point at the centre of the view in place", () => {
    const v0 = { ...pan2D(initialView2D(box), box, -20, 5), scale: 2 };
    const v1 = rotate2D(v0, box, Math.PI / 2);
    expect(v1.rot).toBeCloseTo(Math.PI / 2);
    // The content point under the centre: undo the content rotation (about the box centre).
    const under = (v: typeof v0) => {
      const c = Math.cos(-v.rot), s = Math.sin(-v.rot), dx = v.cx - 50, dy = v.cy - 25;
      return [50 + dx * c - dy * s, 25 + dx * s + dy * c];
    };
    expect(under(v1)[0]).toBeCloseTo(under(v0)[0]);
    expect(under(v1)[1]).toBeCloseTo(under(v0)[1]);
  });

  test("following glides onto the figure and zooms in, also when the map is turned", () => {
    for (const rot of [0, Math.PI / 3]) {
      let v = initialView2D(box, rot);
      for (let i = 0; i < 60; i++) v = follow2D(v, box, 80, 10);
      const p = outerPoint(v, box, 80, 10);
      expect(v.cx).toBeCloseTo(p.x, 2);
      expect(v.cy).toBeCloseTo(p.y, 2);
      expect(v.scale).toBeCloseTo(FOLLOW_SCALE_2D, 2);
    }
    // one frame moves only part of the way (a glide, not a jump), and never zooms out
    const one = follow2D({ ...initialView2D(box), scale: 4 }, box, 80, 10);
    expect(one.cx).toBeGreaterThan(50);
    expect(one.cx).toBeLessThan(80);
    expect(one.scale).toBe(4);
  });
});
