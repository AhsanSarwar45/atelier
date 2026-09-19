import { describe, it, expect, vi } from "vitest";
const update = vi.fn();
vi.mock("../api", () => ({ beads: { update: (...args: unknown[]) => update(...args) } }));
import { updateStatus } from "../cli"; // eslint-disable-line import/first

describe("browser status changes share the completion contract", () => {
  it("uses the verified endpoint and preserves a refusal", async () => {
    update.mockRejectedValueOnce(new Error("Work has not landed"));
    await expect(updateStatus("bw-1", "closed", "/a/project")).rejects.toThrow("Work has not landed");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({path:"/a/project",id:"bw-1",status:"closed"}));
  });
  it("represents cancellation separately from delivery", async () => {
    update.mockResolvedValueOnce({success:true});
    await updateStatus("bw-1", "cancelled", "/a/project");
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({status:"closed",add_label:"cancelled"}));
  });
});
