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

	cpu = wasmModule.CPU.wrap(wasmModule.cpu);

	const memBuffer = getMemoryBuffer(wasmModule);

	// memBuffer[0x100] = 10;
	// cpu.xRegister = 100;
	cpu.accumulator = 25;
	loadROM("sta $09", wasmModule);

	cpu.tick();
	console.log(memBuffer[0x09]);
})();
