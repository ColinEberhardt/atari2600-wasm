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
  const memory = getMemoryBuffer(wasmModule);
  memory[0x0238] = 0x81;
  memory[0x2a] = 0x35;
  memory[0x2b] = 0x02;
  cpu.yRegister = 0x03;
  loadROM("LDA ($2a),Y", wasmModule);
  cpu.tick();
  console.log(`acc=${cpu.accumulator}`);
})();
