import {
  AddressingModeType,
  AssignmentInstruction,
  FlagsMap,
  FlagEffect,
  Generator,
  BranchInstruction,
  AddressingMode,
  Instruction,
  TestInstruction,
  EmptyInstruction,
  JumpInstruction,
  CycleModifier
} from "./types/interfaces";
import { lookup } from "./util";

import { readFileSync } from "fs";

const applyAddressingMode = (mode: AddressingModeType) => {
  switch (mode) {
    case AddressingModeType.Accumulator:
      return "const memval: u16 = this.accumulator;";
    case AddressingModeType.Immediate:
      return "const memval: u16 = this.memory.read(this.pc++);";
    case AddressingModeType.Zeropage:
      return `
        const addr: u32 = this.memory.read(this.pc++);
        const memval: u16 = this.memory.read(addr);`;
    case AddressingModeType.ZeropageX:
      return `
        const addr: u32 = this.memory.read(this.pc++) + this.xRegister;
        const memval: u16 = this.memory.read(addr);`;
    case AddressingModeType.ZeropageY:
      return `
        const addr: u32 = this.memory.read(this.pc++) + this.yRegister;
        const memval: u16 = this.memory.read(addr);`;
    case AddressingModeType.Indirect:
      return `
        const addrref: u32 = this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
        const addr: u32 = this.memory.read(addrref) + this.memory.read(addrref + 1) * 0x100;`;
    case AddressingModeType.Absolute:
      return `
        const addr: u32 = this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
        const memval: u16 = this.memory.read(addr);`;
    case AddressingModeType.AbsoluteX:
      return `
        const baseAddr: u32 = this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100
        const addr = baseAddr + this.xRegister;
        const pageCrossed = Math.floor(baseAddr/256) != Math.floor(addr/256);
        const memval: u16 = this.memory.read(addr);`;
    case AddressingModeType.AbsoluteY:
      return `
        const baseAddr: u32 = this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100
        const addr = baseAddr + this.yRegister;
        const pageCrossed = Math.floor(baseAddr/256) != Math.floor(addr/256);
        const memval: u16 = this.memory.read(addr);`;
    case AddressingModeType.IndirectX:
    case AddressingModeType.IndirectY:
    case AddressingModeType.Implied:
      return "";
  }
};

function replaceRegisters(algorithm) {
  const substitutions = [
    ["A/M", "memval"],
    ["A", "this.accumulator"],
    ["=", "=="],
    ["M", "memval"],
    ["N", "this.statusRegister.negative"],
    ["C", "this.statusRegister.carry"],
    ["Z", "this.statusRegister.zero"],
    ["V", "this.statusRegister.overflow"],
    ["I", "this.statusRegister.interrupt"],
    ["D", "this.statusRegister.decimal"],
    ["X", "this.xRegister"],
    ["Y", "this.yRegister"],
    ["PC", "this.pc"]
  ];
  substitutions.forEach(s => {
    algorithm = algorithm.replace(s[0], s[1]);
  });
  return algorithm;
}

const assignValue = (assignee: string, addressMode: AddressingModeType) =>
  lookup(
    {
      A: "this.accumulator = (result & 0xff) as u8;",
      X: "this.xRegister = (result & 0xff) as u8;",
      Y: "this.yRegister = (result & 0xff) as u8;",
      PC: "this.pc = addr;",
      M:
        addressMode == AddressingModeType.Accumulator
          ? "this.accumulator = (result & 0xff) as u8;"
          : "this.memory.write(addr, (result & 0xff) as u8);"
    },
    assignee
  );

const setFlags = (flags: FlagsMap, isTest: boolean = false) =>
  Object.entries(flags)
    .map(([flag, value]) => {
      if (value < 8) {
        const factor = Math.pow(2, value);
        return `this.statusRegister.${flag} = (memval & ${factor}) == ${factor} ? 1 : 0;`;
      }
      switch (value) {
        case FlagEffect.Cleared:
          return `this.statusRegister.${flag} = 0;`;
        case FlagEffect.Set:
          return `this.statusRegister.${flag} = 1;`;
        case FlagEffect.Modified:
          return lookup(
            {
              carry: isTest
                ? "this.statusRegister.carry = result >= 0 ? 1 : 0;"
                : "this.statusRegister.carry = result > 0xff ? 1 : 0;",
              negative: isTest
                ? "this.statusRegister.negative = (result & 128) == 128 ? 1 : 0;"
                : "this.statusRegister.negative = result !== 0 ? 1 : 0;",
              zero: "this.statusRegister.zero = result === 0 ? 1 : 0;",
              overflow:
                "this.statusRegister.overflow = (~(this.accumulator ^ memval) & (this.accumulator ^ result) & 0x80) === 0x80 ? 1 : 0;"
            },
            flag
          );
      }
    })
    .join("\n");

const generateBranch = (
  instruction: BranchInstruction,
  address: AddressingMode
) => `
  case 0x${address.opcode}: /* ${instruction.name} */ {
    trace("${instruction.name}");
    const offset: i16 = this.memory.read(this.pc++);
    this.cyclesRemaining = ${address.cycles - 1};
    if (${replaceRegisters(instruction.condition)}) {
      const previousPC = this.pc;
      this.pc += (offset & 127) - (offset & 128);
      this.cyclesRemaining +=
        (Math.floor(previousPC/256) == Math.floor(this.pc/256)) ? 1 : 2;
    } 
  }
  break;`;

const handleCycles = (address: AddressingMode) =>
  address.cycleModifier === CycleModifier.PageBoundaryCrossed
    ? ` this.cyclesRemaining = ${address.cycles - 1} + (pageCrossed ? 1 : 0);`
    : ` this.cyclesRemaining = ${address.cycles - 1};`;

const generateAssignment = (
  instruction: AssignmentInstruction,
  address: AddressingMode
) => `
  case 0x${address.opcode}: /* ${instruction.name} */ {
    trace("${instruction.name}");
    ${applyAddressingMode(address.mode)}
    const result: u16 = ${replaceRegisters(instruction.algorithm)};
    ${setFlags(instruction.flags)}
    ${assignValue(instruction.assignee, address.mode)}
    ${handleCycles(address)};
  }
  break;`;

const generateTest = (
  instruction: TestInstruction,
  address: AddressingMode
) => `
  case 0x${address.opcode}: /* ${instruction.name} */ {
    trace("${instruction.name}");
    ${applyAddressingMode(address.mode)}
    const result: i16 = ${replaceRegisters(instruction.condition)};
    ${setFlags(instruction.flags, true)}
    ${handleCycles(address)};
  }
  break;`;

const generateJump = (
  instruction: JumpInstruction,
  address: AddressingMode
) => `
    case 0x${address.opcode}: /* ${instruction.name} */ {
      trace("${instruction.name}");
      ${applyAddressingMode(address.mode)}
      ${handleCycles(address)};
      this.pc = addr;
    }
    break;`;

const generateEmpty = (
  instruction: EmptyInstruction,
  address: AddressingMode
) => `
  case 0x${address.opcode}: /* ${instruction.name} */ {
    trace("${instruction.name}");
    ${applyAddressingMode(address.mode)}
    ${setFlags(instruction.flags)}
    ${handleCycles(address)};
  }
  break;`;

const generateAs = (instruction: Instruction) =>
  instruction.addressingModes
    // TODO: implement indirect addressing
    .filter(
      a =>
        a.mode !== AddressingModeType.IndirectX &&
        a.mode !== AddressingModeType.IndirectY
    )
    .map(address => {
      switch (instruction.type) {
        case "assignment":
          return generateAssignment(instruction, address);
        case "branch":
          return generateBranch(instruction, address);
        case "test":
          return generateTest(instruction, address);
        case "empty":
          return generateEmpty(instruction, address);
        case "jump":
          return generateJump(instruction, address);
      }
    })
    .join("\n");

const generate: Generator = instructions => {
  const template = readFileSync("./src/template.txt", "utf-8");
  const generated = instructions.map(generateAs).join("\n");
  return template.replace("###CODEGEN###", generated);
};

export default generate;
