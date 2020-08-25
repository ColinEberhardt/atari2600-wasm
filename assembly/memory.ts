import TIA from "./tia";

/*
$0000 - $007F TIA registers  ) Zero page
$0080 - $00FF RAM            )

$0100 - $01FF Stack

$0200 - $02FF RIOT registers

$1000 - $1FFF ROM
*/

export default class Memory {
  buffer: Array<u8>;
  tia: TIA;
  stackPointer: u8;

  constructor() {
    this.buffer = new Array<u8>(0x2000); // 13 bits of addressable memory
    this.stackPointer = 0xff;
  }

  write(address: u32, value: u8): void {
    this.tia.memoryWrite(address);
    this.buffer[address] = value;
  }

  read(address: u32): u8 {
    return this.buffer[address];
  }

  readWord(address: u32): u16 {
    return this.buffer[address] + (this.buffer[address + 1] * 0x100) as u16;
  }

  getBuffer(): Array<u8> {
    return this.buffer;
  }

  getROMStartAddress(): u16 {
    return 0x1000;
  }

  push(value: u8): void {
    this.write(this.stackPointer + 0x100, value);
    this.stackPointer++;
  }

  pop(): u8 {
    const value = this.read(this.stackPointer + 0x100);
    this.stackPointer--;
    return value;
  }
}
