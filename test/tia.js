const fs = require("fs");
const loader = require("@assemblyscript/loader");
const { loadROM } = require("./common");

const compiled = new WebAssembly.Module(
  fs.readFileSync(__dirname + "/../build/untouched.wasm")
);
let wasmModule;

beforeEach(() => {
  wasmModule = loader.instantiateSync(compiled, {
    env: {
      trace: () => {}
    }
  });
  cpu = wasmModule.CPU.wrap(wasmModule.cpu);
  tia = wasmModule.TIA.wrap(wasmModule.tia);
});

test("TIA ticks 3 times for each 6502 clock tick", () => {
  loadROM(
    `
    lda #09
    lda #08
  `,
    wasmModule
  );
  // for LDA takes 2 6502 clock cycles, which is 6 TIA cycles
  for (let i = 0; i < 6; i++) {
    tia.tick();
    expect(cpu.accumulator).toBe(9);
  }
  // after 6 ticks, LDA #08 is called
  tia.tick();
  expect(cpu.accumulator).toBe(8);
});

test.only("TIA pauses 6502 when WSYNC is strobed", () => {
  loadROM(
    `
    sta WSYNC
    lda #08
  `,
    wasmModule
  );
  // after WSYNC is strobed, 6502 is paused until 228 TIA clock ticks complete
  for (let i = 0; i < 228; i++) {
    tia.tick();
    expect(cpu.accumulator).toBe(0);
  }
  tia.tick();
  expect(cpu.accumulator).toBe(8);
});

test("Writes COLUBK values to the background", () => {
  loadROM(
    `
    lda #34 ; 0x144484
    sta COLUBK
    REPEAT 40
      sta WSYNC
    REPEND
  `,
    wasmModule
  );

  // tick for the VSYNC / VBLANK
  tia.tick(40 * 228);
  // tick for the horizontal blank
  tia.tick(68);
  // this should be the first clock tick that renders to screen
  tia.tick();

  const display = wasmModule.__getArray(tia.display);
  expect(display[0]).toBe(0x14);
  expect(display[1]).toBe(0x44);
  expect(display[2]).toBe(0x84);
  expect(display[3]).toBe(0xff);
});
