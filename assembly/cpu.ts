import Memory from "./memory";
import StatusRegister from "./statusRegister";

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
          trace("[CPU] ADC");

          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow = u8(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x65:
        /* ADC */ {
          trace("[CPU] ADC");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow = u8(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0x75:
        /* ADC */ {
          trace("[CPU] ADC");

          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow = u8(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x6d:
        /* ADC */ {
          trace("[CPU] ADC");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow = u8(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x7d:
        /* ADC */ {
          trace("[CPU] ADC");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow = u8(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + u8(pageCrossed);
        }
        break;

      case 0x79:
        /* ADC */ {
          trace("[CPU] ADC");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval = this.memory.read(addr);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow = u8(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + u8(pageCrossed);
        }
        break;

      case 0x61:
        /* ADC */ {
          trace("[CPU] ADC");

          const indirectAddr =
            (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const addr = this.memory.readWord(indirectAddr);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow = u8(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 5;
        }
        break;

      case 0x71:
        /* ADC */ {
          trace("[CPU] ADC");

          const operand = this.memory.read(this.pc++);
          const addr = this.memory.readWord(operand);
          const pageCrossed =
            Math.floor(addr / 256) != Math.floor((addr + this.yRegister) / 256);
          const memval: u16 = this.memory.read(addr + this.yRegister);
          const result: u16 =
            this.accumulator + memval + this.statusRegister.carry;
          this.statusRegister.overflow = u8(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 4 + u8(pageCrossed);
        }
        break;

      case 0x29:
        /* AND */ {
          trace("[CPU] AND");

          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x25:
        /* AND */ {
          trace("[CPU] AND");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0x35:
        /* AND */ {
          trace("[CPU] AND");

          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x2d:
        /* AND */ {
          trace("[CPU] AND");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x3d:
        /* AND */ {
          trace("[CPU] AND");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + u8(pageCrossed);
        }
        break;

      case 0x39:
        /* AND */ {
          trace("[CPU] AND");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval = this.memory.read(addr);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + u8(pageCrossed);
        }
        break;

      case 0x21:
        /* AND */ {
          trace("[CPU] AND");

          const indirectAddr =
            (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const addr = this.memory.readWord(indirectAddr);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 5;
        }
        break;

      case 0x31:
        /* AND */ {
          trace("[CPU] AND");

          const operand = this.memory.read(this.pc++);
          const addr = this.memory.readWord(operand);
          const pageCrossed =
            Math.floor(addr / 256) != Math.floor((addr + this.yRegister) / 256);
          const memval: u16 = this.memory.read(addr + this.yRegister);
          const result: u16 = this.accumulator & memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 4 + u8(pageCrossed);
        }
        break;

      case 0x0a:
        /* ASL */ {
          trace("[CPU] ASL");

          const memval: u16 = this.accumulator;
          const result: u16 = memval << 1;
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x06:
        /* ASL */ {
          trace("[CPU] ASL");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval << 1;
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0x16:
        /* ASL */ {
          trace("[CPU] ASL");

          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval << 1;
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x0e:
        /* ASL */ {
          trace("[CPU] ASL");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval << 1;
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x1e:
        /* ASL */ {
          trace("[CPU] ASL");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval << 1;
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
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
          trace("[CPU] BIT");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator & memval;
          this.statusRegister.overflow = u8((memval & 64) == 64);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8((memval & 128) == 128);
          this.cyclesRemaining = 2;
        }
        break;

      case 0x2c:
        /* BIT */ {
          trace("[CPU] BIT");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator & memval;
          this.statusRegister.overflow = u8((memval & 64) == 64);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8((memval & 128) == 128);
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
          trace("[CPU] CLC");

          this.statusRegister.carry = 0;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xd8:
        /* CLD */ {
          trace("[CPU] CLD");

          this.statusRegister.decimal = 0;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x58:
        /* CLI */ {
          trace("[CPU] CLI");

          this.statusRegister.interrupt = 0;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xb8:
        /* CLV */ {
          trace("[CPU] CLV");

          this.statusRegister.overflow = 0;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xc9:
        /* CMP */ {
          trace("[CPU] CMP");

          const memval: u16 = this.memory.read(this.pc++);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = u8(result >= 0);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8((result & 128) === 128);
          this.cyclesRemaining = 1;
        }
        break;

      case 0xc5:
        /* CMP */ {
          trace("[CPU] CMP");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = u8(result >= 0);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8((result & 128) === 128);
          this.cyclesRemaining = 2;
        }
        break;

      case 0xd5:
        /* CMP */ {
          trace("[CPU] CMP");

          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = u8(result >= 0);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8((result & 128) === 128);
          this.cyclesRemaining = 3;
        }
        break;

      case 0xcd:
        /* CMP */ {
          trace("[CPU] CMP");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = u8(result >= 0);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8((result & 128) === 128);
          this.cyclesRemaining = 3;
        }
        break;

      case 0xdd:
        /* CMP */ {
          trace("[CPU] CMP");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = u8(result >= 0);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8((result & 128) === 128);
          this.cyclesRemaining = 3 + u8(pageCrossed);
        }
        break;

      case 0xd9:
        /* CMP */ {
          trace("[CPU] CMP");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval = this.memory.read(addr);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = u8(result >= 0);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8((result & 128) === 128);
          this.cyclesRemaining = 3 + u8(pageCrossed);
        }
        break;

      case 0xc1:
        /* CMP */ {
          trace("[CPU] CMP");

          const indirectAddr =
            (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const addr = this.memory.readWord(indirectAddr);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = u8(result >= 0);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8((result & 128) === 128);
          this.cyclesRemaining = 5;
        }
        break;

      case 0xd1:
        /* CMP */ {
          trace("[CPU] CMP");

          const operand = this.memory.read(this.pc++);
          const addr = this.memory.readWord(operand);
          const pageCrossed =
            Math.floor(addr / 256) != Math.floor((addr + this.yRegister) / 256);
          const memval: u16 = this.memory.read(addr + this.yRegister);
          const result: i16 = this.accumulator - memval;
          this.statusRegister.carry = u8(result >= 0);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8((result & 128) === 128);
          this.cyclesRemaining = 4 + u8(pageCrossed);
        }
        break;

      case 0xe0:
        /* CPX */ {
          trace("[CPU] CPX");

          const memval: u16 = this.memory.read(this.pc++);
          const result: i16 = this.xRegister - memval;
          this.statusRegister.carry = u8(result >= 0);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8((result & 128) === 128);
          this.cyclesRemaining = 1;
        }
        break;

      case 0xe4:
        /* CPX */ {
          trace("[CPU] CPX");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.xRegister - memval;
          this.statusRegister.carry = u8(result >= 0);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8((result & 128) === 128);
          this.cyclesRemaining = 2;
        }
        break;

      case 0xec:
        /* CPX */ {
          trace("[CPU] CPX");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.xRegister - memval;
          this.statusRegister.carry = u8(result >= 0);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8((result & 128) === 128);
          this.cyclesRemaining = 3;
        }
        break;

      case 0xc0:
        /* CPY */ {
          trace("[CPU] CPY");

          const memval: u16 = this.memory.read(this.pc++);
          const result: i16 = this.yRegister - memval;
          this.statusRegister.carry = u8(result >= 0);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8((result & 128) === 128);
          this.cyclesRemaining = 1;
        }
        break;

      case 0xc4:
        /* CPY */ {
          trace("[CPU] CPY");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.yRegister - memval;
          this.statusRegister.carry = u8(result >= 0);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8((result & 128) === 128);
          this.cyclesRemaining = 2;
        }
        break;

      case 0xcc:
        /* CPY */ {
          trace("[CPU] CPY");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: i16 = this.yRegister - memval;
          this.statusRegister.carry = u8(result >= 0);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8((result & 128) === 128);
          this.cyclesRemaining = 3;
        }
        break;

      case 0xc6:
        /* DEC */ {
          trace("[CPU] DEC");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval - 1;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0xd6:
        /* DEC */ {
          trace("[CPU] DEC");

          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval - 1;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0xce:
        /* DEC */ {
          trace("[CPU] DEC");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval - 1;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0xde:
        /* DEC */ {
          trace("[CPU] DEC");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval - 1;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 6;
        }
        break;

      case 0xca:
        /* DEX */ {
          trace("[CPU] DEX");

          const result: u16 = this.xRegister - 1;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x88:
        /* DEY */ {
          trace("[CPU] DEY");

          const result: u16 = this.yRegister - 1;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x49:
        /* EOR */ {
          trace("[CPU] EOR");

          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x45:
        /* EOR */ {
          trace("[CPU] EOR");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0x55:
        /* EOR */ {
          trace("[CPU] EOR");

          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x4d:
        /* EOR */ {
          trace("[CPU] EOR");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x5d:
        /* EOR */ {
          trace("[CPU] EOR");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + u8(pageCrossed);
        }
        break;

      case 0x59:
        /* EOR */ {
          trace("[CPU] EOR");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval = this.memory.read(addr);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + u8(pageCrossed);
        }
        break;

      case 0x41:
        /* EOR */ {
          trace("[CPU] EOR");

          const indirectAddr =
            (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const addr = this.memory.readWord(indirectAddr);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 5;
        }
        break;

      case 0x51:
        /* EOR */ {
          trace("[CPU] EOR");

          const operand = this.memory.read(this.pc++);
          const addr = this.memory.readWord(operand);
          const pageCrossed =
            Math.floor(addr / 256) != Math.floor((addr + this.yRegister) / 256);
          const memval: u16 = this.memory.read(addr + this.yRegister);
          const result: u16 = this.accumulator ^ memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 4 + u8(pageCrossed);
        }
        break;

      case 0xe6:
        /* INC */ {
          trace("[CPU] INC");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval + 1;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0xf6:
        /* INC */ {
          trace("[CPU] INC");

          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval + 1;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0xee:
        /* INC */ {
          trace("[CPU] INC");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval + 1;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0xfe:
        /* INC */ {
          trace("[CPU] INC");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval + 1;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 6;
        }
        break;

      case 0xe8:
        /* INX */ {
          trace("[CPU] INX");

          const result: u16 = this.xRegister + 1;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xc8:
        /* INY */ {
          trace("[CPU] INY");

          const result: u16 = this.yRegister + 1;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x4c:
        /* JMP */ {
          trace("[CPU] JMP");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          this.pc = addr;
          this.cyclesRemaining = 2;
        }
        break;

      case 0x6c:
        /* JMP */ {
          trace("[CPU] JMP");

          const addrref = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = this.memory.readWord(addrref);
          this.pc = addr;
          this.cyclesRemaining = 4;
        }
        break;

      case 0xa9:
        /* LDA */ {
          trace("[CPU] LDA");

          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xa5:
        /* LDA */ {
          trace("[CPU] LDA");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0xb5:
        /* LDA */ {
          trace("[CPU] LDA");

          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xad:
        /* LDA */ {
          trace("[CPU] LDA");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xbd:
        /* LDA */ {
          trace("[CPU] LDA");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + u8(pageCrossed);
        }
        break;

      case 0xb9:
        /* LDA */ {
          trace("[CPU] LDA");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + u8(pageCrossed);
        }
        break;

      case 0xa1:
        /* LDA */ {
          trace("[CPU] LDA");

          const indirectAddr =
            (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const addr = this.memory.readWord(indirectAddr);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 5;
        }
        break;

      case 0xb1:
        /* LDA */ {
          trace("[CPU] LDA");

          const operand = this.memory.read(this.pc++);
          const addr = this.memory.readWord(operand);
          const pageCrossed =
            Math.floor(addr / 256) != Math.floor((addr + this.yRegister) / 256);
          const memval: u16 = this.memory.read(addr + this.yRegister);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 4 + u8(pageCrossed);
        }
        break;

      case 0xa2:
        /* LDX */ {
          trace("[CPU] LDX");

          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xa6:
        /* LDX */ {
          trace("[CPU] LDX");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0xb6:
        /* LDX */ {
          trace("[CPU] LDX");

          const addr = (this.memory.read(this.pc++) + this.yRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xae:
        /* LDX */ {
          trace("[CPU] LDX");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xbe:
        /* LDX */ {
          trace("[CPU] LDX");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + u8(pageCrossed);
        }
        break;

      case 0xa0:
        /* LDY */ {
          trace("[CPU] LDY");

          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xa4:
        /* LDY */ {
          trace("[CPU] LDY");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0xb4:
        /* LDY */ {
          trace("[CPU] LDY");

          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xac:
        /* LDY */ {
          trace("[CPU] LDY");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xbc:
        /* LDY */ {
          trace("[CPU] LDY");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + u8(pageCrossed);
        }
        break;

      case 0x4a:
        /* LSR */ {
          trace("[CPU] LSR");

          const memval: u16 = this.accumulator;
          const result: u16 = memval >> 1;
          this.statusRegister.carry = u8((memval & 1) == 1);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x46:
        /* LSR */ {
          trace("[CPU] LSR");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval >> 1;
          this.statusRegister.carry = u8((memval & 1) == 1);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0x56:
        /* LSR */ {
          trace("[CPU] LSR");

          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval >> 1;
          this.statusRegister.carry = u8((memval & 1) == 1);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x4e:
        /* LSR */ {
          trace("[CPU] LSR");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval >> 1;
          this.statusRegister.carry = u8((memval & 1) == 1);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x5e:
        /* LSR */ {
          trace("[CPU] LSR");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = memval >> 1;
          this.statusRegister.carry = u8((memval & 1) == 1);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 6;
        }
        break;

      case 0xea:
        /* NOP */ {
          trace("[CPU] NOP");

          this.cyclesRemaining = 1;
        }
        break;

      case 0x09:
        /* ORA */ {
          trace("[CPU] ORA");

          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x05:
        /* ORA */ {
          trace("[CPU] ORA");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0x15:
        /* ORA */ {
          trace("[CPU] ORA");

          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x0d:
        /* ORA */ {
          trace("[CPU] ORA");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x1d:
        /* ORA */ {
          trace("[CPU] ORA");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + u8(pageCrossed);
        }
        break;

      case 0x19:
        /* ORA */ {
          trace("[CPU] ORA");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval = this.memory.read(addr);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + u8(pageCrossed);
        }
        break;

      case 0x01:
        /* ORA */ {
          trace("[CPU] ORA");

          const indirectAddr =
            (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const addr = this.memory.readWord(indirectAddr);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 5;
        }
        break;

      case 0x11:
        /* ORA */ {
          trace("[CPU] ORA");

          const operand = this.memory.read(this.pc++);
          const addr = this.memory.readWord(operand);
          const pageCrossed =
            Math.floor(addr / 256) != Math.floor((addr + this.yRegister) / 256);
          const memval: u16 = this.memory.read(addr + this.yRegister);
          const result: u16 = this.accumulator | memval;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 4 + u8(pageCrossed);
        }
        break;

      case 0x48:
        /* PHA */ {
          trace("[CPU] PHA");

          const result: u16 = this.accumulator;
          this.memory.push((result & 0xff) as u8);
          this.cyclesRemaining = 2;
        }
        break;

      case 0x08:
        /* PHP */ {
          trace("[CPU] PHP");

          const result: u16 = this.statusRegister.pack();
          this.memory.push((result & 0xff) as u8);
          this.cyclesRemaining = 2;
        }
        break;

      case 0x68:
        /* PLA */ {
          trace("[CPU] PLA");

          const result = this.memory.pop();
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0x28:
        /* PLP */ {
          trace("[CPU] PLP");

          const result = this.memory.pop();
          this.statusRegister.unpack(result as u8);
          this.cyclesRemaining = 3;
        }
        break;

      case 0x2a:
        /* ROL */ {
          trace("[CPU] ROL");

          const memval: u16 = this.accumulator;
          const result: u16 = (memval << 1) + this.statusRegister.carry;
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x26:
        /* ROL */ {
          trace("[CPU] ROL");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval << 1) + this.statusRegister.carry;
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0x36:
        /* ROL */ {
          trace("[CPU] ROL");

          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval << 1) + this.statusRegister.carry;
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x2e:
        /* ROL */ {
          trace("[CPU] ROL");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval << 1) + this.statusRegister.carry;
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x3e:
        /* ROL */ {
          trace("[CPU] ROL");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval << 1) + this.statusRegister.carry;
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 6;
        }
        break;

      case 0x6a:
        /* ROR */ {
          trace("[CPU] ROR");

          const memval: u16 = this.accumulator;
          const result: u16 = (memval >> 1) + this.statusRegister.carry * 0x80;
          this.statusRegister.carry = u8((memval & 1) == 1);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x66:
        /* ROR */ {
          trace("[CPU] ROR");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval >> 1) + this.statusRegister.carry * 0x80;
          this.statusRegister.carry = u8((memval & 1) == 1);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 4;
        }
        break;

      case 0x76:
        /* ROR */ {
          trace("[CPU] ROR");

          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval >> 1) + this.statusRegister.carry * 0x80;
          this.statusRegister.carry = u8((memval & 1) == 1);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x6e:
        /* ROR */ {
          trace("[CPU] ROR");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval >> 1) + this.statusRegister.carry * 0x80;
          this.statusRegister.carry = u8((memval & 1) == 1);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 5;
        }
        break;

      case 0x7e:
        /* ROR */ {
          trace("[CPU] ROR");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = (memval >> 1) + this.statusRegister.carry * 0x80;
          this.statusRegister.carry = u8((memval & 1) == 1);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 6;
        }
        break;

      case 0xe9:
        /* SBC */ {
          trace("[CPU] SBC");

          const memval: u16 = this.memory.read(this.pc++);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow = u8(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xe5:
        /* SBC */ {
          trace("[CPU] SBC");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow = u8(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 2;
        }
        break;

      case 0xf5:
        /* SBC */ {
          trace("[CPU] SBC");

          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow = u8(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xed:
        /* SBC */ {
          trace("[CPU] SBC");

          const addr = this.memory.readWord(this.pc);
          this.pc += 2;
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow = u8(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3;
        }
        break;

      case 0xfd:
        /* SBC */ {
          trace("[CPU] SBC");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.xRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow = u8(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + u8(pageCrossed);
        }
        break;

      case 0xf9:
        /* SBC */ {
          trace("[CPU] SBC");

          const baseAddr = this.memory.readWord(this.pc);
          this.pc += 2;
          const addr = baseAddr + this.yRegister;
          const pageCrossed =
            Math.floor(baseAddr / 256) != Math.floor(addr / 256);
          const memval = this.memory.read(addr);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow = u8(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 3 + u8(pageCrossed);
        }
        break;

      case 0xe1:
        /* SBC */ {
          trace("[CPU] SBC");

          const indirectAddr =
            (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const addr = this.memory.readWord(indirectAddr);
          const memval: u16 = this.memory.read(addr);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow = u8(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 5;
        }
        break;

      case 0xf1:
        /* SBC */ {
          trace("[CPU] SBC");

          const operand = this.memory.read(this.pc++);
          const addr = this.memory.readWord(operand);
          const pageCrossed =
            Math.floor(addr / 256) != Math.floor((addr + this.yRegister) / 256);
          const memval: u16 = this.memory.read(addr + this.yRegister);
          const result: u16 =
            this.accumulator - memval - (1 - this.statusRegister.carry);
          this.statusRegister.overflow = u8(
            (~(this.accumulator ^ memval) &
              (this.accumulator ^ result) &
              0x80) ===
              0x80
          );
          this.statusRegister.carry = u8(result > 0xff);
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 4 + u8(pageCrossed);
        }
        break;

      case 0x38:
        /* SEC */ {
          trace("[CPU] SEC");

          this.statusRegister.carry = 1;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xf8:
        /* SED */ {
          trace("[CPU] SED");

          this.statusRegister.decimal = 1;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x78:
        /* SEI */ {
          trace("[CPU] SEI");

          this.statusRegister.interrupt = 1;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x85:
        /* STA */ {
          trace("[CPU] STA");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 2;
        }
        break;

      case 0x95:
        /* STA */ {
          trace("[CPU] STA");

          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.accumulator;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 3;
        }
        break;

      case 0x8d:
        /* STA */ {
          trace("[CPU] STA");

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
          trace("[CPU] STA");

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
          trace("[CPU] STA");

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
          trace("[CPU] STA");

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
          trace("[CPU] STA");

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
          trace("[CPU] STX");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.xRegister;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 2;
        }
        break;

      case 0x96:
        /* STX */ {
          trace("[CPU] STX");

          const addr = (this.memory.read(this.pc++) + this.yRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.xRegister;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 3;
        }
        break;

      case 0x8e:
        /* STX */ {
          trace("[CPU] STX");

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
          trace("[CPU] STY");

          const addr = this.memory.read(this.pc++);
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.yRegister;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 2;
        }
        break;

      case 0x94:
        /* STY */ {
          trace("[CPU] STY");

          const addr = (this.memory.read(this.pc++) + this.xRegister) & 0xff;
          const memval: u16 = this.memory.read(addr);
          const result: u16 = this.yRegister;

          this.memory.write(addr, (result & 0xff) as u8);
          this.cyclesRemaining = 3;
        }
        break;

      case 0x8c:
        /* STY */ {
          trace("[CPU] STY");

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
          trace("[CPU] TAX");

          const result: u16 = this.accumulator;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.xRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0xa8:
        /* TAY */ {
          trace("[CPU] TAY");

          const result: u16 = this.accumulator;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.yRegister = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x8a:
        /* TXA */ {
          trace("[CPU] TXA");

          const result: u16 = this.xRegister;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
          this.accumulator = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x9a:
        /* TXS */ {
          trace("[CPU] TXS");

          const result: u16 = this.xRegister;

          this.memory.stackPointer = (result & 0xff) as u8;
          this.cyclesRemaining = 1;
        }
        break;

      case 0x98:
        /* TYA */ {
          trace("[CPU] TYA");

          const result: u16 = this.yRegister;
          this.statusRegister.zero = u8(result === 0);
          this.statusRegister.negative = u8(result !== 0);
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
