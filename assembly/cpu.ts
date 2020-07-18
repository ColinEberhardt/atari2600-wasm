import Memory from "./memory";

// full instruction set: http://www.obelisk.me.uk/6502/reference.html
// patterns: http://nparker.llx.com/a2/opcodes.html
// overflow flag explained: http://www.righto.com/2012/12/the-6502-overflow-flag-explained.html

export class StatusRegister {
  zero: bool;
  negative: bool;
  carry: bool;
  overflow: bool;

  constructor() {}

  setStatus(value: u8): void {
    this.zero = value == 0;
    this.negative = (value & 0b10000000) != 0;
  }

  setStatusWithCarry(oldValue: u8, newValue: u8): void {
    this.setStatus(newValue);
    this.carry = (oldValue & 0b00000001) as bool;
  }
}

// encodes the aaa values for the cc = 01 instructions
enum CC01_Instruction {
  ORA,
  AND,
  EOR,
  ADC,
  STA,
  LDA,
  CMP,
  SBC,
}

enum AddressMode {
  ZeroPage = 1,
  Immediate,
  Absolute,
  ZeroPageY,
  ZeroPageX,
  AbsoluteY,
  AbsoluteX,
}

export class CPU {
  accumulator: u8;
  xRegister: u8;
  yRegister: u8;
  memory: Memory;
  pc: u32;
  cyclesRemaining: u8;
  paused: boolean;
  statusRegister: StatusRegister;

  constructor(memory: Memory) {
    this.memory = memory;
    this.pc = memory.getROMStartAddress();
    this.paused = false;
    this.statusRegister = new StatusRegister();
  }

  tick(ticks: u32 = 1): void {
    for (let i: u32 = 0; i < ticks; i++) {
      this.tickOnce();
    }
  }

  tickOnce(): void {
    if (this.cyclesRemaining > 0) {
      this.cyclesRemaining--;
      return;
    }

    // if the TIA is pausing the 6502, we still need to count down the remaining cycles for
    // the most recent operations
    if (this.paused) {
      return;
    }

    const opcode: u8 = this.memory.read(this.pc++);
    const aaa = (opcode & 0b11100000) >> 5;
    const bbb = (opcode & 0b00011100) >> 2;
    const cc = opcode & 0b00000011;

    trace("opcode " + opcode.toString());

    // following the instruction patterns detailed here:
    // http://nparker.llx.com/a2/opcodes.html
    if (cc === 1) {
      let value: u32 = 0,
        addr: u32 = 0;
      switch (bbb) {
        case 0b000:
          break; // 000	(zero page,X)
        case AddressMode.ZeroPage:
          trace("zero page");
          addr = this.memory.read(this.pc++);
          value = this.memory.read(addr);
          this.cyclesRemaining = 2;
          break;
        case AddressMode.Immediate:
          value = this.memory.read(this.pc++);
          this.cyclesRemaining = 1;
          break;
        case AddressMode.Absolute:
          addr =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          value = this.memory.read(addr);
          this.cyclesRemaining = 3;
          break;
        case AddressMode.ZeroPageY:
          addr = this.memory.read(this.pc++);
          value = this.memory.read(addr + this.yRegister);
          this.cyclesRemaining = 3;
          break;
        case AddressMode.ZeroPageX:
          addr = this.memory.read(this.pc++);
          value = this.memory.read(addr + this.xRegister);
          this.cyclesRemaining = 3;
          break;
        case AddressMode.AbsoluteY:
          addr =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          value = this.memory.read(addr + this.yRegister);
          this.cyclesRemaining = 3 + (addr > 255 ? 1 : 0);
          break;
        case AddressMode.AbsoluteX:
          addr =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          value = this.memory.read(addr + this.xRegister);
          this.cyclesRemaining = 3 + (addr > 255 ? 1 : 0);
          break;
      }

      switch (aaa) {
        case CC01_Instruction.ORA:
          this.accumulator = this.accumulator | (value as u8);
          this.statusRegister.zero = this.accumulator == 0;
          this.statusRegister.negative = (this.accumulator & 0b10000000) != 0;
          break;
        case CC01_Instruction.AND:
          this.accumulator = this.accumulator & (value as u8);
          this.statusRegister.zero = this.accumulator == 0;
          this.statusRegister.negative = (this.accumulator & 0b10000000) != 0;
          break;
        case CC01_Instruction.EOR:
          this.accumulator = this.accumulator ^ (value as u8);
          this.statusRegister.zero = this.accumulator == 0;
          this.statusRegister.negative = (this.accumulator & 0b10000000) != 0;
          break;
        case CC01_Instruction.ADC:
          const sum: u32 =
            this.accumulator + value + (this.statusRegister.carry ? 1 : 0);
          this.statusRegister.carry = sum > 0xff;
          // see: http://www.righto.com/2012/12/the-6502-overflow-flag-explained.html
          this.statusRegister.overflow =
            (~(this.accumulator ^ value) & (this.accumulator ^ sum) & 0x80) ===
            0x80;
          this.accumulator = sum as u8;
          this.statusRegister.zero = this.accumulator == 0;
          this.statusRegister.negative = (this.accumulator & 0b10000000) != 0;
          break;
        case CC01_Instruction.LDA:
          this.accumulator = value as u8;
          this.statusRegister.zero = this.accumulator == 0;
          this.statusRegister.negative = (this.accumulator & 0b10000000) != 0;
          break;
        case CC01_Instruction.STA:
          this.memory.write(addr, this.accumulator);
          break;
        case CC01_Instruction.CMP:
          this.statusRegister.carry = this.accumulator >= value;
          this.statusRegister.zero = value === this.accumulator;
          this.statusRegister.negative = (this.accumulator & 0b10000000) != 0;
          break;
      }
    } else {
      switch (opcode) {
        case 0x4a: {
          // LSR Accumulator
          trace("LSR");
          const oldValue = this.accumulator;
          this.accumulator = this.accumulator >> 1;
          this.statusRegister.setStatusWithCarry(oldValue, this.accumulator);
          this.cyclesRemaining = 1;
          break;
        }
        case 0x84: {
          // STY Zero page
          const address: u8 = this.memory.read(this.pc++);
          trace("STY " + address.toString());
          this.memory.write(address, this.yRegister);
          this.cyclesRemaining = 2;
          break;
        }
        case 0x86: {
          // STX Zero page
          const address: u8 = this.memory.read(this.pc++);
          trace("STX " + address.toString());
          this.memory.write(address, this.xRegister);
          this.cyclesRemaining = 2;
          break;
        }
        case 0xa2: {
          // LDX Immediate
          const value: u8 = this.memory.read(this.pc++);
          trace("LDX " + value.toString());
          this.xRegister = value;
          this.statusRegister.setStatus(value);
          this.cyclesRemaining = 1;
          break;
        }
        case 0xa0: {
          // LDY Immediate
          const value: u8 = this.memory.read(this.pc++);
          trace("LDY " + value.toString());
          this.yRegister = value;
          this.statusRegister.setStatus(value);
          this.cyclesRemaining = 1;
          break;
        }
        case 0xe8: {
          // INX
          trace("INX");
          this.xRegister = this.xRegister + 1;
          this.statusRegister.setStatus(this.xRegister);
          this.cyclesRemaining = 1;
          break;
        }
        case 0xc8: {
          // INY
          trace("INY");
          this.yRegister = this.yRegister + 1;
          this.statusRegister.setStatus(this.xRegister);
          this.cyclesRemaining = 1;
          break;
        }
        case 0xea: {
          // NOP
          trace("NOP");
          this.cyclesRemaining = 1;
          break;
        }
        case 0x88: {
          // DEY
          trace("DEY");
          this.yRegister = this.yRegister - 1;
          this.statusRegister.setStatus(this.yRegister);
          this.cyclesRemaining = 1;
          break;
        }
        case 0xd0: {
          // BNE
          const value: i8 = this.memory.read(this.pc++) as i8;
          trace("BNE " + value.toString());
          trace("status " + this.statusRegister.zero.toString());
          if (!this.statusRegister.zero) {
            this.pc += value;
            this.cyclesRemaining = 2;
          } else {
            this.cyclesRemaining = 1;
          }
          break;
        }
        case 0x4c: {
          // JMP
          const value: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          trace("JMP " + value.toString());
          this.pc = value;
          this.cyclesRemaining = 2;
          break;
        }
        default:
          trace("UNKNOWN OPCODE!!! " + opcode.toString());
          break;
      }
    }
  }
}
