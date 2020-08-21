import { readFileSync, writeFileSync } from "fs";
const prettier = require("prettier");

import "./types/interfaces";
import parse from "./parser";
import generate from "./generator";

const specification = readFileSync("6502.txt", "utf-8");

const instructions = parse(specification);
const as = generate(instructions);

writeFileSync(
  "../assembly/cpu.ts",
  prettier.format(as, { parser: "typescript" })
);
