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
          trace("ADC");
          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow =
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
            0x80
              ? 1
              : 0;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x65:
        /* ADC */ {
          trace("ADC");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow =
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
            0x80
              ? 1
              : 0;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0x75:
        /* ADC */ {
          trace("ADC");

          const addr: u32 = this.memory.read(this.pc++) + this.xRegister;
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow =
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
            0x80
              ? 1
              : 0;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x6d:
        /* ADC */ {
          trace("ADC");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow =
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
            0x80
              ? 1
              : 0;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x7d:
        /* ADC */ {
          trace("ADC");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow =
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
            0x80
              ? 1
              : 0;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + (pageCrossed ? 1 : 0);
        }
        break;

      case 0x79:
        /* ADC */ {
          trace("ADC");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow =
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
            0x80
              ? 1
              : 0;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + (pageCrossed ? 1 : 0);
        }
        break;

      case 0x29:
        /* AND */ {
          trace("AND");
          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x25:
        /* AND */ {
          trace("AND");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0x35:
        /* AND */ {
          trace("AND");

          const addr: u32 = this.memory.read(this.pc++) + this.xRegister;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x2d:
        /* AND */ {
          trace("AND");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x3d:
        /* AND */ {
          trace("AND");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + (pageCrossed ? 1 : 0);
        }
        break;

      case 0x39:
        /* AND */ {
          trace("AND");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + (pageCrossed ? 1 : 0);
        }
        break;

      case 0x0a:
        /* ASL */ {
          trace("ASL");
          const memval: u16 = this.accumulator;
          const result: u16 = memval << 1;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x06:
        /* ASL */ {
          trace("ASL");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval << 1;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0x16:
        /* ASL */ {
          trace("ASL");

          const addr: u32 = this.memory.read(this.pc++) + this.xRegister;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval << 1;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x0e:
        /* ASL */ {
          trace("ASL");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval << 1;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x1e:
        /* ASL */ {
          trace("ASL");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval << 1;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 6;
        }
        break;

      case 0x90:
        /* BCC */ {
          trace("BCC");
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
          trace("BCS");
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
          trace("BEQ");
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
          trace("BIT");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator & memval;
          this.statusRegister.overflow = (memval & 64) == 64 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = (memval & 128) == 128 ? 1 : 0;
          this.cyclesRemaining = 2;
        }
        break;

      case 0x2c:
        /* BIT */ {
          trace("BIT");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator & memval;
          this.statusRegister.overflow = (memval & 64) == 64 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = (memval & 128) == 128 ? 1 : 0;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x30:
        /* BMI */ {
          trace("BMI");
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
          trace("BNE");
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
          trace("BPL");
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
          trace("BVC");
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
          trace("BVS");
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
          trace("CLC");

          this.statusRegister.carry = 0;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xd8:
        /* CLD */ {
          trace("CLD");

          this.statusRegister.decimal = 0;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x58:
        /* CLI */ {
          trace("CLI");

          this.statusRegister.interrupt = 0;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xb8:
        /* CLV */ {
          trace("CLV");

          this.statusRegister.overflow = 0;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xc9:
        /* CMP */ {
          trace("CMP");
          const memval: u16 = this.memory.read(this.pc++);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = result >= 0 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = (result & 128) == 128 ? 1 : 0;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xc5:
        /* CMP */ {
          trace("CMP");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = result >= 0 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = (result & 128) == 128 ? 1 : 0;
          this.cyclesRemaining = 2;
        }
        break;

      case 0xd5:
        /* CMP */ {
          trace("CMP");

          const addr: u32 = this.memory.read(this.pc++) + this.xRegister;
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = result >= 0 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = (result & 128) == 128 ? 1 : 0;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xcd:
        /* CMP */ {
          trace("CMP");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = result >= 0 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = (result & 128) == 128 ? 1 : 0;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xdd:
        /* CMP */ {
          trace("CMP");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = result >= 0 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = (result & 128) == 128 ? 1 : 0;
          this.cyclesRemaining = 3 + (pageCrossed ? 1 : 0);
        }
        break;

      case 0xd9:
        /* CMP */ {
          trace("CMP");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = result >= 0 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = (result & 128) == 128 ? 1 : 0;
          this.cyclesRemaining = 3 + (pageCrossed ? 1 : 0);
        }
        break;

      case 0xe0:
        /* CPX */ {
          trace("CPX");
          const memval: u16 = this.memory.read(this.pc++);
          const result: i16 = this.xRegister - memval;
          this.statusRegister.carry = result >= 0 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = (result & 128) == 128 ? 1 : 0;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xe4:
        /* CPX */ {
          trace("CPX");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.xRegister - memval;
          this.statusRegister.carry = result >= 0 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = (result & 128) == 128 ? 1 : 0;
          this.cyclesRemaining = 2;
        }
        break;

      case 0xec:
        /* CPX */ {
          trace("CPX");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.xRegister - memval;
          this.statusRegister.carry = result >= 0 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = (result & 128) == 128 ? 1 : 0;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xc0:
        /* CPY */ {
          trace("CPY");
          const memval: u16 = this.memory.read(this.pc++);
          const result: i16 = this.yRegister - memval;
          this.statusRegister.carry = result >= 0 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = (result & 128) == 128 ? 1 : 0;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xc4:
        /* CPY */ {
          trace("CPY");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.yRegister - memval;
          this.statusRegister.carry = result >= 0 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = (result & 128) == 128 ? 1 : 0;
          this.cyclesRemaining = 2;
        }
        break;

      case 0xcc:
        /* CPY */ {
          trace("CPY");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.yRegister - memval;
          this.statusRegister.carry = result >= 0 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = (result & 128) == 128 ? 1 : 0;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xc6:
        /* DEC */ {
          trace("DEC");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval - 1;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0xd6:
        /* DEC */ {
          trace("DEC");

          const addr: u32 = this.memory.read(this.pc++) + this.xRegister;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval - 1;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0xce:
        /* DEC */ {
          trace("DEC");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval - 1;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0xde:
        /* DEC */ {
          trace("DEC");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval - 1;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 6;
        }
        break;

      case 0xca:
        /* DEX */ {
          trace("DEX");

          const result: u16 = this.xRegister - 1;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x88:
        /* DEY */ {
          trace("DEY");

          const result: u16 = this.yRegister - 1;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x49:
        /* EOR */ {
          trace("EOR");
          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x45:
        /* EOR */ {
          trace("EOR");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0x55:
        /* EOR */ {
          trace("EOR");

          const addr: u32 = this.memory.read(this.pc++) + this.xRegister;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x4d:
        /* EOR */ {
          trace("EOR");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x5d:
        /* EOR */ {
          trace("EOR");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + (pageCrossed ? 1 : 0);
        }
        break;

      case 0x59:
        /* EOR */ {
          trace("EOR");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + (pageCrossed ? 1 : 0);
        }
        break;

      case 0xe6:
        /* INC */ {
          trace("INC");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval + 1;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0xf6:
        /* INC */ {
          trace("INC");

          const addr: u32 = this.memory.read(this.pc++) + this.xRegister;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval + 1;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0xee:
        /* INC */ {
          trace("INC");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval + 1;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0xfe:
        /* INC */ {
          trace("INC");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval + 1;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 6;
        }
        break;

      case 0xe8:
        /* INX */ {
          trace("INX");

          const result: u16 = this.xRegister + 1;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xc8:
        /* INY */ {
          trace("INY");

          const result: u16 = this.yRegister + 1;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x4c:
        /* JMP */ {
          trace("JMP");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          this.cyclesRemaining = 2;
          this.pc = addr;
        }
        break;

      case 0x6c:
        /* JMP */ {
          trace("JMP");

          const addrref: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr: u32 =
            this.memory.read(addrref) + this.memory.read(addrref + 1) * 0x100;
          this.cyclesRemaining = 4;
          this.pc = addr;
        }
        break;

      case 0xa9:
        /* LDA */ {
          trace("LDA");
          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xa5:
        /* LDA */ {
          trace("LDA");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0xb5:
        /* LDA */ {
          trace("LDA");

          const addr: u32 = this.memory.read(this.pc++) + this.xRegister;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xad:
        /* LDA */ {
          trace("LDA");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xbd:
        /* LDA */ {
          trace("LDA");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + (pageCrossed ? 1 : 0);
        }
        break;

      case 0xb9:
        /* LDA */ {
          trace("LDA");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + (pageCrossed ? 1 : 0);
        }
        break;

      case 0xa2:
        /* LDX */ {
          trace("LDX");
          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xa6:
        /* LDX */ {
          trace("LDX");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0xb6:
        /* LDX */ {
          trace("LDX");

          const addr: u32 = this.memory.read(this.pc++) + this.yRegister;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xae:
        /* LDX */ {
          trace("LDX");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xbe:
        /* LDX */ {
          trace("LDX");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + (pageCrossed ? 1 : 0);
        }
        break;

      case 0xa0:
        /* LDY */ {
          trace("LDY");
          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xa4:
        /* LDY */ {
          trace("LDY");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0xb4:
        /* LDY */ {
          trace("LDY");

          const addr: u32 = this.memory.read(this.pc++) + this.xRegister;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xac:
        /* LDY */ {
          trace("LDY");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xbc:
        /* LDY */ {
          trace("LDY");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + (pageCrossed ? 1 : 0);
        }
        break;

      case 0x4a:
        /* LSR */ {
          trace("LSR");
          const memval: u16 = this.accumulator;
          const result: u16 = memval >> 1;
          this.statusRegister.carry = (memval & 1) == 1 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x46:
        /* LSR */ {
          trace("LSR");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval >> 1;
          this.statusRegister.carry = (memval & 1) == 1 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0x56:
        /* LSR */ {
          trace("LSR");

          const addr: u32 = this.memory.read(this.pc++) + this.xRegister;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval >> 1;
          this.statusRegister.carry = (memval & 1) == 1 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x4e:
        /* LSR */ {
          trace("LSR");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval >> 1;
          this.statusRegister.carry = (memval & 1) == 1 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x5e:
        /* LSR */ {
          trace("LSR");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval >> 1;
          this.statusRegister.carry = (memval & 1) == 1 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 6;
        }
        break;

      case 0xea:
        /* NOP */ {
          trace("NOP");

          this.cyclesRemaining = 1;
        }
        break;

      case 0x09:
        /* ORA */ {
          trace("ORA");
          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x05:
        /* ORA */ {
          trace("ORA");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0x15:
        /* ORA */ {
          trace("ORA");

          const addr: u32 = this.memory.read(this.pc++) + this.xRegister;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x0d:
        /* ORA */ {
          trace("ORA");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x1d:
        /* ORA */ {
          trace("ORA");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + (pageCrossed ? 1 : 0);
        }
        break;

      case 0x19:
        /* ORA */ {
          trace("ORA");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + (pageCrossed ? 1 : 0);
        }
        break;

      case 0x2a:
        /* ROL */ {
          trace("ROL");
          const memval: u16 = this.accumulator;
          const result: u16 = (memval << 1) + this.statusRegister.carry;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x26:
        /* ROL */ {
          trace("ROL");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval << 1) + this.statusRegister.carry;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0x36:
        /* ROL */ {
          trace("ROL");

          const addr: u32 = this.memory.read(this.pc++) + this.xRegister;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval << 1) + this.statusRegister.carry;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x2e:
        /* ROL */ {
          trace("ROL");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval << 1) + this.statusRegister.carry;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x3e:
        /* ROL */ {
          trace("ROL");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval << 1) + this.statusRegister.carry;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 6;
        }
        break;

      case 0x6a:
        /* ROR */ {
          trace("ROR");
          const memval: u16 = this.accumulator;
          const result: u16 = (memval >> 1) + this.statusRegister.carry * 0x80;
          this.statusRegister.carry = (memval & 1) == 1 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x66:
        /* ROR */ {
          trace("ROR");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval >> 1) + this.statusRegister.carry * 0x80;
          this.statusRegister.carry = (memval & 1) == 1 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0x76:
        /* ROR */ {
          trace("ROR");

          const addr: u32 = this.memory.read(this.pc++) + this.xRegister;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval >> 1) + this.statusRegister.carry * 0x80;
          this.statusRegister.carry = (memval & 1) == 1 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x6e:
        /* ROR */ {
          trace("ROR");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval >> 1) + this.statusRegister.carry * 0x80;
          this.statusRegister.carry = (memval & 1) == 1 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x7e:
        /* ROR */ {
          trace("ROR");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval >> 1) + this.statusRegister.carry * 0x80;
          this.statusRegister.carry = (memval & 1) == 1 ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 6;
        }
        break;

      case 0xe9:
        /* SBC */ {
          trace("SBC");
          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow =
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
            0x80
              ? 1
              : 0;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xe5:
        /* SBC */ {
          trace("SBC");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow =
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
            0x80
              ? 1
              : 0;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0xf5:
        /* SBC */ {
          trace("SBC");

          const addr: u32 = this.memory.read(this.pc++) + this.xRegister;
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow =
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
            0x80
              ? 1
              : 0;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xed:
        /* SBC */ {
          trace("SBC");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow =
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
            0x80
              ? 1
              : 0;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xfd:
        /* SBC */ {
          trace("SBC");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow =
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
            0x80
              ? 1
              : 0;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + (pageCrossed ? 1 : 0);
        }
        break;

      case 0xf9:
        /* SBC */ {
          trace("SBC");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow =
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
            0x80
              ? 1
              : 0;
          this.statusRegister.carry = result > 0xff ? 1 : 0;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + (pageCrossed ? 1 : 0);
        }
        break;

      case 0x38:
        /* SEC */ {
          trace("SEC");

          this.statusRegister.carry = 1;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xf8:
        /* SED */ {
          trace("SED");

          this.statusRegister.decimal = 1;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x78:
        /* SEI */ {
          trace("SEI");

          this.statusRegister.interrupt = 1;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x85:
        /* STA */ {
          trace("STA");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 2;
        }
        break;

      case 0x95:
        /* STA */ {
          trace("STA");

          const addr: u32 = this.memory.read(this.pc++) + this.xRegister;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 3;
        }
        break;

      case 0x8d:
        /* STA */ {
          trace("STA");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 3;
        }
        break;

      case 0x9d:
        /* STA */ {
          trace("STA");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
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
          trace("STA");

          const baseAddr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0x86:
        /* STX */ {
          trace("STX");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.xRegister;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 2;
        }
        break;

      case 0x96:
        /* STX */ {
          trace("STX");

          const addr: u32 = this.memory.read(this.pc++) + this.yRegister;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.xRegister;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 3;
        }
        break;

      case 0x8e:
        /* STX */ {
          trace("STX");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.xRegister;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 3;
        }
        break;

      case 0x84:
        /* STY */ {
          trace("STY");

          const addr: u32 = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.yRegister;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 2;
        }
        break;

      case 0x94:
        /* STY */ {
          trace("STY");

          const addr: u32 = this.memory.read(this.pc++) + this.xRegister;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.yRegister;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 3;
        }
        break;

      case 0x8c:
        /* STY */ {
          trace("STY");

          const addr: u32 =
            this.memory.read(this.pc++) + this.memory.read(this.pc++) * 0x100;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.yRegister;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 3;
        }
        break;

      case 0xaa:
        /* TAX */ {
          trace("TAX");

          const result: u16 = this.accumulator;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xa8:
        /* TAY */ {
          trace("TAY");

          const result: u16 = this.accumulator;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x8a:
        /* TXA */ {
          trace("TXA");

          const result: u16 = this.xRegister;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x98:
        /* TYA */ {
          trace("TYA");

          const result: u16 = this.yRegister;
          this.statusRegister.zero = result === 0 ? 1 : 0;
          this.statusRegister.negative = result !== 0 ? 1 : 0;
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
