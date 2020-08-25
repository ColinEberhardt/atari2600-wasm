import {
  CycleModifier,
  AddressingMode,
  Instruction,
  Parser,
  FlagsMap,
  FlagEffect,
  AddressingModeType,
  InstructionBase
} from "./types/interfaces";
import { lookup, pair, pairToMap } from "./util";

const groupByInstruction = (accumulator: String[][], line: string) => {
  if (!line.startsWith(" ")) {
    // push a new array for each new instruction
    accumulator.push([]);
  }
  accumulator[accumulator.length - 1].push(line);
  return accumulator;
};

const parseCycleModifier = (cycles: string): CycleModifier => {
  if (cycles.endsWith("**")) {
    return CycleModifier.BranchPageBoundaryCrossed;
  }
  if (cycles.endsWith("*")) {
    return CycleModifier.PageBoundaryCrossed;
  }
  return CycleModifier.None;
};

const parseAddressingModeType = (addressing: string): AddressingModeType =>
  lookup(
    {
      accumulator: AddressingModeType.Accumulator,
      immidiate: AddressingModeType.Immediate,
      zeropage: AddressingModeType.Zeropage,
      "zeropage,X": AddressingModeType.ZeropageX,
      "zeropage,Y": AddressingModeType.ZeropageY,
      absolute: AddressingModeType.Absolute,
      "absolute,X": AddressingModeType.AbsoluteX,
      "absolute,Y": AddressingModeType.AbsoluteY,
      "(indirect,X)": AddressingModeType.IndirectX,
      "(indirect),Y": AddressingModeType.IndirectY,
      relative: AddressingModeType.Relative,
      implied: AddressingModeType.Implied,
      indirect: AddressingModeType.Indirect
    },
    addressing
  );

const parseFlag = (flag: string): FlagEffect =>
  lookup(
    {
      "+": FlagEffect.Modified,
      "-": FlagEffect.NotModified,
      "1": FlagEffect.Set,
      "0": FlagEffect.Cleared,
      M0: FlagEffect.SetFromBit0,
      M1: FlagEffect.SetFromBit1,
      M2: FlagEffect.SetFromBit2,
      M3: FlagEffect.SetFromBit3,
      M4: FlagEffect.SetFromBit4,
      M5: FlagEffect.SetFromBit5,
      M6: FlagEffect.SetFromBit6,
      M7: FlagEffect.SetFromBit7
    },
    flag
  );

const parseAddressingModes = (lines: string[]): AddressingMode[] => {
  const addressModeHeaderIndex = lines.findIndex(l =>
    l.trim().startsWith("addressing")
  );
  return lines.slice(addressModeHeaderIndex + 2).map(line => {
    const cycles = line.slice(45).trim();
    return {
      opcode: line.slice(33, 39).trim(),
      cycles: Number(cycles.replace(/\**/g, "")),
      mode: parseAddressingModeType(line.slice(0, 19).trim()),
      cycleModifier: parseCycleModifier(cycles)
    };
  });
};

const flagNames = [
  "negative",
  "zero",
  "carry",
  "interrupt",
  "decimal",
  "overflow"
];

const parseFlags = (lines: string[]): FlagsMap => {
  const flagsHeaderIndex = lines.findIndex(l => l.endsWith("N Z C I D V"));
  const flagsLine = lines[flagsHeaderIndex + 1];
  const flagText = flagsLine.trim().split(" ").map(parseFlag);
  return pairToMap(
    pair(flagNames, flagText).filter(
      ([, flag]) => flag !== FlagEffect.NotModified
    )
  );
};

const parseInstructionBase = (lines: string[]): InstructionBase => ({
  name: lines[0].substr(0, 3),
  description: lines[0].substr(5),
  flags: parseFlags(lines),
  addressingModes: parseAddressingModes(lines)
});

const parseInstruction = (lines: string[]): Instruction => {
  const base = parseInstructionBase(lines);
  const inst = lines[1].slice(0, -11).trim();
  if (base.name === "JMP") {
    return {
      ...base,
      type: "jump"
    };
  }
  if (inst.includes("->")) {
    const [expression, assignee] = inst.split("->").map(s => s.trim());
    return {
      ...base,
      type: "assignment",
      expression,
      assignee
    };
  }
  if (inst.includes("branch on")) {
    return {
      ...base,
      type: "branch",
      condition: inst.replace("branch on", "").trim()
    };
  }
  if (inst.includes("push")) {
    return {
      ...base,
      type: "push",
      expression: inst.replace("push", "").trim()
    };
  }
  if (inst.includes("pull")) {
    return {
      ...base,
      type: "pop",
      assignee: inst.replace("pull", "").trim()
    };
  }
  if (inst === "") {
    return {
      ...base,
      type: "empty"
    };
  }
  return {
    ...base,
    type: "test",
    condition: inst
  };
};

const parse: Parser = specification => {
  const lines = specification.split("\n").filter(l => l.trim() !== "");
  return lines.reduce(groupByInstruction, []).map(parseInstruction);
};

export default parse;
