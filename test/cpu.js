const fs = require("fs");
const loader = require("@assemblyscript/loader");
const { loadROM, getMemoryBuffer } = require("./common");

const compiled = new WebAssembly.Module(
  fs.readFileSync(__dirname + "/../build/untouched.wasm")
);
let wasmModule, cpu, statusRegister, cpuMemory;

beforeEach(() => {
  wasmModule = loader.instantiateSync(compiled, {
    env: {
      // trace: () => {}
    }
  });
  cpu = wasmModule.CPU.wrap(wasmModule.cpu);
  statusRegister = wasmModule.StatusRegister.wrap(cpu.statusRegister);
  cpuMemory = wasmModule.Memory.wrap(cpu.memory);
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
      expect(cpu.cyclesRemaining).toBe(3);
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
      memory[0xa02] = 10;
      cpu.xRegister = 0x0a;
      cpu.accumulator = 25;
      loadROM("adc $9f8,X", wasmModule);
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

    test("Indexed Indirect", () => {
      // see: https://slark.me/c64-downloads/6502-addressing-modes.pdf
      const memory = getMemoryBuffer(wasmModule);
      memory[0x0104] = 0x81;
      memory[0x3a] = 0x04;
      memory[0x3b] = 0x01;
      cpu.xRegister = 0xe9;
      loadROM("LDA ($51,X)", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(0x81);
    });

    test("Indirect Indexed", () => {
      // see: https://stackoverflow.com/questions/46262435/indirect-y-indexed-addressing-mode-in-mos-6502
      const memory = getMemoryBuffer(wasmModule);
      memory[0x0238] = 0x81;
      memory[0x2A] = 0x35;
      memory[0x2b] = 0x02;
      cpu.yRegister = 0x03;
      loadROM("LDA ($2a),Y", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(0x81);
    });
  });
});

describe("cpu instructions", () => {
  describe("ADC", () => {
    test("basic operation", () => {
      cpu.accumulator = 25;
      loadROM("adc #$04", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(29);
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

  test("AND", () => {
    cpu.accumulator = 0b11000001;
    loadROM("and #$03", wasmModule);
    cpu.tick();
    expect(cpu.accumulator).toBe(0b00000001);
  });

  describe("ASL", () => {
    test("accumulator", () => {
      cpu.accumulator = 0b11000001;
      loadROM("asl", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(0b10000010);
      expect(statusRegister.carry).toBe(1);
    });

    test("memory", () => {
      const memory = getMemoryBuffer(wasmModule);
      memory[0xf56] = 0b01000001;
      loadROM("asl $0f56", wasmModule);
      cpu.tick();
      expect(memory[0xf56]).toBe(0b10000010);
      expect(statusRegister.carry).toBe(0);
    });
  });

  describe("BCC", () => {
    test("branched", () => {
      loadROM(
        `
Loop
    bcc Loop`,
        wasmModule
      );
      statusRegister.carry = 0;
      cpu.tick();
      expect(cpu.pc).toBe(4096);
    });

    test("not branched", () => {
      loadROM(
        `
Loop
    bcc Loop`,
        wasmModule
      );
      statusRegister.carry = 1;
      cpu.tick();
      expect(cpu.pc).toBe(4098);
    });
  });

  test("BCS", () => {
    loadROM(
      `
Loop
    bcs Loop`,
      wasmModule
    );
    statusRegister.carry = 1;
    cpu.tick();
    expect(cpu.pc).toBe(4096);
  });

  test("BEQ", () => {
    loadROM(
      `
Loop
    beq Loop`,
      wasmModule
    );
    statusRegister.zero = 1;
    cpu.tick();
    expect(cpu.pc).toBe(4096);
  });

  describe("BIT", () => {
    test("state #1", () => {
      const memory = getMemoryBuffer(wasmModule);
      memory[0x009] = 0b00010101;
      cpu.accumulator = 0b00010101;
      loadROM(`bit $09`, wasmModule);
      cpu.tick();
      expect(statusRegister.zero).toBe(0);
      expect(statusRegister.overflow).toBe(0);
      expect(statusRegister.negative).toBe(0);
    });

    test("state #2", () => {
      const memory = getMemoryBuffer(wasmModule);
      memory[0x009] = 0b11000000;
      cpu.accumulator = 0b00010101;
      loadROM(`bit $09`, wasmModule);
      cpu.tick();
      expect(statusRegister.zero).toBe(1);
      expect(statusRegister.overflow).toBe(1);
      expect(statusRegister.negative).toBe(1);
    });
  });

  test("BMI", () => {
    loadROM(
      `
Loop
    bmi Loop`,
      wasmModule
    );
    statusRegister.negative = 1;
    cpu.tick();
    expect(cpu.pc).toBe(4096);
  });

  test("BNE", () => {
    loadROM(
      `
Loop
    bne Loop`,
      wasmModule
    );
    statusRegister.zero = 0;
    cpu.tick();
    expect(cpu.pc).toBe(4096);
  });

  test("BPL", () => {
    loadROM(
      `
Loop
    bpl Loop`,
      wasmModule
    );
    statusRegister.negative = 0;
    cpu.tick();
    expect(cpu.pc).toBe(4096);
  });

  test("BVC", () => {
    loadROM(
      `
Loop
    bvc Loop`,
      wasmModule
    );
    statusRegister.negative = 0;
    cpu.tick();
    expect(cpu.pc).toBe(4096);
  });

  test("BVS", () => {
    loadROM(
      `
Loop
    bvs Loop`,
      wasmModule
    );
    statusRegister.overflow = 1;
    cpu.tick();
    expect(cpu.pc).toBe(4096);
  });

  test("CLC", () => {
    statusRegister.carry = 1;
    loadROM(`clc`, wasmModule);
    cpu.tick();
    expect(statusRegister.carry).toBe(0);
  });

  test("CLD", () => {
    statusRegister.decimal = 1;
    loadROM(`cld`, wasmModule);
    cpu.tick();
    expect(statusRegister.decimal).toBe(0);
  });

  test("CLI", () => {
    statusRegister.interrupt = 1;
    loadROM(`cli`, wasmModule);
    cpu.tick();
    expect(statusRegister.interrupt).toBe(0);
  });

  test("CLV", () => {
    statusRegister.overflow = 1;
    loadROM(`clv`, wasmModule);
    cpu.tick();
    expect(statusRegister.overflow).toBe(0);
  });

  describe("CMP", () => {
    test("positive", () => {
      cpu.accumulator = 10;
      loadROM(`cmp #$0a`, wasmModule);
      cpu.tick();
      expect(statusRegister.zero).toBe(1);
      expect(statusRegister.carry).toBe(1);
      expect(statusRegister.negative).toBe(0);
    });

    test("negative", () => {
      cpu.accumulator = 10;
      loadROM(`cmp #$0b`, wasmModule);
      cpu.tick();
      expect(statusRegister.zero).toBe(0);
      expect(statusRegister.carry).toBe(0);
      expect(statusRegister.negative).toBe(1);
    });

    test("carry set", () => {
      cpu.accumulator = 10;
      loadROM(`cmp #$09`, wasmModule);
      cpu.tick();
      expect(statusRegister.zero).toBe(0);
      expect(statusRegister.carry).toBe(1);
      expect(statusRegister.negative).toBe(0);
    });
  });

  test("CPX", () => {
    const memory = getMemoryBuffer(wasmModule);
    memory[0x04] = 10;
    cpu.xRegister = 10;
    loadROM(`cpx $004`, wasmModule);
    cpu.tick();
    expect(statusRegister.zero).toBe(1);
    expect(statusRegister.carry).toBe(1);
    expect(statusRegister.negative).toBe(0);
  });

  test("CPY", () => {
    const memory = getMemoryBuffer(wasmModule);
    memory[0x04] = 10;
    cpu.yRegister = 10;
    loadROM(`cpy $004`, wasmModule);
    cpu.tick();
    expect(statusRegister.zero).toBe(1);
    expect(statusRegister.carry).toBe(1);
    expect(statusRegister.negative).toBe(0);
  });

  test("DEC", () => {
    const memory = getMemoryBuffer(wasmModule);
    memory[0x009] = 10;
    loadROM(`dec $09`, wasmModule);
    cpu.tick();
    expect(memory[0x009]).toBe(9);
  });

  test("DEX", () => {
    cpu.xRegister = 10;
    loadROM(`dex`, wasmModule);
    cpu.tick();
    expect(cpu.xRegister).toBe(9);
  });

  test("DEY", () => {
    cpu.yRegister = 10;
    loadROM(`dey`, wasmModule);
    cpu.tick();
    expect(cpu.yRegister).toBe(9);
  });

  test("EOR", () => {
    const memory = getMemoryBuffer(wasmModule);
    memory[0x04] = 0b00101101;
    cpu.accumulator = 0b00110101;
    loadROM(`eor $004`, wasmModule);
    cpu.tick();
    expect(cpu.accumulator).toBe(0b00011000);
  });

  test("INC", () => {
    const memory = getMemoryBuffer(wasmModule);
    memory[0x009] = 10;
    loadROM(`inc $09`, wasmModule);
    cpu.tick();
    expect(memory[0x009]).toBe(11);
  });

  test("INX", () => {
    cpu.xRegister = 10;
    loadROM(`inx`, wasmModule);
    cpu.tick();
    expect(cpu.xRegister).toBe(11);
  });

  test("INY", () => {
    cpu.yRegister = 10;
    loadROM(`iny`, wasmModule);
    cpu.tick();
    expect(cpu.yRegister).toBe(11);
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

  test("LDA", () => {
    loadROM("lda #03", wasmModule);
    cpu.tick();
    expect(cpu.accumulator).toBe(3);
  });

  test("LDX", () => {
    loadROM("ldx #03", wasmModule);
    cpu.tick();
    expect(cpu.xRegister).toBe(3);
  });

  test("LDY", () => {
    loadROM("ldy #03", wasmModule);
    cpu.tick();
    expect(cpu.yRegister).toBe(3);
  });

  test("LSR", () => {
    cpu.accumulator = 0b10111011;
    loadROM("lsr", wasmModule);
    cpu.tick();
    expect(cpu.accumulator).toBe(0b01011101);
    expect(statusRegister.carry).toBe(1);
  });

  test("ORA", () => {
    cpu.accumulator = 0b11000001;
    loadROM("ora #$03", wasmModule);
    cpu.tick();
    expect(cpu.accumulator).toBe(0b11000011);
  });

  test("PHA", () => {
    cpu.accumulator = 5;
    loadROM("pha", wasmModule);
    cpu.tick();
    const memory = getMemoryBuffer(wasmModule);
    expect(memory[0x1ff]).toBe(5);
  });

  test("PHP", () => {
    statusRegister.carry = 1;
    statusRegister.interrupt = 1;
    loadROM("php", wasmModule);
    cpu.tick();
    const memory = getMemoryBuffer(wasmModule);
    expect(memory[0x1ff]).toBe(0b00000101);
  });


  test("PLA", () => {
    const memory = getMemoryBuffer(wasmModule);
    memory[0x1ff] = 5;
    loadROM("pla", wasmModule);
    cpu.tick();
    expect(cpu.accumulator).toBe(5);
  });

  test("PLP", () => {
    const memory = getMemoryBuffer(wasmModule);
    memory[0x1ff] = 0b00000101;
    loadROM("plp", wasmModule);
    cpu.tick();
    expect(statusRegister.carry).toBe(1);
    expect(statusRegister.interrupt).toBe(1);
  });

  describe("ROL", () => {
    test("no carry", () => {
      cpu.accumulator = 0b11000001;
      loadROM("rol", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(0b10000010);
    });

    test("with carry", () => {
      cpu.accumulator = 0b11000001;
      statusRegister.carry = 1;
      loadROM("rol", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(0b10000011);
    });
  });

  describe("ROR", () => {
    test("no carry", () => {
      cpu.accumulator = 0b11000000;
      loadROM("ror", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(0b01100000);
      expect(statusRegister.carry).toBe(0);
    });

    test("carry", () => {
      cpu.accumulator = 0b11000001;
      statusRegister.carry = 1;
      loadROM("ror", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(0b11100000);
      expect(statusRegister.carry).toBe(1);
    });
  });

  describe("SBC", () => {
    test("no carry", () => {
      cpu.accumulator = 6;
      loadROM("sbc #03", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(2);
    });

    test("carry", () => {
      cpu.accumulator = 6;
      statusRegister.carry = 1;
      loadROM("sbc #03", wasmModule);
      cpu.tick();
      expect(cpu.accumulator).toBe(3);
    });
  });

  test("SEC", () => {
    loadROM(`sec`, wasmModule);
    cpu.tick();
    expect(statusRegister.carry).toBe(1);
  });

  test("SED", () => {
    loadROM(`sed`, wasmModule);
    cpu.tick();
    expect(statusRegister.decimal).toBe(1);
  });

  test("SEI", () => {
    loadROM(`sei`, wasmModule);
    cpu.tick();
    expect(statusRegister.interrupt).toBe(1);
  });

  test("STA", () => {
    const memory = getMemoryBuffer(wasmModule);
    cpu.accumulator = 5;
    loadROM(`sta $09`, wasmModule);
    cpu.tick();
    expect(memory[0x009]).toBe(5);
  });

  test("STX", () => {
    const memory = getMemoryBuffer(wasmModule);
    cpu.xRegister = 5;
    loadROM(`stx $09`, wasmModule);
    cpu.tick();
    expect(memory[0x009]).toBe(5);
  });

  test("STY", () => {
    const memory = getMemoryBuffer(wasmModule);
    cpu.yRegister = 5;
    loadROM(`sty $09`, wasmModule);
    cpu.tick();
    expect(memory[0x009]).toBe(5);
  });

  test("TAX", () => {
    cpu.accumulator = 5;
    loadROM(`tax`, wasmModule);
    cpu.tick();
    expect(cpu.xRegister).toBe(5);
  });

  test("TAY", () => {
    cpu.accumulator = 5;
    loadROM(`tay`, wasmModule);
    cpu.tick();
    expect(cpu.yRegister).toBe(5);
  });

  test("TXA", () => {
    cpu.xRegister = 5;
    loadROM(`txa`, wasmModule);
    cpu.tick();
    expect(cpu.accumulator).toBe(5);
  });

  test("TXS", () => {
    cpu.xRegister = 5;
    loadROM(`txs`, wasmModule);
    cpu.tick();
    expect(cpuMemory.stackPointer).toBe(5);
  });

  test("TYA", () => {
    cpu.yRegister = 5;
    loadROM(`tya`, wasmModule);
    cpu.tick();
    expect(cpu.accumulator).toBe(5);
  });
});

describe("integration tests", () => {
  test.only("clean start macro", () => {
    cpu.xRegister = 5;
    cpu.yRegister = 10;
    cpu.accumulator = 15;
    loadROM("CLEAN_START", wasmModule);
    cpu.tick(5025);
    console.log(cpu.accumulator);
    console.log(cpu.xRegister);
    console.log(cpu.yRegister);
  })

});