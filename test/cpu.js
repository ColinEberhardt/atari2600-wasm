const fs = require("fs");
const loader = require("@assemblyscript/loader");
const dasm = require("dasm").default;

const compiled = new WebAssembly.Module(
  fs.readFileSync(__dirname + "/../build/untouched.wasm")
);
let myModule;

const getRegisters = () => {
  const registers = myModule.__getArray(myModule.registers());
  return {
    accumulator: registers[0],
    xRegister: registers[1],
    yRegister: registers[2]
  };
};

const loadROM = sourcecode => {
  // Run with the source
  const result = dasm(`
    processor 6502
    org  $f000
    ${sourcecode}
  `);
  
  // Read the output as a binary (Uint8Array array)
  const ROM = result.data.slice(2);
  const memory = myModule.__getArrayView(myModule.mem());
  ROM.forEach((byte, index) => {
    memory[index] = byte;
  })
}

beforeEach(() => {
  myModule = loader.instantiateSync(compiled, {});
})

describe("General operations", () => {
  test("Tick respects cycles remaining", () => {
    loadROM(`
      lda #$09
      lda #$08	
    `);
    myModule.tick();
    expect(getRegisters().accumulator).toBe(9);
    myModule.tick();
    expect(getRegisters().accumulator).toBe(9);
    myModule.tick();
    expect(getRegisters().accumulator).toBe(8);
  });
});

describe("LDA", () => {
  // http://www.obelisk.me.uk/6502/reference.html#LDA

  test("Immediate", () => {
    loadROM(`
      lda #$09
    `);
    myModule.tick();
    expect(getRegisters().accumulator).toBe(9);
  });
});

describe("STA", () => {
  // http://www.obelisk.me.uk/6502/reference.html#STA

  test("Zero page", () => {
    myModule.setAccumulator(9);
    loadROM(`
      sta $08
    `);
    myModule.tick();
    const memory = myModule.__getArrayView(myModule.mem());
    expect(memory[8]).toBe(9);
  });
});
