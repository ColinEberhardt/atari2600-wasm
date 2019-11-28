const loader = require("@assemblyscript/loader");
const dasm = require("dasm").default;

// TODO: work out hwo to run DASM client-side
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

  ; 3 scanlines of VSYNC signal...
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
  ldy #64
  REPEAT 192; scanlines
    inx
    stx COLUBK
    REPEAT 10
      nop
    REPEND
    iny
    sty COLUBK
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

const run = async () => {
  const WIDTH = 160;
  const HEIGHT = 192;

  const imports = {
    env: {
      abort(_msg, _file, line, column) {
        console.error("abort called at index.ts:" + line + ":" + column);
      }
    }
  };

  const module = await loader.instantiate(fetch("../build/untouched.wasm"));
  const memory = module.Memory.wrap(module.consoleMemory);
  const tia = module.TIA.wrap(module.tia);
  const buffer = module.__getArrayView(memory.buffer);
  result.data.forEach((byte, index) => {
    buffer[index + 0x1000] = byte;
  });

  // initialise the canvas
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const updateDisplay = () => {
    const screenBuffer = module.__getArray(tia.display);
    const imageData = ctx.createImageData(WIDTH, HEIGHT);
    for (let i = 0; i < WIDTH * HEIGHT * 4; i++) {
      imageData.data[i] = screenBuffer[i];
    }
    ctx.putImageData(imageData, 0, 0);
  };

  // setInterval(() => {
  // for (let i = 0; i < 228; i++)
  tia.tick(228 * 262);
  updateDisplay();
  // }, 10);
};

run();
