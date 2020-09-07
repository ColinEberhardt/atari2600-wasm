export interface Parser {
  (specification: string): InstructionSet;
}

export interface Generator {
  (insructions: InstructionSet): string;
}

export type InstructionGenerator<T extends Instruction> = (
  instruction: T,
  address: AddressingMode
) => string;

type InstructionSet = Instruction[];

export enum FlagEffect {
  SetFromBit0,
  SetFromBit1,
  SetFromBit2,
  SetFromBit3,
  SetFromBit4,
  SetFromBit5,
  SetFromBit6,
  SetFromBit7,
  Modified,
  NotModified,
  Set,
  Cleared
}

export interface Flags {
  negative: FlagEffect;
  zero: FlagEffect;
  carry: FlagEffect;
  interrupt: FlagEffect;
  decimal: FlagEffect;
  overflow: FlagEffect;
}

type StronglyKeyedMapBase<T, K extends keyof T, V> = { [k in K]: V };
type StronglyKeyedMap<T, V> = StronglyKeyedMapBase<T, keyof T, V>;

export type FlagsMap = Partial<StronglyKeyedMap<Flags, FlagEffect>>;

export enum CycleModifier {
  None,
  PageBoundaryCrossed,
  BranchPageBoundaryCrossed
}

export enum AddressingModeType {
  Immediate,
  Zeropage,
  ZeropageX,
  ZeropageY,
  Absolute,
  AbsoluteX,
  AbsoluteY,
  Indirect,
  IndirectX,
  IndirectY,
  Accumulator,
  Relative,
  Implied
}

export interface AddressingMode {
  opcode: string;
  cycles: number;
  mode: AddressingModeType;
  cycleModifier: CycleModifier;
}

export interface InstructionBase {
  name: string;
  description: string;
  flags: FlagsMap;
  addressingModes: AddressingMode[];
}

export interface BranchInstruction extends InstructionBase {
  type: "branch";
  condition: string;
}

export interface JumpInstruction extends InstructionBase {
  type: "jump";
}

export interface TestInstruction extends InstructionBase {
  type: "test";
  condition: string;
}

export interface PushInstruction extends InstructionBase {
  type: "push";
  expression: string;
}

export interface PopInstruction extends InstructionBase {
  type: "pop";
  assignee: string;
}

export interface EmptyInstruction extends InstructionBase {
  type: "empty";
}

export interface AssignmentInstruction extends InstructionBase {
  type: "assignment";
  assignee: string;
  expression: string;
}

export type Instruction =
  | AssignmentInstruction
  | BranchInstruction
  | TestInstruction
  | EmptyInstruction
  | JumpInstruction
  | PushInstruction
  | PopInstruction;
