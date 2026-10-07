import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App";

test("shell renders navigation in product order", () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  render(
    <MemoryRouter initialEntries={["/sources"]}>
      <App />
    </MemoryRouter>,
  );
  const links = within(screen.getByRole("navigation")).getAllByRole("link").map((a) => a.textContent);
  expect(links).toEqual(["Sources", "Sites", "Mapping studio", "Live map", "Health"]);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sources");
  vi.unstubAllGlobals();
});
