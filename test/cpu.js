const fs = require("fs");
const loader = require("@assemblyscript/loader");
const { loadROM, getMemoryBuffer } = require("./common");

const compiled = new WebAssembly.Module(
  fs.readFileSync(__dirname + "/../build/untouched.wasm")
);
let wasmModule, cpu, statusRegister;

beforeEach(() => {
  wasmModule = loader.instantiateSync(compiled, {
    env: {
      trace: () => {}
    }
  });
  cpu = wasmModule.CPU.wrap(wasmModule.cpu);
  statusRegister = wasmModule.StatusRegister.wrap(cpu.statusRegister);
});

describe("General operations", () => {
  test("Tick respects cycles remaining", () => {
    loadROM(
      `
      lda #09
      lda #08	
    `,
      wasmModule
    );

    cpu.tick();
    expect(cpu.accumulator).toBe(9);
    cpu.tick();
    expect(cpu.accumulator).toBe(9);
    cpu.tick();
    expect(cpu.accumulator).toBe(8);
  });
});

describe("status register", () => {
  test("Sets zero flag", () => {
    loadROM(
      `lda #00
      lda #05`,
      wasmModule
    );
    cpu.tick();
    expect(cpu.accumulator).toBe(0);
    expect(statusRegister.zero).toBe(1);
    cpu.tick(2);
    expect(cpu.accumulator).toBe(5);
    expect(statusRegister.zero).toBe(0);
  });

  test("Sets negative flag", () => {
    loadROM(
      `lda #189
      lda #05`,
      wasmModule
    );
    cpu.tick();
    expect(cpu.accumulator).toBe(189);
    expect(statusRegister.negative).toBe(1);
    cpu.tick(2);
    expect(cpu.accumulator).toBe(5);
    expect(statusRegister.negative).toBe(0);
  });

  test("Sets carry", () => {
    loadROM(
      `lda #189 ; 1011 1101
      lsr
      lsr`,
      wasmModule
    );
    cpu.tick(2);
    expect(cpu.accumulator).toBe(189);
    cpu.tick(2);
    expect(cpu.accumulator).toBe(94);
    expect(statusRegister.carry).toBe(1);
    cpu.tick(2);
    expect(cpu.accumulator).toBe(47);
    expect(statusRegister.carry).toBe(0);
    // expect(statusRegister.negative).toBe(0);
  });
});

describe("LDA", () => {
  // http://www.obelisk.me.uk/6502/reference.html#LDA

  test("Immediate", () => {
    loadROM("lda #09", wasmModule);
    cpu.tick();
    expect(cpu.accumulator).toBe(9);
    expect(cpu.cyclesRemaining).toBe(1);
  });
});

describe("LSR", () => {
  // http://www.obelisk.me.uk/6502/reference.html#LSR

  test("Accumulator", () => {
    cpu.accumulator = 45;
    loadROM("lsr", wasmModule);
    cpu.tick();
    expect(cpu.accumulator).toBe(22);
    expect(cpu.cyclesRemaining).toBe(1);
  });
});

describe("STA", () => {
  // http://www.obelisk.me.uk/6502/reference.html#STA

  test("Zero page", () => {
    cpu.accumulator = 9;
    loadROM("sta $08", wasmModule);
    cpu.tick();
    const memory = getMemoryBuffer(wasmModule);
    expect(memory[8]).toBe(9);
    expect(cpu.cyclesRemaining).toBe(2);
  });
});

describe("LDX", () => {
  // http://www.obelisk.me.uk/6502/reference.html#LDX

  test("Immediate", () => {
    loadROM("ldx #03", wasmModule);
    cpu.tick();
    expect(cpu.xRegister).toBe(3);
    expect(cpu.cyclesRemaining).toBe(1);
  });
});

describe("LDY", () => {
  // http://www.obelisk.me.uk/6502/reference.html#LDY

  test("Immediate", () => {
    loadROM("ldy #03", wasmModule);
    cpu.tick();
    expect(cpu.yRegister).toBe(3);
    expect(cpu.cyclesRemaining).toBe(1);
  });
});

describe("INX", () => {
  // http://www.obelisk.me.uk/6502/reference.html#INX

  test("Implied", () => {
    cpu.xRegister = 9;
    loadROM("inx", wasmModule);
    cpu.tick();
    expect(cpu.xRegister).toBe(10);
    expect(cpu.cyclesRemaining).toBe(1);
  });

  test("Implied - overflow", () => {
    cpu.xRegister = 255;
    loadROM("inx", wasmModule);
    cpu.tick();
    expect(cpu.xRegister).toBe(0);
  });
});

describe("INY", () => {
  // http://www.obelisk.me.uk/6502/reference.html#INY

  test("Implied", () => {
    cpu.yRegister = 9;
    loadROM("iny", wasmModule);
    cpu.tick();
    expect(cpu.yRegister).toBe(10);
    expect(cpu.cyclesRemaining).toBe(1);
  });
});

describe("DEY", () => {
  // http://www.obelisk.me.uk/6502/reference.html#DEY

  test("Implied", () => {
    cpu.yRegister = 9;
    loadROM("dey", wasmModule);
    cpu.tick();
    expect(cpu.yRegister).toBe(8);
    expect(cpu.cyclesRemaining).toBe(1);
  });
});

describe("NOP", () => {
  // http://www.obelisk.me.uk/6502/reference.html#NOP

  test("Implied", () => {
    loadROM("nop", wasmModule);
    cpu.tick();
    expect(cpu.cyclesRemaining).toBe(1);
  });
});

describe("STX", () => {
  // http://www.obelisk.me.uk/6502/reference.html#STX

  test("Zero page", () => {
    cpu.xRegister = 9;
    loadROM("stx $08", wasmModule);
    cpu.tick();
    const memory = getMemoryBuffer(wasmModule);
    expect(memory[8]).toBe(9);
    expect(cpu.cyclesRemaining).toBe(2);
  });
});

describe("STY", () => {
  // http://www.obelisk.me.uk/6502/reference.html#STY

  test("Zero page", () => {
    cpu.yRegister = 0x12;
    loadROM("sty $8", wasmModule);
    cpu.tick();
    const memory = getMemoryBuffer(wasmModule);
    expect(memory[8]).toBe(0x12);
    expect(cpu.cyclesRemaining).toBe(2);
  });
});

describe("JMP", () => {
  // http://www.obelisk.me.uk/6502/reference.html#JMP

  test("Absolute", () => {
    loadROM("jmp $07", wasmModule);
    cpu.tick();
    expect(cpu.pc).toBe(7);
  });

  test("Absolute - multi byte", () => {
    loadROM("jmp $07fe", wasmModule);
    cpu.tick();
    expect(cpu.pc).toBe(0x07fe);
  });
});
