import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import UploadPanel from "../sources/UploadPanel";

test("uploads a CSV and reports rows; shows server errors with hints (LIVEOPS-80)", async () => {
  const calls: RequestInit[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(init);
    if (calls.length === 1) {
      return new Response(JSON.stringify({ dataset: "beds.csv", bytes: 20, rows: 2, columns: ["id", "status"] }), { status: 201 });
    }
    return new Response(JSON.stringify({ detail: { message: "The file has more than 500 columns", hint: "Remove unused columns." } }), { status: 422 });
  }));
  const onUploaded = vi.fn();
  render(<UploadPanel sourceId="s1" onUploaded={onUploaded} />);
  const input = screen.getByLabelText("Choose a file to upload") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["id,status\n1,free\n2,busy\n"], "beds.csv", { type: "text/csv" })] } });
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("2 rows"));
  expect(onUploaded).toHaveBeenCalledTimes(1);
  expect(calls[0].body).toBeInstanceOf(FormData);

  fireEvent.change(input, { target: { files: [new File(["x"], "wide.csv")] } });
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Remove unused columns"));

  fireEvent.change(input, { target: { files: [new File(["x"], "notes.txt")] } });
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(".csv or .xlsx"));
  vi.unstubAllGlobals();
});
