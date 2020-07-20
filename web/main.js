const loader = require("@assemblyscript/loader");
const dasm = require("dasm").default;

const code = `
  processor 6502
  include "vcs.h"
  include "macro.h"

  org  $f000

; Now we're going to drive the TV signal properly.
; Assuming NTSC standards, we need the following:
; - 3 scanlines of VSYNC
; - 37 blank lines
; - 192 visible scanlines
; - 30 blank lines

; We'll use the VSYNC register to generate the VSYNC signal,
; and the VBLANK register to force a blank screen above
; and below the visible frame (it'll look letterboxed on
; the emulator, but not on a real TV)

; Let's define a variable to hold the starting color
; at memory address $81
BGColor  equ $81

; The CLEAN_START macro zeroes RAM and registers
Start  CLEAN_START

  lda #$98
  sta COLUPF 

  lda #%10010101
  sta PF0
  sta PF1
  sta PF2
  lda #%00000000
  sta CTRLPF

NextFrame
; Enable VBLANK (disable output)
  lda #2
  sta VBLANK
        
; At the beginning of the frame we set the VSYNC bit...
  lda #2
  sta VSYNC
        
; And hold it on for 3 scanlines...
  REPEAT 3
    sta WSYNC
  REPEND
        
; Now we turn VSYNC off.
  lda #0
  sta VSYNC

; Now we need 37 lines of VBLANK...
  REPEAT 37
    sta WSYNC  ; accessing WSYNC stops the CPU until next scanline
  REPEND

; Re-enable output (disable VBLANK)
  lda #0
  sta VBLANK
        
; 192 scanlines are visible
; We'll draw some rainbows
  ldx #0
  REPEAT 192
    inx
    stx COLUBK
    sta WSYNC
  REPEND

; Enable VBLANK again
  lda #2
  sta VBLANK
        
; 30 lines of overscan to complete the frame
  REPEAT 30
    sta WSYNC
  REPEND
  
; Go back and do another frame
  jmp NextFrame
  
  org $fffc
  .word Start
  .word Start

`;

const WIDTH = 160;
const HEIGHT = 192;

const initiateCanvas = () => {
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  return ctx;
};

const run = async () => {
  const imports = {
    env: {
      abort(_msg, _file, line, column) {
        console.error("abort called at index.ts:" + line + ":" + column);
      }
    }
  };

  const codeAreaElement = document.getElementById("code");
  codeAreaElement.value = code;

  const ctx = initiateCanvas();

  const updateDisplay = (screenBuffer) => {
    const imageData = ctx.createImageData(WIDTH, HEIGHT);
    for (let i = 0; i < WIDTH * HEIGHT * 4; i++) {
      imageData.data[i] = screenBuffer[i];
    }
    ctx.putImageData(imageData, 0, 0);
  };

  const buildAndRun = async () => {
    const module = await loader.instantiateStreaming(
      fetch("/build/untouched.wasm")
    );
    const memory = module.Memory.wrap(module.consoleMemory);
    const tia = module.TIA.wrap(module.tia);
    const buffer = module.__getArrayView(memory.buffer);

    // compile with DASM
    const result = dasm(codeAreaElement.value, {
      format: 3,
      machine: "atari2600"
    });

    // copy RAM to Atari program memory
    result.data.forEach((byte, index) => {
      buffer[index + 0x1000] = byte;
    });

    tia.tick(228 * 262);
    updateDisplay(module.__getArray(tia.display));
  };

  document.getElementById("run").addEventListener("click", buildAndRun);
  buildAndRun();
};

run();
