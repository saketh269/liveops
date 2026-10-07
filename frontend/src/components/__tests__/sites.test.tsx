import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SitesPage from "../../pages/SitesPage";
import { mockApi, Reply, SITE } from "./mockApi";

afterEach(() => vi.unstubAllGlobals());

test("create, link to map and layout editor, rename, and delete with in-page confirm", async () => {
  let sites = [SITE];
  const api = mockApi({
    "GET /api/sites": () => sites,
    "GET /api/mappings": [],
    "POST /api/sites": (c: { body: { name: string; template: string } }) => {
      const s = { ...SITE, id: "site2", ...c.body };
      sites = [...sites, s];
      return new Reply(201, s);
    },
    "PUT /api/sites/site1": (c: { body: { name: string } }) => ({ ...SITE, ...c.body }),
    "DELETE /api/sites/site1": new Reply(204),
  });
  render(<MemoryRouter><SitesPage /></MemoryRouter>);
  const card = (await screen.findByText("St Mary's")).closest("li") as HTMLElement;
  expect(within(card).getByRole("link", { name: "Open live map" }).getAttribute("href")).toBe("/map/site1");
  expect(within(card).getByRole("link", { name: "Edit layout" }).getAttribute("href")).toBe("/map/site1?edit=1");

  fireEvent.click(screen.getByRole("button", { name: "New site" }));
  fireEvent.click(screen.getByRole("button", { name: "Create site" }));
  expect(screen.getByText(/Give the site a name/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/^Site name/), { target: { value: "North DC" } });
  fireEvent.change(screen.getByLabelText("Template"), { target: { value: "warehouse" } });
  fireEvent.click(screen.getByRole("button", { name: "Create site" }));
  await waitFor(() => expect(api.find("POST", "/api/sites")[0]?.body).toEqual({ name: "North DC", template: "warehouse" }));
  expect(await screen.findByText("North DC")).toBeTruthy();

  fireEvent.click(within(card).getByRole("button", { name: "Rename or change template" }));
  fireEvent.change(within(card).getByLabelText(/^Site name/), { target: { value: "St Mary's East" } });
  fireEvent.click(within(card).getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(api.find("PUT", "/api/sites/site1")[0]?.body).toEqual({ name: "St Mary's East", template: "hospital" }));

  const card1 = (await screen.findByText("St Mary's")).closest("li") as HTMLElement;
  fireEvent.click(within(card1).getByRole("button", { name: "Delete site" }));
  expect(within(card1).getByText(/live map stops/)).toBeTruthy();
  fireEvent.click(within(card1).getByRole("button", { name: "Yes, delete" }));
  await waitFor(() => expect(api.find("DELETE", "/api/sites/site1")).toHaveLength(1));
});
