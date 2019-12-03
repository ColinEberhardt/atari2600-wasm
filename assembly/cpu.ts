import Memory from "./memory";

//http://www.obelisk.me.uk/6502/reference.html
//http://nparker.llx.com/a2/opcodes.html

export class StatusRegister {
  zero: bool;
  negative: bool;
  carry: bool;

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

    trace(opcode.toString());

    switch (opcode) {
      case 0x69: {
        // ADC Immediate
        const value: u8 = this.memory.read(this.pc++);
        trace("ADC " + value.toString());
        this.accumulator += value;
        this.cyclesRemaining = 1;
        break;
      }
      case 0x65: {
        // ADC Zero Page
        const addr: u8 = this.memory.read(this.pc++);
        const value = this.memory.read(addr);
        trace("ADC addr=" + addr.toString() + ", value=" + value.toString());
        this.accumulator += value;
        this.cyclesRemaining = 2;
        break;
      }
      case 0x75: {
        // ADC Zero Page, X
        const addr: u8 = this.memory.read(this.pc++);
        const value = this.memory.read(addr + this.xRegister);
        trace("ADC addr=" + addr.toString() + ", value=" + value.toString());
        this.accumulator += value;
        this.cyclesRemaining = 3;
        break;
      }
      case 0x6d: {
        // ADC Absolute
        const addr: u32 =
          this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
        const value = this.memory.read(addr);
        trace("ADC addr=" + addr.toString() + ", value=" + value.toString());
        this.accumulator += value as u8;
        this.cyclesRemaining = 3;
        break;
      }
      case 0x7d: {
        // ADC Absolute, X
        const addr: u32 =
          this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
        const value = this.memory.read(addr + this.xRegister);
        trace("ADC ax addr=" + addr.toString() + ", value=" + value.toString());
        this.accumulator += value as u8;
        this.cyclesRemaining = 3 + (addr > 255 ? 1 : 0);
        break;
      }
      case 0x79: {
        // ADC Absolute, Y
        const addr: u32 =
          this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
        const value = this.memory.read(addr + this.yRegister);
        trace("ADC addr=" + addr.toString() + ", value=" + value.toString());
        this.accumulator += value as u8;
        this.cyclesRemaining = 3 + (addr > 255 ? 1 : 0);
        break;
      }
      case 0xa9: {
        // LDA Immediate
        const value: u8 = this.memory.read(this.pc++);
        trace("LDA " + value.toString());
        this.accumulator = value;
        this.statusRegister.setStatus(value);
        this.cyclesRemaining = 1;
        break;
      }
      case 0x4a: {
        // LSR Accumulator
        trace("LSR");
        const oldValue = this.accumulator;
        this.accumulator = this.accumulator >> 1;
        this.statusRegister.setStatusWithCarry(oldValue, this.accumulator);
        this.cyclesRemaining = 1;
        break;
      }
      case 0x85: {
        // STA Zero page
        const address: u8 = this.memory.read(this.pc++);
        trace("STA " + address.toString());
        this.memory.write(address, this.accumulator);
        this.cyclesRemaining = 2;
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
