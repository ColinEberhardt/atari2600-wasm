export default class StatusRegister {
  carry: u8;
  overflow: u8;
  negative: u8;
  zero: u8;
  interrupt: u8;
  decimal: u8;
  constructor() {}

  pack(): u8 {
    return this.carry + 
      (this.zero << 1) +
      (this.interrupt << 2) +
      (this.decimal << 3) +
      (0 << 4) + // break command
      (this.overflow << 5) +
      (this.negative << 6);
  }

  unpack(value: u8): void {
    this.carry = (value & 0b00000001) === 0b00000001 ? 1 : 0;
    this.zero = (value & 0b00000010) === 0b00000010 ? 1 : 0;
    this.interrupt = (value & 0b00000100) === 0b00000100 ? 1 : 0;
    this.decimal = (value & 0b00001000) === 0b000010000 ? 1 : 0;
    // break command
    this.overflow = (value & 0b00100000) === 0b00100000 ? 1 : 0;
    this.negative = (value & 0b01000000) === 0b01000000 ? 1 : 0;
  }
}