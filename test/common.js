const dasm = require("dasm").default;

const getMemoryBuffer = wasmModule => {
  const memory = wasmModule.Memory.wrap(wasmModule.consoleMemory);
  const buffer = wasmModule.__getArrayView(memory.buffer);
  return buffer;
};

const loadROM = (sourcecode, wasmModule) => {
  // Run with the source
  const result = dasm(
    `
    processor 6502
		include "vcs.h"
		include "macro.h"
    org  $1000
    
    ${sourcecode}
  `,
    { format: 3, machine: "atari2600" }
  );

  const buffer = getMemoryBuffer(wasmModule);
  result.data.forEach((byte, index) => {
    buffer[index + 0x1000] = byte;
  });
};

test.skip("skip", () => {});

console.warn = () => {};

module.exports = {
  loadROM,
  getMemoryBuffer
};
