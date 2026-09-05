import { describe, expect, it } from "vitest";
import {
  contentTypeForSourceFile,
  isSupportedSourceFile,
  markdownFilename,
  sanitizeFilename,
  sourceFileExtension,
} from "../src/sources.ts";

describe("sanitizeFilename", () => {
  it("keeps an ordinary filename intact", () => {
    expect(sanitizeFilename("Refund policy.md")).toBe("Refund policy.md");
  });

  it("strips any directory component, so a traversal cannot escape the prefix", () => {
    expect(sanitizeFilename("../../etc/passwd.md")).toBe("passwd.md");
    expect(sanitizeFilename("C:\\Users\\alex\\handbook.md")).toBe("handbook.md");
  });

  it("removes control characters", () => {
    expect(sanitizeFilename("hand\u0000book\u001f.md")).toBe("handbook.md");
  });

  it("refuses a dotfile rather than inventing a name from it", () => {
    expect(sanitizeFilename(".md")).toBeNull();
    expect(sanitizeFilename(".gitignore")).toBeNull();
  });

  it("refuses a name with no extension at all", () => {
    expect(sanitizeFilename("noextension")).toBeNull();
  });

  it("refuses a name that is only dots or whitespace", () => {
    expect(sanitizeFilename("...")).toBeNull();
    expect(sanitizeFilename("")).toBeNull();
    expect(sanitizeFilename("   ")).toBeNull();
  });

  it("truncates a long name without losing the extension", () => {
    const result = sanitizeFilename(`${"a".repeat(400)}.md`);
    expect(result).not.toBeNull();
    expect(result?.length).toBe(255);
    expect(result?.endsWith(".md")).toBe(true);
  });
});

describe("source file types", () => {
  it("reads the extension case-insensitively", () => {
    expect(sourceFileExtension("Handbook.MD")).toBe(".md");
    expect(sourceFileExtension("noextension")).toBe("");
  });

  it("accepts the documented types and rejects the rest", () => {
    expect(isSupportedSourceFile("faq.md")).toBe(true);
    expect(isSupportedSourceFile("manual.PDF")).toBe(true);
    expect(isSupportedSourceFile("payload.exe")).toBe(false);
    expect(isSupportedSourceFile("noextension")).toBe(false);
  });

  it("derives the content type from the extension, never from the caller", () => {
    expect(contentTypeForSourceFile("faq.md")).toBe("text/markdown");
    expect(contentTypeForSourceFile("manual.pdf")).toBe("application/pdf");
    expect(contentTypeForSourceFile("mystery.bin")).toBe("application/octet-stream");
  });
});

describe("markdownFilename", () => {
  it("swaps the extension for .md", () => {
    expect(markdownFilename("CV_Alex_Moreton.pdf")).toBe("CV_Alex_Moreton.md");
    expect(markdownFilename("report.docx")).toBe("report.md");
  });

  it("keeps a stem containing dots intact", () => {
    expect(markdownFilename("q1.2026.report.pdf")).toBe("q1.2026.report.md");
  });

  it("appends rather than mangling a name with no extension", () => {
    expect(markdownFilename("handbook")).toBe("handbook.md");
  });

  it("is idempotent, so a markdown file keeps its name", () => {
    expect(markdownFilename("faq.md")).toBe("faq.md");
  });
});
