import TIA from "./tia";

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

export default class Memory {
  buffer: Array<u8>;
  tia: TIA;

  constructor() {
    this.buffer = new Array<u8>(8192); // 13 bits of addressable memory
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
}
