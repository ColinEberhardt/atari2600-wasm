import {
  AddressingModeType,
  AssignmentInstruction,
  FlagsMap,
  FlagEffect,
  Generator,
  InstructionGenerator,
  BranchInstruction,
  AddressingMode,
  Instruction,
  TestInstruction,
  EmptyInstruction,
  JumpInstruction,
  CycleModifier,
  PushInstruction,
  PopInstruction
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
        const addr = this.memory.read(this.pc++);
        const memval: u16 = this.memory.read(addr);`;
    case AddressingModeType.ZeropageX:
      return `
        const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
        const memval: u16 = this.memory.read(addr);`;
    case AddressingModeType.ZeropageY:
      return `
        const addr = (this.memory.read(this.pc++) + this.yRegister) & 0xff;
        const memval: u16 = this.memory.read(addr);`;
    case AddressingModeType.Indirect:
      return `
        const addrref = this.memory.readWord(this.pc);
        this.pc += 2;
        const addr = this.memory.readWord(addrref);`;
    case AddressingModeType.Absolute:
      return `
        const addr = this.memory.readWord(this.pc);
        this.pc += 2;
        const memval: u16 = this.memory.read(addr);`;
    case AddressingModeType.AbsoluteX:
      return `
        const baseAddr = this.memory.readWord(this.pc);
        this.pc += 2;
        const addr = baseAddr + this.xRegister;
        const pageCrossed = Math.floor(baseAddr/256) != Math.floor(addr/256);
        const memval: u16 = this.memory.read(addr);`;
    case AddressingModeType.AbsoluteY:
      return `
      const baseAddr = this.memory.readWord(this.pc);
      this.pc += 2;
        const addr = baseAddr + this.yRegister;
        const pageCrossed = Math.floor(baseAddr/256) != Math.floor(addr/256);
        const memval = this.memory.read(addr);`;
    case AddressingModeType.IndirectX:
      return `
        const indirectAddr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
        const addr = this.memory.readWord(indirectAddr);
        const memval: u16 = this.memory.read(addr);`;
    case AddressingModeType.IndirectY:
      return `
      const operand = this.memory.read(this.pc++);
      const addr = this.memory.readWord(operand);
      const pageCrossed = Math.floor(addr/256) != Math.floor((addr + this.yRegister)/256);
      const memval: u16 = this.memory.read(addr + this.yRegister);`;
    case AddressingModeType.Implied:
      return "";
  }
};

function replaceRegisters(algorithm) {
  [
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
    ["PC", "this.pc"],
    ["SR", "this.statusRegister.pack()"]
  ].forEach(s => {
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
      SR: "this.statusRegister.unpack(result as u8);",
      SP: "this.memory.stackPointer = (result & 0xff) as u8;",
      PC: "this.pc = addr;",
      M:
        addressMode == AddressingModeType.Accumulator
          ? "this.accumulator = (result & 0xff) as u8;"
          : "this.memory.write(addr, (result & 0xff) as u8);"
    },
    assignee
  );

const setFlags = (flags: FlagsMap, isTestInstruction: boolean = false) =>
  Object.entries(flags)
    .map(([flag, value]) => {
      if (value < 8) {
        const factor = Math.pow(2, value);
        return `this.statusRegister.${flag} = u8((memval & ${factor}) == ${factor});`;
      }
      switch (value) {
        case FlagEffect.Cleared:
          return `this.statusRegister.${flag} = 0;`;
        case FlagEffect.Set:
          return `this.statusRegister.${flag} = 1;`;
        case FlagEffect.Modified:
          return lookup(
            {
              carry: isTestInstruction
                ? "this.statusRegister.carry = u8(result >= 0);"
                : "this.statusRegister.carry = u8(result > 0xff);",
              negative: isTestInstruction
                ? "this.statusRegister.negative = u8((result & 128) === 128);"
                : "this.statusRegister.negative = u8(result !== 0);",
              zero: "this.statusRegister.zero = u8(result === 0);",
              overflow:
                "this.statusRegister.overflow = u8((~(this.accumulator ^ memval) & (this.accumulator ^ result) & 0x80) === 0x80);"
            },
            flag
          );
      }
    })
    .join("\n");

const handleCycles = (address: AddressingMode) =>
  address.cycleModifier === CycleModifier.PageBoundaryCrossed
    ? ` this.cyclesRemaining = ${address.cycles - 1} + u8(pageCrossed);`
    : ` this.cyclesRemaining = ${address.cycles - 1};`;

const generateBranch = (
  instruction: BranchInstruction,
  address: AddressingMode
) => `
  case 0x${address.opcode}: /* ${instruction.name} */ {
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

function generateCase<T extends Instruction>(
  adaptee: InstructionGenerator<T>
): InstructionGenerator<T> {
  return (instruction, address) =>
    `
  case 0x${address.opcode}: /* ${instruction.name} */ {
    trace("[CPU] ${instruction.name}");
    ${adaptee(instruction, address)}
    ${handleCycles(address)};
  }
  break;`;
}

const generateAssignment: InstructionGenerator<AssignmentInstruction> = generateCase(
  (instruction, address) => `
    ${applyAddressingMode(address.mode)}
    const result: u16 = ${replaceRegisters(instruction.expression)};
    ${setFlags(instruction.flags)}
    ${assignValue(instruction.assignee, address.mode)}`
);

const generatePush: InstructionGenerator<PushInstruction> = generateCase(
  (instruction, address) => `
    ${applyAddressingMode(address.mode)}
    const result: u16 = ${replaceRegisters(instruction.expression)};
    this.memory.push((result & 0xff) as u8);`
);

const generatePop: InstructionGenerator<PopInstruction> = generateCase(
  (instruction, address) => `
    ${applyAddressingMode(address.mode)}
    const result = this.memory.pop();
    ${assignValue(instruction.assignee, address.mode)}`
);

const generateTest: InstructionGenerator<TestInstruction> = generateCase(
  (instruction, address) => `
    ${applyAddressingMode(address.mode)}
    const result: i16 = ${replaceRegisters(instruction.condition)};
    ${setFlags(instruction.flags, true)}`
);

const generateJump: InstructionGenerator<JumpInstruction> = generateCase(
  (_, address) => `
      ${applyAddressingMode(address.mode)}
      this.pc = addr;`
);

const generateEmpty: InstructionGenerator<EmptyInstruction> = generateCase(
  (instruction, address) => `
    ${applyAddressingMode(address.mode)}
    ${setFlags(instruction.flags)}`
);

const generateAs = (instruction: Instruction) =>
  instruction.addressingModes
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
        case "push":
          return generatePush(instruction, address);
        case "pop":
          return generatePop(instruction, address);
      }
    })
    .join("\n");

const generate: Generator = instructions => {
  const template = readFileSync("./src/template.txt", "utf-8");
  const generated = instructions.map(generateAs).join("\n");
  return template.replace("###CODEGEN###", generated);
};

export default generate;
