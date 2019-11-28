// The entry file of your WebAssembly module.

/*
Address Range

Function

$0000 - $007F
TIA registers

$0080 - $00FF
RAM

$0200 - $02FF
RIOT registers

$1000 - $1FFF
ROM
*/

//http://www.obelisk.me.uk/6502/reference.html

export default class CPU {
  // TODO: move to i8?
  accumulator: i32;
  xRegister: i32;
  yRegister: i32;
  memory: Array<i32>;
  pc: i32;
  cyclesRemaining: i32;

  constructor() {
    this.memory = new Array<i32>(4096);
  }

  tick(): void {
    if (this.cyclesRemaining > 0) {
      this.cyclesRemaining--;
      return;
    }

    const opcode: i32 = this.memory[this.pc++];

    if (opcode == 0xa9) { // LDA Immediate
      const value: i32 = this.memory[this.pc++];
      this.accumulator = value;
      this.cyclesRemaining = 1;
    }

    if (opcode == 0x85) { // STA Zero page
      const address: i32 = this.memory[this.pc++];
      this.memory[address] = this.accumulator;
      this.cyclesRemaining = 2;
    }
  }
}
