import CPU from "./cpu";

const cpu = new CPU();

export function tick(): void {
  cpu.tick();
}

export function registers(): Array<i32> {
  const reg = new Array<i32>(3);
  reg[0] = cpu.accumulator;
  reg[1] = cpu.xRegister;
  reg[2] = cpu.yRegister;
  return reg;
}

export function setAccumulator(value: i32): void {
  cpu.accumulator = value;
}

export function mem(): Array<i32> {
  return cpu.memory;
}
