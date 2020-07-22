const fs = require("fs");
const loader = require("@assemblyscript/loader");
const { loadROM, getMemoryBuffer } = require("./common");

/*
Immediate ADC #$44 $69 2 2
Zero Page ADC $44 $65 2 3
Zero Page,X ADC $44,X $75 2 4
Absolute ADC $4400 $6D 3 4
Absolute,X ADC $4400,X $7D 3 4+
Absolute,Y ADC $4400,Y $79 3 4+
Indirect,X ADC ($44,X) $61 2 6
Indirect,Y ADC ($44),Y $71 2 5+
*/

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

describe("DASM features", () => {
  test("Supports labels", () => {
      const memory = getMemoryBuffer(wasmModule);
      cpu.accumulator = 25;
      loadROM(`
  lda LABEL1
LABEL1
  .byte 05`, wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(5);
  })
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
  });

  // test cases from http://www.righto.com/2012/12/the-6502-overflow-flag-explained.html
  describe("overflow", () => {
    const add = (a, b) => {
      cpu.accumulator = a;
      loadROM("adc #$" + b.toString(16), wasmModule);
      cpu.tick();
    };

    test("One", () => {
      add(0x50, 0x10);
      expect(cpu.accumulator).toBe(0x60);
      expect(statusRegister.overflow).toBe(0);
      expect(statusRegister.carry).toBe(0);
    });

    test("Two", () => {
      add(0x50, 0x50);
      expect(cpu.accumulator).toBe(0xa0);
      expect(statusRegister.overflow).toBe(1);
      expect(statusRegister.carry).toBe(0);
    });

    test("Three", () => {
      add(0x50, 0x90);
      expect(cpu.accumulator).toBe(0xe0);
      expect(statusRegister.overflow).toBe(0);
      expect(statusRegister.carry).toBe(0);
    });

    test("Four", () => {
      add(0x50, 0xd0);
      expect(cpu.accumulator).toBe(0x20);
      expect(statusRegister.overflow).toBe(0);
      expect(statusRegister.carry).toBe(1);
    });

    test("Five", () => {
      add(0xd0, 0x10);
      expect(cpu.accumulator).toBe(0xe0);
      expect(statusRegister.overflow).toBe(0);
      expect(statusRegister.carry).toBe(0);
    });

    test("Six", () => {
      add(0xd0, 0x50);
      expect(cpu.accumulator).toBe(0x20);
      expect(statusRegister.overflow).toBe(0);
      expect(statusRegister.carry).toBe(1);
    });

    test("Seven", () => {
      add(0xd0, 0x90);
      expect(cpu.accumulator).toBe(0x60);
      expect(statusRegister.overflow).toBe(1);
      expect(statusRegister.carry).toBe(1);
    });

    test("Eight", () => {
      add(0xd0, 0xd0);
      expect(cpu.accumulator).toBe(0xa0);
      expect(statusRegister.overflow).toBe(0);
      expect(statusRegister.carry).toBe(1);
    });
  });
});

describe("cpu instructions", () => {
  describe("Addressing modes", () => {
    test("Immediate", () => {
      cpu.accumulator = 25;
      loadROM("adc #$04", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(29);
      expect(cpu.cyclesRemaining).toBe(1);
    });

    test("Zero Page", () => {
      const memory = getMemoryBuffer(wasmModule);
      memory[32] = 10;
      cpu.accumulator = 25;
      loadROM("adc $20", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(35);
      expect(cpu.cyclesRemaining).toBe(2);
    });

    test("Zero Page, X", () => {
      const memory = getMemoryBuffer(wasmModule);
      memory[37] = 10;
      cpu.accumulator = 25;
      cpu.xRegister = 5;
      loadROM("adc $20,X", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(35);
      expect(cpu.cyclesRemaining).toBe(3);
    });

    test("Absolute", () => {
      const memory = getMemoryBuffer(wasmModule);
      memory[0xf56] = 10;
      cpu.accumulator = 25;
      loadROM("adc $0f56", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(35);
      expect(cpu.cyclesRemaining).toBe(3);
    });

    test("Absolute, X", () => {
      const memory = getMemoryBuffer(wasmModule);
      memory[0xf5b] = 10;
      cpu.xRegister = 5;
      cpu.accumulator = 25;
      loadROM("adc $0f56,X", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(35);
      expect(cpu.cyclesRemaining).toBe(4);
    });

    test("Absolute, X - Zero Page", () => {
      const memory = getMemoryBuffer(wasmModule);
      memory[0x009] = 10;
      cpu.xRegister = 5;
      cpu.accumulator = 25;
      loadROM("adc $004,X", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(35);
      expect(cpu.cyclesRemaining).toBe(3);
    });

    test("Absolute, X - Page crossed", () => {
      const memory = getMemoryBuffer(wasmModule);
      memory[0xa10] = 10;
      cpu.xRegister = 3;
      cpu.accumulator = 25;
      loadROM("adc $a0d,X", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(35);
      expect(cpu.cyclesRemaining).toBe(4);
    });

    test("Absolute, Y - Zero Page", () => {
      const memory = getMemoryBuffer(wasmModule);
      memory[0x009] = 10;
      cpu.yRegister = 5;
      cpu.accumulator = 25;
      loadROM("adc $004,Y", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(35);
      expect(cpu.cyclesRemaining).toBe(3);
    });
  });

  test("ADC", () => {
    cpu.accumulator = 25;
    loadROM("adc #$04", wasmModule);
    cpu.tick();
    expect(cpu.accumulator).toBe(29);
  });

  test("LDA", () => {
    loadROM("lda #$08", wasmModule);
    cpu.tick();
    expect(cpu.accumulator).toBe(8);
  });

  test("STA", () => {
    cpu.accumulator = 9;
    loadROM("sta $08", wasmModule);
    cpu.tick();
    const memory = getMemoryBuffer(wasmModule);
    expect(memory[8]).toBe(9);
  });

  test("ORA", () => {
    cpu.accumulator = 0b11000001;
    loadROM("ora #$03", wasmModule);
    cpu.tick();
    expect(cpu.accumulator).toBe(0b11000011);
  });

  test("AND", () => {
    cpu.accumulator = 0b11000001;
    loadROM("and #$03", wasmModule);
    cpu.tick();
    expect(cpu.accumulator).toBe(0b00000001);
  });

  test("EOR", () => {
    cpu.accumulator = 0b11000001;
    loadROM("eor #$03", wasmModule);
    cpu.tick();
    expect(cpu.accumulator).toBe(0b11000010);
  });

  test("CMP", () => {
    cpu.accumulator = 5;
    loadROM("cmp #$02", wasmModule);
    cpu.tick();
    expect(statusRegister.carry).toBe(1);
    expect(statusRegister.zero).toBe(0);
    expect(statusRegister.negative).toBe(0);
  });

  test("SBC", () => {
    cpu.accumulator = 5;
    cpu.statusRegister.carry = 0;
    loadROM("sbc #$02", wasmModule);
    cpu.tick();
    expect(cpu.accumulator).toBe(2);
  });
});

describe("legacy tests", () => {
  describe("BNE", () => {
    // http://www.obelisk.me.uk/6502/reference.html#BNE
    test("branching", () => {
      cpu.statusRegister.zero = false;
      loadROM(
        `
    ldy #02
Loop
    dey
    bne Loop`,
        wasmModule
      );
      expect(cpu.pc).toEqual(4096);
      cpu.tick(6);
      expect(cpu.pc).toEqual(4098);
      cpu.tick(4);
      expect(cpu.pc).toEqual(4101);
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
});
