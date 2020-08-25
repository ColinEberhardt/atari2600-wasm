import Memory from "./memory";

export class StatusRegister {
  carry: u8;
  overflow: u8;
  negative: u8;
  zero: u8;
  interrupt: u8;
  decimal: u8;
  constructor() {}
}

const boolToInt = (value: boolean): u8 => (value ? 1 : 0);

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

    switch (opcode) {
      case 0x69:
        /* ADC */ {
          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow = boolToInt(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x65:
        /* ADC */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow = boolToInt(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0x75:
        /* ADC */ {
          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow = boolToInt(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x6d:
        /* ADC */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow = boolToInt(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x7d:
        /* ADC */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow = boolToInt(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + boolToInt(pageCrossed);
        }
        break;

      case 0x79:
        /* ADC */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval = this.memory.read(addr);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow = boolToInt(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + boolToInt(pageCrossed);
        }
        break;

      case 0x61:
        /* ADC */ {
          const indirectAddr =
            (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const addr = this.memory.readWord(indirectAddr);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow = boolToInt(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 5;
        }
        break;

      case 0x71:
        /* ADC */ {
          const operand = this.memory.read(this.pc++);
          const addr = this.memory.readWord(operand);
          const pageCrossed =
            Math.floor(addr / 256) != Math.floor((addr + this.yRegister) / 256);
          const memval: u16 = this.memory.read(addr + this.yRegister);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow = boolToInt(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 4 + boolToInt(pageCrossed);
        }
        break;

      case 0x29:
        /* AND */ {
          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x25:
        /* AND */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0x35:
        /* AND */ {
          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x2d:
        /* AND */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x3d:
        /* AND */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + boolToInt(pageCrossed);
        }
        break;

      case 0x39:
        /* AND */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval = this.memory.read(addr);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + boolToInt(pageCrossed);
        }
        break;

      case 0x21:
        /* AND */ {
          const indirectAddr =
            (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const addr = this.memory.readWord(indirectAddr);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 5;
        }
        break;

      case 0x31:
        /* AND */ {
          const operand = this.memory.read(this.pc++);
          const addr = this.memory.readWord(operand);
          const pageCrossed =
            Math.floor(addr / 256) != Math.floor((addr + this.yRegister) / 256);
          const memval: u16 = this.memory.read(addr + this.yRegister);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 4 + boolToInt(pageCrossed);
        }
        break;

      case 0x0a:
        /* ASL */ {
          const memval: u16 = this.accumulator;
          const result: u16 = memval << 1;
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x06:
        /* ASL */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval << 1;
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0x16:
        /* ASL */ {
          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval << 1;
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x0e:
        /* ASL */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval << 1;
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x1e:
        /* ASL */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval << 1;
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 6;
        }
        break;

      case 0x90:
        /* BCC */ {
          const offset: i16 = this.memory.read(this.pc++);
          this.cyclesRemaining = 1;
          if (this.statusRegister.carry == 0) {
            const previousPC = this.pc;
            this.pc += (offset & 127) - (offset & 128);
            this.cyclesRemaining +=
              Math.floor(previousPC / 256) == Math.floor(this.pc / 256) ? 1 : 2;
          }
        }
        break;

      case 0xb0:
        /* BCS */ {
          const offset: i16 = this.memory.read(this.pc++);
          this.cyclesRemaining = 1;
          if (this.statusRegister.carry == 1) {
            const previousPC = this.pc;
            this.pc += (offset & 127) - (offset & 128);
            this.cyclesRemaining +=
              Math.floor(previousPC / 256) == Math.floor(this.pc / 256) ? 1 : 2;
          }
        }
        break;

      case 0xf0:
        /* BEQ */ {
          const offset: i16 = this.memory.read(this.pc++);
          this.cyclesRemaining = 1;
          if (this.statusRegister.zero == 1) {
            const previousPC = this.pc;
            this.pc += (offset & 127) - (offset & 128);
            this.cyclesRemaining +=
              Math.floor(previousPC / 256) == Math.floor(this.pc / 256) ? 1 : 2;
          }
        }
        break;

      case 0x24:
        /* BIT */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator & memval;
          this.statusRegister.overflow = boolToInt((memval & 64) == 64);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt((memval & 128) == 128);
          this.cyclesRemaining = 2;
        }
        break;

      case 0x2c:
        /* BIT */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator & memval;
          this.statusRegister.overflow = boolToInt((memval & 64) == 64);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt((memval & 128) == 128);
          this.cyclesRemaining = 3;
        }
        break;

      case 0x30:
        /* BMI */ {
          const offset: i16 = this.memory.read(this.pc++);
          this.cyclesRemaining = 1;
          if (this.statusRegister.negative == 1) {
            const previousPC = this.pc;
            this.pc += (offset & 127) - (offset & 128);
            this.cyclesRemaining +=
              Math.floor(previousPC / 256) == Math.floor(this.pc / 256) ? 1 : 2;
          }
        }
        break;

      case 0xd0:
        /* BNE */ {
          const offset: i16 = this.memory.read(this.pc++);
          this.cyclesRemaining = 1;
          if (this.statusRegister.zero == 0) {
            const previousPC = this.pc;
            this.pc += (offset & 127) - (offset & 128);
            this.cyclesRemaining +=
              Math.floor(previousPC / 256) == Math.floor(this.pc / 256) ? 1 : 2;
          }
        }
        break;

      case 0x10:
        /* BPL */ {
          const offset: i16 = this.memory.read(this.pc++);
          this.cyclesRemaining = 1;
          if (this.statusRegister.negative == 0) {
            const previousPC = this.pc;
            this.pc += (offset & 127) - (offset & 128);
            this.cyclesRemaining +=
              Math.floor(previousPC / 256) == Math.floor(this.pc / 256) ? 1 : 2;
          }
        }
        break;

      case 0x50:
        /* BVC */ {
          const offset: i16 = this.memory.read(this.pc++);
          this.cyclesRemaining = 1;
          if (this.statusRegister.overflow == 0) {
            const previousPC = this.pc;
            this.pc += (offset & 127) - (offset & 128);
            this.cyclesRemaining +=
              Math.floor(previousPC / 256) == Math.floor(this.pc / 256) ? 1 : 2;
          }
        }
        break;

      case 0x70:
        /* BVS */ {
          const offset: i16 = this.memory.read(this.pc++);
          this.cyclesRemaining = 1;
          if (this.statusRegister.overflow == 1) {
            const previousPC = this.pc;
            this.pc += (offset & 127) - (offset & 128);
            this.cyclesRemaining +=
              Math.floor(previousPC / 256) == Math.floor(this.pc / 256) ? 1 : 2;
          }
        }
        break;

      case 0x18:
        /* CLC */ {
          this.statusRegister.carry = 0;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xd8:
        /* CLD */ {
          this.statusRegister.decimal = 0;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x58:
        /* CLI */ {
          this.statusRegister.interrupt = 0;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xb8:
        /* CLV */ {
          this.statusRegister.overflow = 0;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xc9:
        /* CMP */ {
          const memval: u16 = this.memory.read(this.pc++);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = boolToInt(result >= 0);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt((result & 128) === 128);
          this.cyclesRemaining = 1;
        }
        break;

      case 0xc5:
        /* CMP */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = boolToInt(result >= 0);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt((result & 128) === 128);
          this.cyclesRemaining = 2;
        }
        break;

      case 0xd5:
        /* CMP */ {
          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = boolToInt(result >= 0);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt((result & 128) === 128);
          this.cyclesRemaining = 3;
        }
        break;

      case 0xcd:
        /* CMP */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = boolToInt(result >= 0);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt((result & 128) === 128);
          this.cyclesRemaining = 3;
        }
        break;

      case 0xdd:
        /* CMP */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = boolToInt(result >= 0);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt((result & 128) === 128);
          this.cyclesRemaining = 3 + boolToInt(pageCrossed);
        }
        break;

      case 0xd9:
        /* CMP */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval = this.memory.read(addr);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = boolToInt(result >= 0);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt((result & 128) === 128);
          this.cyclesRemaining = 3 + boolToInt(pageCrossed);
        }
        break;

      case 0xc1:
        /* CMP */ {
          const indirectAddr =
            (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const addr = this.memory.readWord(indirectAddr);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = boolToInt(result >= 0);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt((result & 128) === 128);
          this.cyclesRemaining = 5;
        }
        break;

      case 0xd1:
        /* CMP */ {
          const operand = this.memory.read(this.pc++);
          const addr = this.memory.readWord(operand);
          const pageCrossed =
            Math.floor(addr / 256) != Math.floor((addr + this.yRegister) / 256);
          const memval: u16 = this.memory.read(addr + this.yRegister);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = boolToInt(result >= 0);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt((result & 128) === 128);
          this.cyclesRemaining = 4 + boolToInt(pageCrossed);
        }
        break;

      case 0xe0:
        /* CPX */ {
          const memval: u16 = this.memory.read(this.pc++);
          const result: i16 = this.xRegister - memval;
          this.statusRegister.carry = boolToInt(result >= 0);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt((result & 128) === 128);
          this.cyclesRemaining = 1;
        }
        break;

      case 0xe4:
        /* CPX */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.xRegister - memval;
          this.statusRegister.carry = boolToInt(result >= 0);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt((result & 128) === 128);
          this.cyclesRemaining = 2;
        }
        break;

      case 0xec:
        /* CPX */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.xRegister - memval;
          this.statusRegister.carry = boolToInt(result >= 0);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt((result & 128) === 128);
          this.cyclesRemaining = 3;
        }
        break;

      case 0xc0:
        /* CPY */ {
          const memval: u16 = this.memory.read(this.pc++);
          const result: i16 = this.yRegister - memval;
          this.statusRegister.carry = boolToInt(result >= 0);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt((result & 128) === 128);
          this.cyclesRemaining = 1;
        }
        break;

      case 0xc4:
        /* CPY */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.yRegister - memval;
          this.statusRegister.carry = boolToInt(result >= 0);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt((result & 128) === 128);
          this.cyclesRemaining = 2;
        }
        break;

      case 0xcc:
        /* CPY */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.yRegister - memval;
          this.statusRegister.carry = boolToInt(result >= 0);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt((result & 128) === 128);
          this.cyclesRemaining = 3;
        }
        break;

      case 0xc6:
        /* DEC */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval - 1;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0xd6:
        /* DEC */ {
          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval - 1;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0xce:
        /* DEC */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval - 1;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0xde:
        /* DEC */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval - 1;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 6;
        }
        break;

      case 0xca:
        /* DEX */ {
          const result: u16 = this.xRegister - 1;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x88:
        /* DEY */ {
          const result: u16 = this.yRegister - 1;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x49:
        /* EOR */ {
          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x45:
        /* EOR */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0x55:
        /* EOR */ {
          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x4d:
        /* EOR */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x5d:
        /* EOR */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + boolToInt(pageCrossed);
        }
        break;

      case 0x59:
        /* EOR */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval = this.memory.read(addr);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + boolToInt(pageCrossed);
        }
        break;

      case 0x41:
        /* EOR */ {
          const indirectAddr =
            (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const addr = this.memory.readWord(indirectAddr);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 5;
        }
        break;

      case 0x51:
        /* EOR */ {
          const operand = this.memory.read(this.pc++);
          const addr = this.memory.readWord(operand);
          const pageCrossed =
            Math.floor(addr / 256) != Math.floor((addr + this.yRegister) / 256);
          const memval: u16 = this.memory.read(addr + this.yRegister);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 4 + boolToInt(pageCrossed);
        }
        break;

      case 0xe6:
        /* INC */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval + 1;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0xf6:
        /* INC */ {
          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval + 1;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0xee:
        /* INC */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval + 1;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0xfe:
        /* INC */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval + 1;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 6;
        }
        break;

      case 0xe8:
        /* INX */ {
          const result: u16 = this.xRegister + 1;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xc8:
        /* INY */ {
          const result: u16 = this.yRegister + 1;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x4c:
        /* JMP */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          this.cyclesRemaining = 2;
          this.pc = addr;
        }
        break;

      case 0x6c:
        /* JMP */ {
          const addrref = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = this.memory.readWord(addrref);
          this.cyclesRemaining = 4;
          this.pc = addr;
        }
        break;

      case 0xa9:
        /* LDA */ {
          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xa5:
        /* LDA */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0xb5:
        /* LDA */ {
          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xad:
        /* LDA */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xbd:
        /* LDA */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + boolToInt(pageCrossed);
        }
        break;

      case 0xb9:
        /* LDA */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + boolToInt(pageCrossed);
        }
        break;

      case 0xa1:
        /* LDA */ {
          const indirectAddr =
            (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const addr = this.memory.readWord(indirectAddr);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 5;
        }
        break;

      case 0xb1:
        /* LDA */ {
          const operand = this.memory.read(this.pc++);
          const addr = this.memory.readWord(operand);
          const pageCrossed =
            Math.floor(addr / 256) != Math.floor((addr + this.yRegister) / 256);
          const memval: u16 = this.memory.read(addr + this.yRegister);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 4 + boolToInt(pageCrossed);
        }
        break;

      case 0xa2:
        /* LDX */ {
          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xa6:
        /* LDX */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0xb6:
        /* LDX */ {
          const addr = (this.memory.read(this.pc++) + this.yRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xae:
        /* LDX */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xbe:
        /* LDX */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + boolToInt(pageCrossed);
        }
        break;

      case 0xa0:
        /* LDY */ {
          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xa4:
        /* LDY */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0xb4:
        /* LDY */ {
          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xac:
        /* LDY */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xbc:
        /* LDY */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + boolToInt(pageCrossed);
        }
        break;

      case 0x4a:
        /* LSR */ {
          const memval: u16 = this.accumulator;
          const result: u16 = memval >> 1;
          this.statusRegister.carry = boolToInt((memval & 1) == 1);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x46:
        /* LSR */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval >> 1;
          this.statusRegister.carry = boolToInt((memval & 1) == 1);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0x56:
        /* LSR */ {
          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval >> 1;
          this.statusRegister.carry = boolToInt((memval & 1) == 1);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x4e:
        /* LSR */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval >> 1;
          this.statusRegister.carry = boolToInt((memval & 1) == 1);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x5e:
        /* LSR */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval >> 1;
          this.statusRegister.carry = boolToInt((memval & 1) == 1);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 6;
        }
        break;

      case 0xea:
        /* NOP */ {
          this.cyclesRemaining = 1;
        }
        break;

      case 0x09:
        /* ORA */ {
          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x05:
        /* ORA */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0x15:
        /* ORA */ {
          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x0d:
        /* ORA */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x1d:
        /* ORA */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + boolToInt(pageCrossed);
        }
        break;

      case 0x19:
        /* ORA */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval = this.memory.read(addr);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + boolToInt(pageCrossed);
        }
        break;

      case 0x01:
        /* ORA */ {
          const indirectAddr =
            (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const addr = this.memory.readWord(indirectAddr);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 5;
        }
        break;

      case 0x11:
        /* ORA */ {
          const operand = this.memory.read(this.pc++);
          const addr = this.memory.readWord(operand);
          const pageCrossed =
            Math.floor(addr / 256) != Math.floor((addr + this.yRegister) / 256);
          const memval: u16 = this.memory.read(addr + this.yRegister);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 4 + boolToInt(pageCrossed);
        }
        break;

      case 0x2a:
        /* ROL */ {
          const memval: u16 = this.accumulator;
          const result: u16 = (memval << 1) + this.statusRegister.carry;
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x26:
        /* ROL */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval << 1) + this.statusRegister.carry;
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0x36:
        /* ROL */ {
          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval << 1) + this.statusRegister.carry;
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x2e:
        /* ROL */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval << 1) + this.statusRegister.carry;
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x3e:
        /* ROL */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval << 1) + this.statusRegister.carry;
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 6;
        }
        break;

      case 0x6a:
        /* ROR */ {
          const memval: u16 = this.accumulator;
          const result: u16 = (memval >> 1) + this.statusRegister.carry * 0x80;
          this.statusRegister.carry = boolToInt((memval & 1) == 1);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x66:
        /* ROR */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval >> 1) + this.statusRegister.carry * 0x80;
          this.statusRegister.carry = boolToInt((memval & 1) == 1);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0x76:
        /* ROR */ {
          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval >> 1) + this.statusRegister.carry * 0x80;
          this.statusRegister.carry = boolToInt((memval & 1) == 1);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x6e:
        /* ROR */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval >> 1) + this.statusRegister.carry * 0x80;
          this.statusRegister.carry = boolToInt((memval & 1) == 1);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x7e:
        /* ROR */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval >> 1) + this.statusRegister.carry * 0x80;
          this.statusRegister.carry = boolToInt((memval & 1) == 1);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 6;
        }
        break;

      case 0xe9:
        /* SBC */ {
          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow = boolToInt(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xe5:
        /* SBC */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow = boolToInt(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0xf5:
        /* SBC */ {
          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow = boolToInt(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xed:
        /* SBC */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow = boolToInt(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xfd:
        /* SBC */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow = boolToInt(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + boolToInt(pageCrossed);
        }
        break;

      case 0xf9:
        /* SBC */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval = this.memory.read(addr);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow = boolToInt(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + boolToInt(pageCrossed);
        }
        break;

      case 0xe1:
        /* SBC */ {
          const indirectAddr =
            (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const addr = this.memory.readWord(indirectAddr);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow = boolToInt(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 5;
        }
        break;

      case 0xf1:
        /* SBC */ {
          const operand = this.memory.read(this.pc++);
          const addr = this.memory.readWord(operand);
          const pageCrossed =
            Math.floor(addr / 256) != Math.floor((addr + this.yRegister) / 256);
          const memval: u16 = this.memory.read(addr + this.yRegister);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow = boolToInt(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = boolToInt(result > 0xff);
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 4 + boolToInt(pageCrossed);
        }
        break;

      case 0x38:
        /* SEC */ {
          this.statusRegister.carry = 1;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xf8:
        /* SED */ {
          this.statusRegister.decimal = 1;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x78:
        /* SEI */ {
          this.statusRegister.interrupt = 1;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x85:
        /* STA */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 2;
        }
        break;

      case 0x95:
        /* STA */ {
          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 3;
        }
        break;

      case 0x8d:
        /* STA */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 3;
        }
        break;

      case 0x9d:
        /* STA */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0x99:
        /* STA */ {
          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval = this.memory.read(addr);
          const result: u16 = this.accumulator;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0x81:
        /* STA */ {
          const indirectAddr =
            (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const addr = this.memory.readWord(indirectAddr);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x91:
        /* STA */ {
          const operand = this.memory.read(this.pc++);
          const addr = this.memory.readWord(operand);
          const pageCrossed =
            Math.floor(addr / 256) != Math.floor((addr + this.yRegister) / 256);
          const memval: u16 = this.memory.read(addr + this.yRegister);
          const result: u16 = this.accumulator;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x86:
        /* STX */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.xRegister;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 2;
        }
        break;

      case 0x96:
        /* STX */ {
          const addr = (this.memory.read(this.pc++) + this.yRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.xRegister;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 3;
        }
        break;

      case 0x8e:
        /* STX */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.xRegister;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 3;
        }
        break;

      case 0x84:
        /* STY */ {
          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.yRegister;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 2;
        }
        break;

      case 0x94:
        /* STY */ {
          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.yRegister;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 3;
        }
        break;

      case 0x8c:
        /* STY */ {
          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.yRegister;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 3;
        }
        break;

      case 0xaa:
        /* TAX */ {
          const result: u16 = this.accumulator;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xa8:
        /* TAY */ {
          const result: u16 = this.accumulator;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x8a:
        /* TXA */ {
          const result: u16 = this.xRegister;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x98:
        /* TYA */ {
          const result: u16 = this.yRegister;
          this.statusRegister.zero = boolToInt(result === 0);
          this.statusRegister.negative = boolToInt(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      default:
        trace("unrecognised opcode " + opcode.toString());
        break;
    }
  }
}
