import { describe, expect, it } from "vitest";

import { reportUrl, type ReportEntry } from "@/components/report-panel";

function entry(project: string): ReportEntry {
  return {
    project, slug: "who-is-allowed-to-merge", title: "Who Is Allowed To Merge",
    card: null, waiting: 0,
  };
}

/**
 * The drawer lists every report on the machine, not only this board's. It used
 * to hand each one the folder of the board the reader happened to have open, so
 * another project's report was built against the wrong board and came back as
 * an error about its card (bw-pqt.18). A folder is only ever sent when it is
 * the report's own.
 */
describe("the address a report is opened at", () => {
  it("sends this board's folder for a report about this board's project", () => {
    const url = reportUrl(entry("beads-web"), "/home/dev/beads-web");
    expect(new URL(url, "http://x").searchParams.get("path")).toBe("/home/dev/beads-web");
  });

  it("sends no folder for a report about another project", () => {
    const url = reportUrl(entry("machinery"), "/home/dev/beads-web");
    expect(new URL(url, "http://x").searchParams.get("path")).toBeNull();
  });

  it("sends no folder when this board has no copy on this machine", () => {
    const url = reportUrl(entry("beads-web"), "");
    expect(new URL(url, "http://x").searchParams.get("path")).toBeNull();
  });

  it("names the report whichever project it is about", () => {
    const q = new URL(reportUrl(entry("machinery"), "/home/dev/beads-web"), "http://x").searchParams;
    expect(q.get("project")).toBe("machinery");
    expect(q.get("slug")).toBe("who-is-allowed-to-merge");
  });

  it("reads a trailing separator off the folder before comparing", () => {
    const url = reportUrl(entry("beads-web"), "/home/dev/beads-web/");
    expect(new URL(url, "http://x").searchParams.get("path")).toBe("/home/dev/beads-web/");
  });
});
