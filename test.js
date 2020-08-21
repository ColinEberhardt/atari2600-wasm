test = {
  skip: () => {}
};

const fs = require("fs");
const loader = require("@assemblyscript/loader");
const { loadROM, getMemoryBuffer } = require("./test/common");

(async () => {
  const wasmModule = await loader.instantiateStreaming(
    fs.promises.readFile("./build/untouched.wasm")
  );

  const cpu = wasmModule.CPU.wrap(wasmModule.cpu);
  const tia = wasmModule.TIA.wrap(wasmModule.tia);
  const memBuffer = getMemoryBuffer(wasmModule);

  loadROM(
    `
    sta WSYNC
    lda #08`,
    wasmModule
  );


  for (let i = 0; i < 228; i++) {
    tia.tick();
    console.log(`tick ${i} acc=${cpu.accumulator}`);
  }
})();
