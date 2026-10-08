import { act, fireEvent, render, screen } from "@testing-library/react";
import CameraControls, { bearingText, type CameraControlsHandle, type CameraControlsState } from "./CameraControls";

function fakeCamera(tilt = true) {
  let listener: ((s: CameraControlsState) => void) | null = null;
  const cam = {
    zoom: vi.fn(), rotate: vi.fn(), faceNorth: vi.fn(), reset: vi.fn(), resumeFollow: vi.fn(),
    ...(tilt ? { tilt: vi.fn() } : {}),
    onCameraChange: (fn: (s: CameraControlsState) => void) => { listener = fn; fn({ azimuth: 0, following: false, paused: false }); return () => { listener = null; }; },
  };
  return { cam: cam as CameraControlsHandle & typeof cam, emit: (s: CameraControlsState) => act(() => listener?.(s)) };
}

describe("CameraControls", () => {
  test("every button has an accessible name and drives the camera", () => {
    const { cam } = fakeCamera();
    render(<CameraControls camera={cam} follow={{ on: false, enabled: true, toggle: vi.fn() }} />);
    expect(screen.getByRole("group", { name: "Camera" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(cam.zoom).toHaveBeenCalledWith(0.8);
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(cam.zoom).toHaveBeenCalledWith(1.25);
    fireEvent.click(screen.getByRole("button", { name: "Rotate left" }));
    expect(cam.rotate).toHaveBeenLastCalledWith(-Math.PI / 8);
    fireEvent.click(screen.getByRole("button", { name: "Rotate right" }));
    expect(cam.rotate).toHaveBeenLastCalledWith(Math.PI / 8);
    fireEvent.click(screen.getByRole("button", { name: /Tilt up/ }));
    expect(cam.tilt).toHaveBeenLastCalledWith(Math.PI / 18);
    fireEvent.click(screen.getByRole("button", { name: /Tilt down/ }));
    expect(cam.tilt).toHaveBeenLastCalledWith(-Math.PI / 18);
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    expect(cam.reset).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Compass/ }));
    expect(cam.faceNorth).toHaveBeenCalled();
  });

  test("the compass shows the rotation and says it", () => {
    const { cam, emit } = fakeCamera();
    render(<CameraControls camera={cam} />);
    emit({ azimuth: Math.PI / 2, following: false, paused: false });
    expect(screen.getByRole("button", { name: "Compass: Map turned 90° clockwise. Turn to face north" })).toBeTruthy();
    expect(document.querySelector(".lm-cam-compass g")?.getAttribute("transform")).toBe("rotate(90.00 10 10)");
  });

  test("Resume tracking appears only while following is paused", () => {
    const { cam, emit } = fakeCamera();
    render(<CameraControls camera={cam} follow={{ on: true, enabled: true, toggle: vi.fn() }} />);
    expect(screen.queryByRole("button", { name: "Resume tracking" })).toBeNull();
    emit({ azimuth: 0, following: true, paused: true });
    fireEvent.click(screen.getByRole("button", { name: "Resume tracking" }));
    expect(cam.resumeFollow).toHaveBeenCalled();
    emit({ azimuth: 0, following: true, paused: false });
    expect(screen.queryByRole("button", { name: "Resume tracking" })).toBeNull();
  });

  test("2D: no tilt buttons; without a camera the buttons are disabled", () => {
    const { cam } = fakeCamera(false);
    const { rerender } = render(<CameraControls camera={cam} />);
    expect(screen.queryByRole("button", { name: /Tilt/ })).toBeNull();
    rerender(<CameraControls camera={null} />);
    expect((screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("renders into the HUD slot when given one", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { cam } = fakeCamera();
    render(<CameraControls camera={cam} host={host} />);
    expect(host.querySelector(".lm-cam")).not.toBeNull();
  });

  test("bearingText", () => {
    expect(bearingText(0)).toBe("North is up");
    expect(bearingText(2 * Math.PI)).toBe("North is up");
    expect(bearingText(-Math.PI / 4)).toBe("Map turned 45° anticlockwise");
  });
});
