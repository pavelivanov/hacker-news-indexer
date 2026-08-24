import { writeFile } from "node:fs/promises";
import path from "node:path";

import { ClassificationV1Schema } from "../packages/contracts/src/index.ts";

const outputPath = path.resolve(
  process.argv[2] ??
    "packages/contracts/src/generated/classification-v1.schema.json",
);
await writeFile(
  outputPath,
  `${JSON.stringify(ClassificationV1Schema, null, 2)}\n`,
);
console.log(`Wrote ${path.relative(process.cwd(), outputPath)}`);
