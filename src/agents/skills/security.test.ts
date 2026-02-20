import { describe, expect, it } from "vitest";
import { evaluateSkillToolCallAccess, resolveSkillPolicy } from "./security.js";

describe("skills runtime guard", () => {
  it("allows shell tool calls when capability is declared and policy allows it", () => {
    const policy = resolveSkillPolicy({
      globalPolicy: { allow: ["shell.exec"] },
    });
    const decision = evaluateSkillToolCallAccess({
      toolName: "exec",
      toolParams: { command: "echo hello" },
      declaredCapabilities: ["shell.exec"],
      policy,
    });
    expect(decision.allowed).toBe(true);
  });

  it("blocks shell tool calls when capability is not declared", () => {
    const policy = resolveSkillPolicy({
      globalPolicy: { allow: ["shell.exec"] },
    });
    const decision = evaluateSkillToolCallAccess({
      toolName: "exec",
      toolParams: { command: "echo hello" },
      declaredCapabilities: [],
      policy,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("not declared");
  });

  it("blocks network calls when allowDomains is missing", () => {
    const policy = resolveSkillPolicy({
      globalPolicy: { allow: ["network.fetch"] },
    });
    const decision = evaluateSkillToolCallAccess({
      toolName: "web_fetch",
      toolParams: { url: "https://example.com" },
      declaredCapabilities: ["network.fetch"],
      policy,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("allowDomains");
  });

  it("blocks network calls when no URL domain can be resolved", () => {
    const policy = resolveSkillPolicy({
      globalPolicy: {
        allow: ["network.fetch"],
        allowDomains: ["example.com"],
      },
    });
    const decision = evaluateSkillToolCallAccess({
      toolName: "web_fetch",
      toolParams: { query: "latest updates" },
      declaredCapabilities: ["network.fetch"],
      policy,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("no domain could be resolved");
  });

  it("blocks network calls when domain is outside allowDomains", () => {
    const policy = resolveSkillPolicy({
      globalPolicy: {
        allow: ["network.fetch"],
        allowDomains: ["example.com"],
      },
    });
    const decision = evaluateSkillToolCallAccess({
      toolName: "web_fetch",
      toolParams: { url: "https://evil.example.net/path" },
      declaredCapabilities: ["network.fetch"],
      policy,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("network.fetch denied for domain");
  });

  it("allows network calls when extracted URL domain matches allowDomains rule", () => {
    const policy = resolveSkillPolicy({
      globalPolicy: {
        allow: ["network.fetch"],
        allowDomains: ["*.example.com"],
      },
    });
    const decision = evaluateSkillToolCallAccess({
      toolName: "web_fetch",
      toolParams: { query: "fetch https://docs.example.com/reference" },
      declaredCapabilities: ["network.fetch"],
      policy,
    });
    expect(decision.allowed).toBe(true);
  });

  it("blocks filesystem writes outside approved paths", () => {
    const policy = resolveSkillPolicy({
      globalPolicy: {
        allow: ["filesystem.write"],
        writePaths: ["/tmp/openclaw-safe"],
      },
    });
    const denied = evaluateSkillToolCallAccess({
      toolName: "write",
      toolParams: { file_path: "/tmp/openclaw-other/out.txt" },
      declaredCapabilities: ["filesystem.write"],
      policy,
    });
    const allowed = evaluateSkillToolCallAccess({
      toolName: "write",
      toolParams: { file_path: "/tmp/openclaw-safe/out.txt" },
      declaredCapabilities: ["filesystem.write"],
      policy,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("filesystem.write denied");
    expect(allowed.allowed).toBe(true);
  });

  it("blocks filesystem writes when no target path is provided", () => {
    const policy = resolveSkillPolicy({
      globalPolicy: {
        allow: ["filesystem.write"],
        writePaths: ["/tmp/openclaw-safe"],
      },
    });
    const decision = evaluateSkillToolCallAccess({
      toolName: "write",
      toolParams: {},
      declaredCapabilities: ["filesystem.write"],
      policy,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("no target path could be resolved");
  });

  it("allows apply_patch writes when all patch targets are inside writePaths", () => {
    const policy = resolveSkillPolicy({
      globalPolicy: {
        allow: ["filesystem.write"],
        writePaths: ["/tmp/openclaw-safe"],
      },
    });
    const decision = evaluateSkillToolCallAccess({
      toolName: "apply_patch",
      toolParams: {
        input: `*** Begin Patch
*** Add File: /tmp/openclaw-safe/new-file.txt
+hello
*** End Patch`,
      },
      declaredCapabilities: ["filesystem.write"],
      policy,
    });
    expect(decision.allowed).toBe(true);
  });
});
