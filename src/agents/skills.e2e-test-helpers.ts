import fs from "node:fs/promises";
import path from "node:path";

export async function writeSkill(params: {
  dir: string;
  name: string;
  description: string;
  metadata?: string;
  body?: string;
  writeManifest?: boolean;
  manifestCapabilities?: string[];
}) {
  const {
    dir,
    name,
    description,
    metadata,
    body,
    writeManifest = true,
    manifestCapabilities = ["model.invoke"],
  } = params;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}${metadata ? `\nmetadata: ${metadata}` : ""}
---

${body ?? `# ${name}\n`}
`,
    "utf-8",
  );
  if (!writeManifest) {
    return;
  }
  await fs.writeFile(
    path.join(dir, "skill.manifest.json"),
    JSON.stringify(
      {
        id: name,
        name,
        version: "1.0.0",
        entry: "SKILL.md",
        capabilities: manifestCapabilities,
      },
      null,
      2,
    ),
    "utf-8",
  );
}
