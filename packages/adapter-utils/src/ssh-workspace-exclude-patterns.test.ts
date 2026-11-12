import { describe, expect, it } from "vitest";
import { workspaceExcludePatternForms } from "./ssh.js";
import { shouldExcludePath } from "./exclude-patterns.js";

describe("workspaceExcludePatternForms canonicalizes every accepted shape to matcher-covered forms", () => {
  it("expands a bare literal name to the four equivalent forms", () => {
    expect(workspaceExcludePatternForms("node_modules")).toEqual([
      "node_modules",
      "node_modules/*",
      "*/node_modules",
      "*/node_modules/*",
    ]);
  });

  it("pairs a rooted literal path with its any-depth companion", () => {
    expect(workspaceExcludePatternForms("dist/cache")).toEqual(["dist/cache", "*/dist/cache"]);
  });

  it("pairs a rooted contents form with its any-depth companion, single or multi segment", () => {
    expect(workspaceExcludePatternForms("node_modules/*")).toEqual(["node_modules/*", "*/node_modules/*"]);
    expect(workspaceExcludePatternForms("dist/cache/*")).toEqual(["dist/cache/*", "*/dist/cache/*"]);
  });

  it("keeps the any-depth forms as-is", () => {
    expect(workspaceExcludePatternForms("*/dist/cache")).toEqual(["*/dist/cache"]);
    expect(workspaceExcludePatternForms("*/dist/cache/*")).toEqual(["*/dist/cache/*"]);
  });

  it("drops unsupported globs, absolute paths, and traversal segments fail-closed", () => {
    expect(workspaceExcludePatternForms("*.log")).toBeNull();
    expect(workspaceExcludePatternForms("dist/*.map")).toBeNull();
    expect(workspaceExcludePatternForms("/dist/cache")).toBeNull();
    expect(workspaceExcludePatternForms("dist/../cache")).toBeNull();
    expect(workspaceExcludePatternForms("dist//cache")).toBeNull();
    // A `..` inside a name is not a traversal segment.
    expect(workspaceExcludePatternForms("..cache")).toEqual(["..cache", "..cache/*", "*/..cache", "*/..cache/*"]);
  });

  it("emitted forms cover nested paths at every depth the un-anchored tar exclude would match", () => {
    // GNU tar applies --exclude un-anchored with wildcards-match-slash, so
    // `dist/cache`, `node_modules/*`, and `dist/cache/*` all match nested
    // `pkg/.../...` members. Every canonical list below must reproduce that
    // coverage through the baseline matcher, or the restore merge would
    // delete the excluded local files as "missing at the source".
    const cases: Array<[string, string[]]> = [
      ["dist/cache", ["dist/cache", "dist/cache/x.bin", "packages/a/dist/cache", "packages/a/dist/cache/x.bin"]],
      ["node_modules/*", ["node_modules/dep/index.js", "packages/a/node_modules/dep/index.js"]],
      ["dist/cache/*", ["dist/cache/x.bin", "packages/a/dist/cache/x.bin"]],
    ];
    for (const [pattern, targets] of cases) {
      const forms = workspaceExcludePatternForms(pattern);
      expect(forms, `pattern ${pattern} must be accepted`).not.toBeNull();
      for (const target of targets) {
        expect(shouldExcludePath(target, forms!), `pattern ${pattern} must cover ${target}`).toBe(true);
      }
    }
  });
});
