const fs = require("fs");
const loader = require("@assemblyscript/loader");
const dasm = require("dasm").default;

const getRegisters = wasmModule => {
  const registers = wasmModule.__getArray(wasmModule.registers());
  return {
    accumulator: registers[0],
    xRegister: registers[1],
    yRegister: registers[2],
    cyclesRemaining: registers[3],
    pc: registers[4]
  };
};

(async () => {
  const wasmModule = await loader.instantiate(
    fs.promises.readFile("./build/untouched.wasm")
  );

  const result = dasm(
    `
		processor 6502
		include "vcs.h"
		include "macro.h"
	
		SEG
		ORG $F000
	Reset
	StartOfFrame
		; Start of vertical blank processing
		lda #0
		sta VBLANK
		lda #2
		sta VSYNC
	
		; 3 scanlines of VSYNCH signal...
		sta WSYNC
		sta WSYNC
		sta WSYNC
		lda #0
		sta VSYNC
	
		; 37 scanlines of vertical blank...
		REPEAT 37
			sta WSYNC
		REPEND
	
		; 192 scanlines of picture...
		ldx #0
		REPEAT 192; scanlines
			inx
			stx COLUBK
			sta WSYNC
		REPEND
	
		lda #%01000010
		sta VBLANK ; end of screen - enter blanking
	
		; 30 scanlines of overscan...
		REPEAT 30
			sta WSYNC
		REPEND
	
		jmp StartOfFrame
		
		ORG $FFFA
		.word Reset ; NMI
		.word Reset ; RESET
		.word Reset ; IRQ
	
	END
	`,
    { format: 3, machine: "atari2600" }
	);
	
	console.log(result.data.join(","));

  // const memory = wasmModule.__getArrayView(wasmModule.getMemoryBuffer());
  // result.data.forEach((byte, index) => {
  //   memory[index + 0x1000] = byte;
	// });
	
  // for (let i = 0; i < 250; i++) {
  //   wasmModule.tickTia();
  //   console.log(getRegisters(wasmModule).accumulator);
  // }
})();
